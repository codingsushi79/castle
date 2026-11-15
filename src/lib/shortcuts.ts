import { useEffect, useRef } from "react";
import { create } from "zustand";
import { load, save } from "./storage";

export interface ShortcutDef {
  id: string;
  label: string;
  group: string;
  keys: string;
  /** Global shortcuts work even while typing in a text field. */
  global?: boolean;
}

export const SHORTCUTS: ShortcutDef[] = [
  { id: "palette", label: "Command palette", group: "General", keys: "mod+k", global: true },
  { id: "cheatsheet", label: "Keyboard shortcuts", group: "General", keys: "?" },
  { id: "settings", label: "Settings", group: "General", keys: "mod+,", global: true },
  { id: "go.play", label: "Go to Play", group: "Pages", keys: "mod+1", global: true },
  { id: "go.lichess", label: "Go to Lichess", group: "Pages", keys: "mod+2", global: true },
  { id: "go.fics", label: "Go to FICS", group: "Pages", keys: "mod+3", global: true },
  { id: "go.watch", label: "Go to Watch", group: "Pages", keys: "mod+4", global: true },
  { id: "go.matches", label: "Go to Engine Tournaments", group: "Pages", keys: "mod+5", global: true },
  { id: "go.analysis", label: "Go to Analysis", group: "Pages", keys: "mod+6", global: true },
  { id: "go.puzzles", label: "Go to Puzzles", group: "Pages", keys: "mod+7", global: true },
  { id: "go.training", label: "Go to Training", group: "Pages", keys: "mod+8", global: true },
  { id: "go.repertoire", label: "Go to Repertoire", group: "Pages", keys: "mod+9", global: true },
  { id: "go.progress", label: "Go to Progress", group: "Pages", keys: "" },
  { id: "go.library", label: "Go to Library", group: "Pages", keys: "mod+l", global: true },
  { id: "go.accounts", label: "Go to Accounts", group: "Pages", keys: "" },
  { id: "go.engines", label: "Go to Engines", group: "Pages", keys: "mod+e", global: true },
  { id: "tab.new", label: "New analysis tab", group: "Analysis", keys: "mod+t", global: true },
  { id: "tab.close", label: "Close analysis tab", group: "Analysis", keys: "mod+shift+w", global: true },
  { id: "tab.next", label: "Next tab", group: "Analysis", keys: "mod+shift+]", global: true },
  { id: "tab.prev", label: "Previous tab", group: "Analysis", keys: "mod+shift+[", global: true },
  { id: "board.back", label: "Previous move", group: "Board", keys: "arrowleft" },
  { id: "board.forward", label: "Next move", group: "Board", keys: "arrowright" },
  { id: "board.start", label: "First move", group: "Board", keys: "arrowup" },
  { id: "board.end", label: "Last move", group: "Board", keys: "arrowdown" },
  { id: "board.flip", label: "Flip board", group: "Board", keys: "f" },
  { id: "engine.toggle", label: "Start or stop the engine", group: "Analysis", keys: "space" },
  { id: "engine.threat", label: "Show the threat", group: "Analysis", keys: "x" },
  { id: "analysis.split", label: "Toggle split view", group: "Analysis", keys: "mod+\\", global: true },
  { id: "analysis.review", label: "Review game", group: "Analysis", keys: "mod+shift+r", global: true },
  { id: "file.open", label: "Open PGN file", group: "Files", keys: "mod+o", global: true },
  { id: "file.paste", label: "Paste FEN or PGN", group: "Files", keys: "mod+shift+v", global: true },
  { id: "file.copyFen", label: "Copy FEN", group: "Files", keys: "mod+shift+c", global: true },
  { id: "file.copyPgn", label: "Copy PGN", group: "Files", keys: "mod+alt+c", global: true },
  { id: "theme.toggle", label: "Switch light and dark", group: "General", keys: "mod+shift+l", global: true },
];

const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

