/**
 * The text pipeline behind "一键整理": split → clean → dedupe → classify → group.
 *
 * Deliberately pure: no DOM, no storage, no clock beyond the `now` argument, so
 * `tidy.test.js` can run the whole thing under `node --test`. The browser entry
 * (`app.js`) only renders what this module returns.
 */

/** Verbs that make a sentence an actionable item when it leads with one. */
const ACTION_VERBS = [
  "写", "改", "发", "查", "确认", "整理", "联系", "准备", "看", "读", "买", "交",
  "回", "约", "订", "跑", "测", "部署", "更新", "删除", "合并", "上传", "下载",
  "复盘", "记录", "预约", "提交", "补", "修", "核", "对", "拉", "推", "拆", "排",
  "问", "找", "统计", "导出", "重写", "替换", "检查", "跟进", "催", "回复", "评估",
];

const ACTION_START_RE = new RegExp(
  `^(${ACTION_VERBS.join("|")}|记得|别忘|待办|需要|明天|后天|今天)`,
);

const QUESTION_START_RE =
  /^(是否|为什么|为啥|怎么|怎样|如何|能不能|要不要|有没有|是不是|可不可以|何时|什么时候|哪|谁|多少|几个)/;

/** Time hints worth surfacing in the checklist, not a date parser. */
const DUE_RE =
  /(大后天|今天|明天|后天|本周|这周|下周|月底|周末|周[一二三四五六日天]|星期[一二三四五六日天]|上午|中午|下午|晚上|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*[/.]\s*\d{1,2})/;

const TAG_RE = /#([\p{L}\p{N}_-]{1,20})/gu;
const SOFT_BREAK_RE = /[，,]+/;

/**
 * Pull `#tag` tokens out of a string. Tags may sit anywhere, including the end
 * of a sentence, so both the fragment and each sentence get scanned.
 */
