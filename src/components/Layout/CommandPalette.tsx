import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, Search } from "lucide-react";
import type { ViewType } from "@/types";
import { usePluginStore } from "@/plugin/store";
import {
  buildHostCommands,
  filterCommands,
  type CommandItem,
  type HostCommandActions,
} from "@/plugin/commands";
import { executePluginCommand } from "@/plugin/headless";
import { manifestCommands, type InstalledPlugin } from "@/plugin/types";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToastStore } from "@/stores/toastStore";
import { t, tWithParams } from "@/utils/i18n";

interface CommandPaletteProps {
  onViewChange: (view: ViewType) => void;
  onNewNote: () => void;
  onOpenSettings: () => void;
  onToggleAi: () => void;
}

/**
 * `Ctrl+Shift+P`, registered as a window-scoped keydown.
 *
 * Global shortcuts go through `plugin-global-shortcut`, which is system-wide:
 * taking this combination there would steal it from every other application on
 * the machine (the same reasoning as `Ctrl+W` in `App.tsx`).
 *
 * Plugin commands are built from the installed manifests, so a disabled plugin
 * simply has no rows — its worker is never started for the palette.
 */
const CommandPalette: React.FC<CommandPaletteProps> = ({
  onViewChange,
  onNewNote,
  onOpenSettings,
  onToggleAi,
}) => {
  const lang = useSettingsStore((state) => state.lang);
  const pluginsDisabled = useSettingsStore((state) => state.pluginsDisabled);
  const installed = usePluginStore((state) => state.installed);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "p" && event.code !== "KeyP") return;
      if (event.repeat || event.isComposing) return;
      event.preventDefault();
      setOpen((current) => {
        if (current) return false;
        setQuery("");
        setActiveIndex(0);
        return true;
      });
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const actions: HostCommandActions = useMemo(
    () => ({
      setView: (view) => {
        onViewChange(view);
        close();
      },
      newNote: () => {
        onNewNote();
        close();
      },
      openSettings: () => {
        onOpenSettings();
        close();
      },
      toggleAi: () => {
        onToggleAi();
        close();
      },
    }),
    [close, onNewNote, onOpenSettings, onToggleAi, onViewChange],
  );

  const hostCommands = useMemo(() => buildHostCommands(actions, lang), [actions, lang]);

  const pluginCommands = useMemo<CommandItem[]>(() => {
    if (pluginsDisabled) return [];
    const rows: CommandItem[] = [];
    for (const plugin of installed as InstalledPlugin[]) {
      if (!plugin.enabled || !plugin.manifest) continue;
      for (const command of manifestCommands(plugin.manifest)) {
        rows.push({
          id: command.id,
          title: command.title,
          category: command.category?.trim() || plugin.manifest.name,
          source: "plugin",
          plugin,
          run: () => undefined,
        });
      }
    }
    return rows;
  }, [installed, pluginsDisabled]);

  const results = useMemo(
    () => filterCommands([...hostCommands, ...pluginCommands], query),
    [hostCommands, pluginCommands, query],
  );

  useEffect(() => {
    setActiveIndex((current) => {
      if (results.length === 0) return 0;
      return Math.min(current, results.length - 1);
    });
  }, [results.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const run = useCallback(
    async (command: CommandItem | undefined) => {
      if (!command) return;
      if (command.source === "host") {
        await command.run();
        return;
      }
      const plugin = command.plugin;
      close();
      if (!plugin) return;
      // Activation is lazy by construction: the worker starts on the first
      // command that needs it, never at boot unless the plugin declares
      // `onStartup` (see `activateStartupPlugins`).
      const result = await executePluginCommand(plugin, command.id);
      if (!result.ok) {
        useToastStore.getState().push(
          tWithParams(lang, "pluginCommandFailed", { code: result.code ?? "E_INTERNAL" }),
          "danger",
        );
      }
    },
    [close, lang],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]">
      <div className="absolute inset-0 bg-black/30" onClick={close} />
      <section
        role="dialog"
        aria-modal="true"
        aria-label={t(lang, "commandPaletteTitle")}
        className="command-palette isolate surface-glass surface-glass--dialog relative flex w-[min(560px,100%)] flex-col overflow-hidden rounded-xl border border-border bg-bg-primary shadow-2xl"
      >
        <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border px-3">
          <Search size={14} className="flex-shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((index) =>
                  results.length === 0 ? 0 : (index - 1 + results.length) % results.length,
                );
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void run(results[activeIndex]);
              }
            }}
            placeholder={t(lang, "commandPalettePlaceholder")}
            aria-label={t(lang, "commandPaletteTitle")}
            className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-muted"
          />
          <kbd className="flex-shrink-0 rounded border border-border px-1 py-0.5 text-[10px] text-text-muted">
            Esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] min-h-0 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-2 py-3 text-center text-[11px] text-text-muted">
              {t(lang, "commandPaletteEmpty")}
            </p>
          ) : (
            results.map((command, index) => {
              const active = index === activeIndex;
              return (
                <button
                  key={`${command.source}:${command.id}`}
                  type="button"
                  data-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => void run(command)}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors ${
                    active ? "bg-accent-light/70" : "hover:bg-bg-hover"
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-text-primary">
                    {command.title}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-text-muted">{command.category}</span>
                  {command.source === "plugin" && (
                    <span className="flex-shrink-0 rounded bg-bg-secondary px-1 py-0.5 text-[9px] uppercase tracking-wide text-text-muted">
                      {t(lang, "commandCategoryPlugin")}
                    </span>
                  )}
                  {active && <CornerDownLeft size={11} className="flex-shrink-0 text-text-muted" />}
                </button>
              );
            })
          )}
        </div>

        <div className="flex-shrink-0 border-t border-border px-3 py-1.5 text-[10px] text-text-muted">
          {t(lang, "commandPaletteHint")}
        </div>
      </section>
    </div>
  );
};

export default CommandPalette;
