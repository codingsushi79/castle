import { GameTree } from "./chess";
import { logActivity } from "./activity";
import { call } from "./storage";
import { useApp } from "./store";

export interface GameRow {
  id: number;
  white: string;
  black: string;
  result: string;
  date: string;
  event: string;
  eco: string;
  opening: string;
  white_elo?: number;
  black_elo?: number;
  plies: number;
  folder: string;
  tags: string[];
  variant: string;
}

export interface GameFilter {
  text?: string;
  player?: string;
  color?: string;
  result?: string;
  folder?: string;
  tag?: string;
  eco?: string;
  date_from?: string;
  date_to?: string;
  fen?: string;
  event?: string;
  ids?: number[];
  sort?: string;
  desc?: boolean;
  limit?: number;
  offset?: number;
}

export interface ExplorerMove {
  san: string;
  white: number;
  draws: number;
  black: number;
  rating?: number;
}

export interface PlayerRecord {
  games: number;
  wins: number;
  draws: number;
  losses: number;
}

export interface PlayerStats {
  white: PlayerRecord;
  black: PlayerRecord;
  openings: { name: string; color: string; record: PlayerRecord }[];
}

export const db = {
  query: (filter: GameFilter) => call<{ total: number; rows: GameRow[] }>("db_query", { filter }),
  count: () => call<number>("db_count").catch(() => 0),
  get: (id: number) => call<string>("db_get", { id }),
  remove: async (ids: number[]) => {
    await call("db_delete", { ids });
    useApp.getState().bumpLibrary();
  },
  explorer: (fen: string, player?: string, color?: string) => call<ExplorerMove[]>("db_explorer", { fen, player, color }).catch(() => [] as ExplorerMove[]),
  pattern: (pattern: string, limit = 5000) => call<number[]>("db_pattern", { pattern, limit }),
  players: () => call<[string, number][]>("db_players").catch(() => [] as [string, number][]),
  playerStats: (name: string) => call<PlayerStats>("db_player_stats", { name }),
  shelves: () => call<{ folders: [string, number][]; tags: [string, number][] }>("db_folders").catch(() => ({ folders: [], tags: [] })),
  setFolder: async (ids: number[], folder: string) => {
    await call("db_set_folder", { ids, folder });
    useApp.getState().bumpLibrary();
  },
  setTags: async (ids: number[], add: string[], remove: string[]) => {
    await call("db_set_tags", { ids, add, remove });
    useApp.getState().bumpLibrary();
  },
  duplicates: () => call<{ white: string; black: string; date: string; ids: number[] }[]>("db_duplicates"),
  mergeDuplicates: async () => {
    const n = await call<number>("db_merge_duplicates");
    useApp.getState().bumpLibrary();
    return n;
  },
  exportTo: (filter: GameFilter, path: string) => call<number>("db_export", { filter, path }),
  importText: async (text: string, folder = "", dedupe = true) => {
    const r = await call<{ added: number; skipped: number; first?: number }>("db_import_text", { text, folder, dedupe });
    useApp.getState().bumpLibrary();
    return r;
  },
  importFile: (path: string, folder: string, dedupe: boolean, maxPly: number) => call("db_import", { path, folder, dedupe, maxPly }),
  /** Saves a finished game; quietly does nothing for empty games. */
  saveGame: async (tree: GameTree, folder = "") => {
    if (tree.mainline.length < 2) return;
    logActivity("game");
    await db.importText(tree.toPgn(), folder, true).catch(() => undefined);
  },
  open: async (id: number) => {
    const tree = GameTree.fromPgn(await db.get(id));
    if (tree) useApp.getState().openGame(tree);
  },
};