export function extractTags(input) {
  const tags = [];
  const text = String(input ?? "")
    .replace(TAG_RE, (_match, tag) => {
      if (!tags.includes(tag)) tags.push(tag);
      return " ";
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { text, tags };
}

/** Drop list markers, numbering and checkbox syntax people paste in. */
export function cleanSentence(text) {
  return String(text ?? "")
    .replace(/^[\s\-–—•*·+]+/, "")
    .replace(/^\d+[.、)]\s*/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Split one fragment into checklist-sized pieces. Hard punctuation always
 * breaks; commas only break long sentences, otherwise "买牛奶，顺便取快递"
 * would explode into fragments that read worse than the original. A trailing
 * question mark is kept, because "要不要做置顶小窗？" reads like a question and
 * "要不要做置顶小窗" reads like an order.
 */
export function splitSentences(text) {
  const out = [];
  const parts = String(text ?? "").split(/([。！？!?；;]+|\n+)/);

  // split() with a capture group alternates [content, separator, content, ...].
  for (let index = 0; index < parts.length; index += 2) {
    const chunk = (parts[index] ?? "").trim();
    if (!chunk) continue;
    const separator = parts[index + 1] ?? "";
    const questionMark = /[?？]/.exec(separator)?.[0] ?? "";

    const pieces =
      chunk.length > 24 && SOFT_BREAK_RE.test(chunk)
        ? chunk.split(SOFT_BREAK_RE).map((part) => part.trim()).filter(Boolean)
        : [chunk];

    pieces.forEach((piece, pieceIndex) => {
      const isLast = pieceIndex === pieces.length - 1;
      out.push(questionMark && isLast ? `${piece}${questionMark}` : piece);
    });
  }

  return out;
}

/** Comparison key: punctuation, symbols and case carry no meaning for dedupe. */
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

export function matchDue(text) {
  const match = DUE_RE.exec(String(text ?? ""));
  return match ? match[1] : null;
}

/**
 * Decide what a sentence is. Questions win over verbs ("要不要改首页?" is a
 * question), and short statements without a verb are kept verbatim instead of
 * pretending to be todos.
 */
export function classify(text) {
  const value = String(text ?? "").trim();
  const due = matchDue(value);
  if (/[?？]\s*$/.test(value) || QUESTION_START_RE.test(value)) {
    return { kind: "question", due };
  }
  if (ACTION_START_RE.test(value) || due) {
    return { kind: "action", due };
  }
  if (value.length <= 12) return { kind: "note", due };
  return { kind: "action", due };
}

const KIND_ORDER = { action: 0, question: 1, note: 2 };

/** Group by first tag; untagged items land in the "" bucket rendered last. */
export function groupItems(items) {
  const buckets = new Map();
  for (const item of items) {
    const label = item.tags && item.tags.length ? item.tags[0] : "";
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(item);
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9));
  }
  return [...buckets.entries()]
    .map(([label, list]) => ({ label, items: list }))
    .sort((a, b) => {
      if (!a.label) return 1;
      if (!b.label) return -1;
      return a.label.localeCompare(b.label, "zh-Hans-CN");
    });
}

export function formatStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function pushLine(lines, item) {
  if (item.kind === "note") {
    lines.push(`- ${item.text}`);
    return;
  }
  const due = item.due ? ` · ⏰ ${item.due}` : "";
  lines.push(`- [ ] ${item.text}${due}`);
}

function buildMarkdown(items, stats, now) {
  const lines = [`# 碎片整理 · ${formatStamp(now)}`, ""];
  const tail = [`${stats.fragments} 条碎片`, `${stats.actions} 个行动项`];
  if (stats.questions) tail.push(`${stats.questions} 条待确认`);
  if (stats.notes) tail.push(`${stats.notes} 条原样保留`);
  if (stats.dropped > 0) tail.push(`合并重复 ${stats.dropped} 条`);
  lines.push(`> ${tail.join(" · ")}`, "");

  const groups = groupItems(items);

  const actionable = groups.filter((g) => g.items.some((i) => i.kind === "action"));
  if (actionable.length) {
    lines.push("## 待办清单", "");
    for (const group of actionable) {
      if (group.label) lines.push(`### ${group.label}`, "");
      for (const item of group.items.filter((i) => i.kind === "action")) pushLine(lines, item);
      lines.push("");
    }
  }

  const questions = items.filter((i) => i.kind === "question");
  if (questions.length) {
    lines.push("## 待确认", "");
    for (const item of questions) pushLine(lines, item);
    lines.push("");
  }

  const notes = items.filter((i) => i.kind === "note");
  if (notes.length) {
    lines.push("## 原样保留", "");
    for (const item of notes) pushLine(lines, item);
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/**
 * Turn loose fragments into one checklist.
 *
 * @param {Array<{text: string, done?: boolean, pinned?: boolean, createdAt?: number}>} fragments
 * @param {Date} now
 */
export function tidy(fragments, now = new Date()) {
  const stats = { fragments: 0, items: 0, actions: 0, questions: 0, notes: 0, dropped: 0 };
  const seen = new Set();
  const items = [];

  const source = (Array.isArray(fragments) ? fragments : [])
    .filter((f) => f && !f.done && String(f.text ?? "").trim())
    .sort((a, b) => {
      const pinned = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pinned !== 0) return pinned;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });

  stats.fragments = source.length;

  for (const fragment of source) {
    const base = extractTags(fragment.text);
    for (const raw of splitSentences(base.text)) {
      const sentence = cleanSentence(raw);
      if (!sentence) continue;
      const own = extractTags(sentence);
      // A sentence that is nothing but `#tag` carries no content of its own;
      // its tag already travelled with every other sentence of the fragment.
      const body = own.text;
      if (!body) continue;
      const key = normalize(body);
      if (!key) continue;
      if (seen.has(key)) {
        stats.dropped += 1;
        continue;
      }
      seen.add(key);
      const verdict = classify(body);
      items.push({
        text: body,
        kind: verdict.kind,
        due: verdict.due,
        tags: [...new Set([...base.tags, ...own.tags])],
      });
    }
  }

  stats.items = items.length;
  for (const item of items) {
    if (item.kind === "action") stats.actions += 1;
    else if (item.kind === "question") stats.questions += 1;
    else stats.notes += 1;
  }

  return { items, stats, groups: groupItems(items), markdown: buildMarkdown(items, stats, now) };
}
