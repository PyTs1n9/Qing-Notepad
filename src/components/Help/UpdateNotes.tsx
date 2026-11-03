import { useEffect, useState } from "react";
import { renderMarkdown } from "@/utils/markdown";

interface UpdateNotesProps {
  notes: string | null;
  className?: string;
}

/**
 * 清单里的发行说明（`UPDATE.md` 的正文）。
 *
 * 走 `renderMarkdown` —— 与公告正文同一条渲染路径，项目的信任边界在那里。清单来自
 * 网络，所以不在这里做任何字符串拼接。
 *
 * 渲染是异步的；等待期间画三条骨架，而不是先显示原始 Markdown 再重排。
 */
export default function UpdateNotes({ notes, className = "" }: UpdateNotesProps) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    if (!notes) {
      setHtml("");
      return;
    }
    let cancelled = false;
    void renderMarkdown(notes)
      .then((rendered) => {
        if (!cancelled) setHtml(rendered);
      })
      .catch((cause) => {
        // 渲染失败不影响"有新版本"这件事本身：正文留空，按钮照常可用。
        console.warn("Failed to render update notes:", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [notes]);

  if (!notes) return null;

  if (!html) {
    return (
      <div className={`space-y-1.5 ${className}`} aria-hidden="true">
        <div className="h-3 w-3/4 animate-pulse rounded bg-bg-active/60" />
        <div className="h-3 w-full animate-pulse rounded bg-bg-active/60" />
        <div className="h-3 w-2/3 animate-pulse rounded bg-bg-active/60" />
      </div>
    );
  }

  return (
    <div
      className={`compact-markdown markdown-preview text-text-secondary
        [&_a]:text-accent-text [&_a]:underline
        [&_code]:rounded [&_code]:bg-bg-secondary [&_code]:px-1 [&_code]:py-0.5
        [&_strong]:font-semibold [&_strong]:text-text-primary ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