/** A key combination in a stable written form, e.g. "mod+shift+k". */
const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Minus: "-", Equal: "=", Backquote: "`",
};

/** A key combination in a stable written form, e.g. "mod+shift+k". */
export function comboOf(e: KeyboardEvent): string {
  let key = e.key.toLowerCase();
  if (key === " ") key = "space";
  if (["meta", "control", "alt", "shift", "os"].includes(key)) return "";
  const mod = isMac ? e.metaKey : e.ctrlKey;
  const ctrl = isMac && e.ctrlKey;
  const modded = mod || ctrl || e.altKey;
  // With modifiers held, name the physical key: Option and Shift change the character.
  if (modded || e.shiftKey) {
    if (e.code.startsWith("Key")) key = e.code.slice(3).toLowerCase();
    else if (e.code.startsWith("Digit") && modded) key = e.code.slice(5);
    else if (modded && CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  }
  const parts: string[] = [];
  if (mod) parts.push("mod");
  if (ctrl) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && (modded || key.length > 1 || /^[a-z0-9]$/.test(key))) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

export function prettyCombo(keys: string): string {
  if (!keys) return "—";
  const sym: Record<string, string> = isMac
    ? { mod: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", space: "Space", enter: "↩", escape: "Esc", backspace: "⌫" }
    : { mod: "Ctrl+", shift: "Shift+", alt: "Alt+", ctrl: "Ctrl+", arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓", space: "Space", enter: "Enter", escape: "Esc" };
  return keys.split("+").map((p) => sym[p] ?? (p.length === 1 ? p.toUpperCase() : p)).join(isMac ? "" : "");
}

interface ShortcutState {
  overrides: Record<string, string>;
  setKeys: (id: string, keys: string) => void;
  reset: () => void;
  keysFor: (id: string) => string;
}

export const useShortcuts = create<ShortcutState>((set, get) => ({
  overrides: load("shortcuts", {}),
  setKeys: (id, keys) => {
    // A combination can only belong to one action.
    const overrides = { ...get().overrides };
    for (const d of SHORTCUTS) if (d.id !== id && keys && get().keysFor(d.id) === keys) overrides[d.id] = "";
    overrides[id] = keys;
    save("shortcuts", overrides);
    set({ overrides });
  },
  reset: () => {
    save("shortcuts", {});
    set({ overrides: {} });
  },
  keysFor: (id) => get().overrides[id] ?? SHORTCUTS.find((d) => d.id === id)?.keys ?? "",
}));

type Handler = () => void;
const handlers = new Map<string, Handler[]>();

/** Registers what an action does while the calling component is on screen. Later registrations win. */
export function useAction(id: string, fn: Handler, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const h = () => ref.current();
    handlers.set(id, [...(handlers.get(id) ?? []), h]);
    return () => {
      handlers.set(id, (handlers.get(id) ?? []).filter((x) => x !== h));
    };
  }, [id, enabled]);
}

export function runAction(id: string): boolean {
  const list = handlers.get(id);
  if (!list?.length) return false;
  list[list.length - 1]();
  return true;
}

export const hasAction = (id: string) => !!handlers.get(id)?.length;

let recording: ((combo: string) => void) | undefined;
export function recordNextCombo(fn: ((combo: string) => void) | undefined) {
  recording = fn;
}

/** The single keyboard listener for the whole app. */
export function installShortcutListener() {
  const onKey = (e: KeyboardEvent) => {
    const combo = comboOf(e);
    if (!combo) return;
    if (recording) {
      e.preventDefault();
      const r = recording;
      recording = undefined;
      r(combo === "escape" ? "" : combo);
      return;
    }
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
    const { keysFor } = useShortcuts.getState();
    for (const d of SHORTCUTS) {
      if (keysFor(d.id) !== combo) continue;
      if (typing && !d.global) return;
      if (runAction(d.id)) e.preventDefault();
      return;
    }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
