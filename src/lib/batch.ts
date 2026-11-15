import { create } from "zustand";
import { GameTree } from "./chess";
import { db } from "./db";
import { launch, resolveEngine } from "./engines";
import { logActivity } from "./activity";
import { notify } from "./notify";
import { reviewGame, slipsOf, summarise } from "./review";
import { call, load, save } from "./storage";
import { useApp } from "./store";
import { Engine } from "./uci";

/** What a background review found in one game, kept for the trend charts. */
export interface ReviewRecord {
  id: number;
  white: string;
  black: string;
  date: string;
  result: string;
  accuracy: { white?: number; black?: number };
  blunders: { white: number; black: number };
  mistakes: { white: number; black: number };
  kinds: { white: Record<string, number>; black: Record<string, number> };
  phases: { white: Record<string, number>; black: Record<string, number> };
  reviewed: number;
}

export const reviewRecords = () => load<Record<string, ReviewRecord>>("batchReviews", {});

interface BatchState {
  queue: number[];
  done: number;
  total: number;
  running: boolean;
  current?: string;
  moveTimeMs: number;
  start: (ids: number[], moveTimeMs?: number) => void;
  stop: () => void;
}

let engine: Engine | undefined;
let token = 0;

/** Reviews many library games one after another in the background. */
export const useBatch = create<BatchState>((set, get) => {
  const run = async (t: number) => {
    const entry = resolveEngine();
    if (!entry) return set({ running: false });
    try {
      engine ??= await launch(entry);
    } catch {
      return set({ running: false });
    }
    while (t === token && get().queue.length) {
      const [id, ...rest] = get().queue;
      set({ queue: rest });
      try {
        const pgn = await db.get(id);
        const tree = GameTree.fromPgn(pgn);
        if (!tree || tree.rules !== "chess" || tree.mainline.length < 4) throw new Error("skip");
        set({ current: `${tree.tag("White", "?")} – ${tree.tag("Black", "?")}` });
        const ok = await reviewGame(tree, engine!, get().moveTimeMs, () => {}, () => t !== token);
        if (!ok) break;
        const summary = summarise(tree);
        if (summary) {
          const slips = slipsOf(tree);
          const count = (c: "white" | "black", key: "kind" | "phase") => {
            const out: Record<string, number> = {};
            slips.filter((s) => s.mover === c).forEach((s) => (out[s[key]] = (out[s[key]] ?? 0) + 1));
            return out;
          };
          const records = reviewRecords();
          records[id] = {
            id, white: tree.tag("White"), black: tree.tag("Black"), date: tree.tag("Date"), result: tree.result,
            accuracy: summary.accuracy, blunders: summary.blunders, mistakes: summary.mistakes,
            kinds: { white: count("white", "kind"), black: count("black", "kind") },
            phases: { white: count("white", "phase"), black: count("black", "phase") },
            reviewed: Date.now(),
          };
          save("batchReviews", records);
          // Keep the evaluations and move marks in the stored game.
          await call("db_update_pgn", { id, pgn: tree.toPgn() }).catch(() => {});
          logActivity("review", true);
        }
      } catch {
        /* skip games that cannot be reviewed */
      }
      set({ done: get().done + 1 });
    }
    if (t !== token) return;
    engine?.quit();
    engine = undefined;
    const done = get().done;
    set({ running: false, current: undefined });
    useApp.getState().bumpLibrary();
    notify("Batch review finished", `${done} game${done === 1 ? "" : "s"} reviewed.`);
    useApp.getState().setStatus(`Reviewed ${done} games`);
  };

  return {
    queue: [],
    done: 0,
    total: 0,
    running: false,
    moveTimeMs: load("batchMoveTime", 250),
    start: (ids, moveTimeMs) => {
      if (moveTimeMs) {
        save("batchMoveTime", moveTimeMs);
        set({ moveTimeMs });
      }
      if (get().running) {
        const fresh = ids.filter((id) => !get().queue.includes(id));
        set({ queue: [...get().queue, ...fresh], total: get().total + fresh.length });
        return;
      }
      const t = ++token;
      set({ queue: ids, done: 0, total: ids.length, running: true });
      run(t);
    },
    stop: () => {
      token++;
      engine?.quit();
      engine = undefined;
      set({ running: false, queue: [], current: undefined });
    },
  };
});
