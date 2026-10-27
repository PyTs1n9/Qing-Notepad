/**
 * Command registry shared by the palette and by the install-time conflict check.
 *
 * Host commands are built with the actions `App` owns (switching views) instead
 * of importing React state, so this module stays a plain function and the
 * conflict check can use `BUILTIN_COMMAND_IDS` without pulling in the UI.
 */
import type { ViewType } from "@/types";
import type { LangType } from "@/stores/settingsStore";
import { t } from "@/utils/i18n";
import type { InstalledPlugin } from "./types";

export interface HostCommandActions {
  setView: (view: ViewType) => void;
  newNote: () => void;
  openSettings: () => void;
  toggleAi: () => void;
}

export interface CommandItem {
  id: string;
  title: string;
  category: string;
  /** `host` commands are always available; `plugin` ones need a live runner. */
  source: "host" | "plugin";
  plugin?: InstalledPlugin;
  run: () => void | Promise<void>;
}

/**
 * Namespaced under `qing.` so they can never collide with a plugin command:
 * plugin ids must be reverse-domain and therefore contain a dot after the first
 * segment, and `qing.` is reserved for the host.
 */
export const BUILTIN_COMMAND_IDS = [
  "qing.view.note",
  "qing.view.todo",
  "qing.view.canvas",
  "qing.view.workspace",
  "qing.view.plugins",
  "qing.note.new",
  "qing.settings.open",
  "qing.ai.toggle",
] as const;

export function buildHostCommands(actions: HostCommandActions, lang: LangType): CommandItem[] {
  const view = (id: string, title: string, target: ViewType): CommandItem => ({
    id,
    title,
    category: t(lang, "commandCategoryView"),
    source: "host",
    run: () => actions.setView(target),
  });

  return [
    view("qing.view.note", t(lang, "notepad"), "note"),
    view("qing.view.todo", t(lang, "todo"), "todo"),
    view("qing.view.canvas", t(lang, "canvas"), "canvas"),
    view("qing.view.workspace", t(lang, "workspace"), "workspace"),
    view("qing.view.plugins", t(lang, "pluginsTitle"), "plugins"),
    {
      id: "qing.note.new",
      title: t(lang, "commandNewNote"),
      category: t(lang, "commandCategoryNote"),
      source: "host",
      run: () => actions.newNote(),
    },
    {
      id: "qing.settings.open",
      title: t(lang, "commandOpenSettings"),
      category: t(lang, "commandCategoryApp"),
      source: "host",
      run: () => actions.openSettings(),
    },
    {
      id: "qing.ai.toggle",
      title: t(lang, "commandToggleAi"),
      category: t(lang, "commandCategoryApp"),
      source: "host",
      run: () => actions.toggleAi(),
    },
  ];
}

/**
 * Subsequence match: `wrd` finds "Word count". Any hit scores, but a prefix or a
 * word-start match outranks a mid-word one so typing the first letters of the
 * title still lands first.
 */
function fuzzyScore(query: string, target: string): number {
  if (!query) return 1;
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();

  if (haystack.startsWith(needle)) return 100 - haystack.length * 0.01;

  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const char of needle) {
    const index = haystack.indexOf(char, cursor);
    if (index < 0) return 0;
    const atWordStart = index === 0 || /[\s._\-:/]/.test(haystack[index - 1]);
    score += atWordStart ? 8 : 2;
    streak = index === cursor ? streak + 1 : 0;
    score += Math.min(streak, 3);
    cursor = index + 1;
  }
  return score;
}

export function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const trimmed = query.trim();
  if (!trimmed) return commands;
  return commands
    .map((command) => ({
      command,
      score: Math.max(
        fuzzyScore(trimmed, command.title),
        fuzzyScore(trimmed, command.id) * 0.6,
        fuzzyScore(trimmed, command.category) * 0.4,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.command);
}
