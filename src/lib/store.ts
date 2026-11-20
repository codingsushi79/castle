import { useSyncExternalStore } from "react";
import { create } from "zustand";
import { GameTree } from "./chess";
import { load, save } from "./storage";

export type Page =
  | "play" | "online" | "lichess" | "fics" | "watch" | "matches" | "analysis" | "puzzles" | "training"
  | "repertoire" | "progress" | "library" | "accounts" | "engines" | "settings" | "studies" | "coaches" | "scan";

export interface Settings {
  boardTheme: string;
  pieceSet: string;
  coords: boolean;
  dests: boolean;
  sound: boolean;
  perspective: boolean;
  blindfold: boolean;
  threads: number;
  hash: number;
  accent: string;
  colorScheme: "dark" | "light" | "auto";
  customLight: string;
  customDark: string;
}

const defaults: Settings = {
  boardTheme: "walnut",
  pieceSet: "cburnett",
  coords: true,
  dests: true,
  sound: true,
  perspective: false,
  blindfold: false,
  threads: Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
  hash: 256,
  accent: "teal",
  colorScheme: "dark",
  customLight: "#eae0c8",
  customDark: "#7d945d",
};

export interface Tab {
  id: number;
  tree: GameTree;
}

interface AppState {
  page: Page;
  settings: Settings;
  tabs: Tab[];
  active: number;
  status: string;
  libraryRevision: number;
  /** A request passed between pages, such as "open the library filtered to this position". */
  intent?: { kind: string; payload?: unknown };
  go: (page: Page, intent?: AppState["intent"]) => void;
  takeIntent: (kind: string) => unknown;
  set: (patch: Partial<Settings>) => void;
  newTab: (tree?: GameTree) => void;
  closeTab: (id: number) => void;
  selectTab: (id: number) => void;
  openGame: (tree: GameTree) => void;
  setStatus: (text: string) => void;
  bumpLibrary: () => void;
}

const first = new GameTree();

export const useApp = create<AppState>((set, get) => ({
  page: load<Page>("page", "play"),
  settings: { ...defaults, ...load<Partial<Settings>>("settings", {}) },
  tabs: [{ id: first.id, tree: first }],
  active: first.id,
  status: "Ready",
  libraryRevision: 0,
  go: (page, intent) => {
    save("page", page);
    set({ page, intent });
  },
  takeIntent: (kind) => {
    const i = get().intent;
    if (i?.kind !== kind) return undefined;
    set({ intent: undefined });
    return i.payload ?? true;
  },
  set: (patch) => {
    const settings = { ...get().settings, ...patch };
    save("settings", settings);
    set({ settings });
  },
  newTab: (tree) => {
    const t = tree ?? new GameTree();
    set({ tabs: [...get().tabs, { id: t.id, tree: t }], active: t.id });
  },
  closeTab: (id) => {
    let tabs = get().tabs.filter((t) => t.id !== id);
    if (!tabs.length) {
      const t = new GameTree();
      tabs = [{ id: t.id, tree: t }];
    }
    const active = get().active === id ? tabs[tabs.length - 1].id : get().active;
    set({ tabs, active });
  },
  selectTab: (id) => set({ active: id }),
  /** Opens a game in Analysis, reusing the current tab when it is an untouched board. */
  openGame: (tree) => {
    const { tabs, active } = get();
    const current = tabs.find((t) => t.id === active)?.tree;
    tree.toStart();
    if (current && !current.root.children.length && current.isStandardStart) {
      set({ tabs: tabs.map((t) => (t.id === active ? { id: tree.id, tree } : t)), active: tree.id });
    } else {
      set({ tabs: [...tabs, { id: tree.id, tree }], active: tree.id });
    }
    get().go("analysis");
  },
  setStatus: (status) => set({ status }),
  bumpLibrary: () => set({ libraryRevision: get().libraryRevision + 1 }),
}));

export const activeTree = () => {
  const s = useApp.getState();
  return (s.tabs.find((t) => t.id === s.active) ?? s.tabs[0]).tree;
};

/** Re-renders the calling component whenever the game tree changes. */
export function useTree(tree: GameTree): number {
  return useSyncExternalStore(tree.subscribe, () => tree.revision);
}

export const BOARD_THEMES: Record<string, { light: string; dark: string }> = {
  walnut: { light: "#f0d9b5", dark: "#b58863" },
  moss: { light: "#eeeed2", dark: "#769656" },
  ocean: { light: "#dee3e6", dark: "#8ca2ad" },
  slate: { light: "#d1d4d9", dark: "#787d8a" },
  rose: { light: "#f5e6e0", dark: "#bd7d82" },
  midnight: { light: "#9aa5b8", dark: "#4b5870" },
  tournament: { light: "#e9edcc", dark: "#3d7a4c" },
  sand: { light: "#e8d0aa", dark: "#a67c52" },
  ice: { light: "#e8f1f8", dark: "#7fa6c9" },
  ink: { light: "#c8c8c8", dark: "#5a5a5a" },
};

/** The square colours for a theme name, including the user's own colours. */
export function boardColors(name: string, s: Settings = useApp.getState().settings) {
  if (name === "custom") return { light: s.customLight, dark: s.customDark };
  return BOARD_THEMES[name] ?? BOARD_THEMES.walnut;
}

export const PIECE_SETS = ["cburnett", "merida", "alpha", "staunty", "maestro", "tatiana", "pixel", "letter"];
