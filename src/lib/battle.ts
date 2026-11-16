import { makeSan } from "chessops/san";
import type { Move } from "chessops/types";
import { create } from "zustand";
import { Color, fenOf, moveFromUci, positionOf, turnOf, uciOf } from "./chess";
import { api, onlineToken, useOnline } from "./online";
import { Puzzle, usePuzzles } from "./puzzles";
import { Sound } from "./sound";

/**
 * Puzzle battles: two players race through the same puzzles for a few minutes.
 * The host brings the puzzles (from Castle's own set), the server keeps both
 * scores and the clock, and three misses end a player's run early.
 */
export interface BattlePuzzle { id: string; fen: string; moves: string[]; rating: number }
interface BattleSide { name: string | null; guest: string | null; score: number; strikes: number }
export interface BattleView {
  id: string; code: string; minutes: number; puzzles: BattlePuzzle[];
  startedAt: number | null; endsAt: number | null; now: number;
  status: "waiting" | "countdown" | "running" | "finished";
  a: BattleSide; b: BattleSide;
}

interface State {
  view?: BattleView;
  side?: "a" | "b";
  key?: string;
  /** Server clock minus this computer's, for the countdown. */
  offset: number;
  index: number;
  fen: string;
  lastMove?: [string, string];
  userColor: Color;
  /** Whether the board takes a move right now. */
  ready: boolean;
  score: number;
  strikes: number;
  flash?: "right" | "wrong";
  error?: string;
  create: (minutes: number, isPublic: boolean) => Promise<void>;
  join: (code: string) => Promise<void>;
  leave: () => void;
  attempt: (move: Move) => void;
}

let poll: ReturnType<typeof setInterval> | undefined;
let step = 0;
let generation = 0;

/** Puzzles from easy to hard, about 20 rating points apart. */
function pickPuzzles(all: Puzzle[], count = 100): BattlePuzzle[] {
  const used = new Set<string>();
  const out: BattlePuzzle[] = [];
  for (let i = 0; i < count; i++) {
    const target = 700 + i * 20;
    const pool = all.filter((p) => !used.has(p.id) && p.moves.length <= 8 && Math.abs(p.rating - target) <= 100);
    const p = pool[Math.floor(Math.random() * pool.length)];
    if (!p) continue;
    used.add(p.id);
    out.push({ id: p.id, fen: p.fen, moves: p.moves, rating: p.rating });
  }
  return out;
}

export const useBattle = create<State>((set, get) => {
  const report = () => {
    const { view, key, score, strikes } = get();
    if (view && key) api<BattleView>("battle/progress", { id: view.id, key, score, strikes }).then((v) => set({ view: v })).catch(() => {});
  };

  const begin = (index: number) => {
    const p = get().view?.puzzles[index];
    const token = ++generation;
    step = 0;
    if (!p || get().strikes >= 3) return set({ ready: false, index });
    set({ index, fen: p.fen, lastMove: undefined, userColor: turnOf(p.fen) === "white" ? "black" : "white", ready: false });
    setTimeout(() => token === generation && reply(), 250);
  };

  /** Plays the puzzle's own next move (the opponent's), then hands the board back. */
  const reply = () => {
    const p = get().view?.puzzles[get().index];
    if (!p || step >= p.moves.length) return;
    const pos = positionOf(get().fen).clone();
    const m = moveFromUci(pos, p.moves[step]);
    if (!m) return begin(get().index + 1);
    const uci = uciOf(pos, m, false);
    pos.play(m);
    step++;
    Sound.forSan(makeSan(positionOf(get().fen), m));
    set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], ready: running() });
  };

  const running = () => {
    const v = get().view;
    return !!v && v.status === "running" && get().strikes < 3;
  };

  const refresh = async () => {
    const v = get().view;
    if (!v) return;
    const next = await api<BattleView>(`battle?id=${encodeURIComponent(v.id)}`).catch(() => undefined);
    if (!next || get().view?.id !== v.id) return;
    const offset = next.now - Date.now();
    // The countdown runs on this computer's clock so the race starts on time.
    const started = v.status !== "running" && next.status === "running";
    set({ view: next, offset });
    if (started) { Sound.end(); begin(0); }
    if (next.status === "finished") {
      if (v.status !== "finished") Sound.end();
      set({ ready: false });
      clearInterval(poll);
    }
  };

  const watch = () => {
    clearInterval(poll);
    refresh();
    poll = setInterval(refresh, 1000);
  };

  const seat = async (r: { id: string; key: string; side: "a" | "b" }) => {
    const view = await api<BattleView>(`battle?id=${encodeURIComponent(r.id)}`);
    generation++;
    set({ view, side: r.side, key: r.key, offset: view.now - Date.now(), index: 0, score: 0, strikes: 0, ready: false, error: undefined, fen: view.puzzles[0]?.fen ?? "8/8/8/8/8/8/8/8 w - - 0 1", lastMove: undefined });
    watch();
  };

  const ensureOnline = async () => {
    const o = useOnline.getState();
    if (!o.ready) await o.start();
    if (!useOnline.getState().ready) throw new Error(useOnline.getState().error ?? "Castle Online is not reachable.");
  };

  return {
    offset: 0,
    index: 0,
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    userColor: "white",
    ready: false,
    score: 0,
    strikes: 0,
    create: async (minutes, isPublic) => {
      await ensureOnline();
      const puzzles = usePuzzles.getState();
      if (!puzzles.loaded) await puzzles.load();
      const list = pickPuzzles(usePuzzles.getState().all);
      if (list.length < 10) throw new Error("Castle's puzzles have not loaded yet.");
      const r = await api<{ id: string; key: string; side: "a" }>("battle", { token: onlineToken(), name: useOnline.getState().name, minutes, puzzles: list, public: isPublic });
      await seat(r);
    },
    join: async (code) => {
      await ensureOnline();
      const r = await api<{ id: string; key: string; side: "b" }>("battle/join", { token: onlineToken(), name: useOnline.getState().name, code });
      await seat(r);
    },
    leave: () => {
      const { view, key } = get();
      clearInterval(poll);
      generation++;
      if (view && key && view.status === "waiting") api("battle/cancel", { id: view.id, key }).catch(() => {});
      set({ view: undefined, side: undefined, key: undefined, ready: false });
    },
    attempt: (move) => {
      const s = get();
      const p = s.view?.puzzles[s.index];
      if (!p || !s.ready || !running()) return;
      const pos = positionOf(s.fen).clone();
      const uci = uciOf(pos, move, false);
      const expected = p.moves[step];
      const played = pos.clone();
      played.play(move);
      // Any mate counts, even when the puzzle had another in mind.
      if (uci === expected || played.isCheckmate()) {
        Sound.forSan(makeSan(pos, move));
        step++;
        set({ fen: fenOf(played), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], ready: false });
        if (step >= p.moves.length || played.isCheckmate()) {
          Sound.success();
          set({ score: s.score + 1, flash: "right" });
          report();
          const token = generation;
          setTimeout(() => { if (token === generation) { set({ flash: undefined }); begin(s.index + 1); } }, 300);
        } else {
          const token = generation;
          setTimeout(() => token === generation && reply(), 250);
        }
      } else {
        Sound.error();
        set({ strikes: s.strikes + 1, flash: "wrong", ready: false });
        report();
        const token = ++generation;
        setTimeout(() => { if (token === generation) { set({ flash: undefined }); begin(s.index + 1); } }, 500);
      }
    },
  };
});
