import { makeSan } from "chessops/san";
import type { Move } from "chessops/types";
import { create } from "zustand";
import { Color, fenOf, moveFromUci, positionOf, turnOf, uciOf } from "./chess";
import { api, onlineToken, useOnline } from "./online";
import { Sound } from "./sound";

/**
 * Ranked puzzle rush and puzzle battles, checked by the server. The server
 * picks the puzzles and keeps the solutions: this app gets each position with
 * the moves played so far, sends every move it makes, and is told whether it
 * was right (with the opponent's reply), solved the puzzle, or was wrong (with
 * the answer). Scores therefore come from the server, never from the app.
 */
export interface RunView {
  id: string; kind: "rush" | "battle" | "storm"; status: "waiting" | "countdown" | "running" | "finished";
  /** Storm: solves in a row (time bonuses at 5, 12, 20, 30). */
  combo?: number;
  score: number; strikes: number; index: number; startedAt: number | null; endsAt: number | null; now: number;
  puzzle: { id: string; fen: string; played: string[]; rating: number } | null;
}
interface Side { name: string | null; score: number; strikes: number; done: boolean }
export interface RaceView {
  id: string; code: string; minutes: number; startedAt: number | null; endsAt: number | null; now: number;
  status: "waiting" | "countdown" | "running" | "finished"; a: Side; b: Side;
}

interface State {
  kind?: "rush" | "battle" | "storm";
  run?: RunView;
  key?: string;
  race?: RaceView;
  side?: "a" | "b";
  /** Server clock minus this computer's. */
  offset: number;
  fen: string;
  lastMove?: [string, string];
  userColor: Color;
  /** Whether the board takes a move right now. */
  ready: boolean;
  flash?: "right" | "wrong";
  /** The move that would have been right, shown briefly after a miss. */
  answer?: [string, string];
  error?: string;
  startRush: (minutes: number) => Promise<void>;
  /** Storm: three minutes, misses cost ten seconds, solves in a row earn time. */
  startStorm: () => Promise<void>;
  createBattle: (minutes: number, isPublic: boolean) => Promise<void>;
  joinBattle: (code: string) => Promise<void>;
  leave: () => void;
  attempt: (move: Move) => void;
}

const EMPTY = "8/8/8/8/8/8/8/8 w - - 0 1";
let poll: ReturnType<typeof setInterval> | undefined;
let generation = 0;
let shownPuzzle = "";

const ensureOnline = async () => {
  const o = useOnline.getState();
  if (!o.ready) await o.start();
  if (!useOnline.getState().ready) throw new Error(useOnline.getState().error ?? "Castle Online is not reachable.");
};

export const useRace = create<State>((set, get) => {
  /** Plays a list of UCI moves onto the board one at a time, then hands it to the player. */
  const animate = (fen: string, moves: string[], token: number, then: () => void) => {
    let i = 0;
    const step = () => {
      if (token !== generation) return;
      if (i >= moves.length) return then();
      const pos = positionOf(get().fen).clone();
      const m = moveFromUci(pos, moves[i++]);
      if (!m) return then();
      const uci = uciOf(pos, m, false);
      Sound.forSan(makeSan(pos, m));
      pos.play(m);
      set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)] });
      setTimeout(step, 260);
    };
    set({ fen, lastMove: undefined });
    setTimeout(step, 260);
  };

  /** Shows the run's current puzzle (once per puzzle). */
  const show = (run: RunView) => {
    set({ run, offset: run.now - Date.now() });
    if (run.status !== "running" || !run.puzzle) return set({ ready: false });
    const tag = `${run.id}:${run.index}`;
    if (shownPuzzle === tag) return;
    shownPuzzle = tag;
    const token = ++generation;
    const p = run.puzzle;
    // The solver plays the side to move after the setup move.
    set({ userColor: turnOf(p.fen) === "white" ? "black" : "white", ready: false, answer: undefined });
    animate(p.fen, p.played, token, () => set({ ready: running() }));
  };

  const running = () => {
    const r = get().run;
    if (!r || r.status !== "running" || (r.kind !== "storm" && r.strikes >= 3)) return false;
    return !r.endsAt || Date.now() + get().offset < r.endsAt;
  };

  const loadRun = async () => {
    const { run, key } = get();
    if (!run || !key) return;
    const r = await api<RunView>(`race/run?id=${encodeURIComponent(run.id)}&key=${encodeURIComponent(key)}`).catch(() => undefined);
    if (r && get().run?.id === r.id) show(r);
  };

  /** Battles: the race view (both scores, the countdown) every second; rush: just the end of the clock. */
  const watch = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      const { race, run } = get();
      if (race) {
        const v = await api<RaceView>(`race?id=${encodeURIComponent(race.id)}`).catch(() => undefined);
        if (!v || get().race?.id !== v.id) return;
        const started = race.status !== "running" && v.status === "running";
        set({ race: v, offset: v.now - Date.now() });
        if (started) { Sound.end(); loadRun(); }
        if (v.status === "finished") {
          if (race.status !== "finished") Sound.end();
          set({ ready: false });
          clearInterval(poll);
        }
      } else if (run && run.status === "running" && !running()) {
        set({ ready: false, run: { ...run, status: "finished" } });
        Sound.end();
        clearInterval(poll);
      }
    }, 1000);
  };

  const reset = () => {
    clearInterval(poll);
    generation++;
    shownPuzzle = "";
    set({ run: undefined, key: undefined, race: undefined, side: undefined, kind: undefined, ready: false, flash: undefined, answer: undefined, error: undefined, fen: EMPTY, lastMove: undefined });
  };

  return {
    offset: 0,
    fen: EMPTY,
    userColor: "white",
    ready: false,
    startRush: async (minutes) => {
      await ensureOnline();
      reset();
      const r = await api<{ id: string; key: string; run: RunView }>("race/rush", { token: onlineToken(), name: useOnline.getState().name, minutes });
      set({ kind: "rush", key: r.key });
      show(r.run);
      watch();
    },
    startStorm: async () => {
      await ensureOnline();
      reset();
      const r = await api<{ id: string; key: string; run: RunView }>("race/storm", { token: onlineToken(), name: useOnline.getState().name });
      set({ kind: "storm", key: r.key });
      show(r.run);
      watch();
    },
    createBattle: async (minutes, isPublic) => {
      await ensureOnline();
      reset();
      const r = await api<{ race: string; code: string; run: string; key: string }>("race/battle", { token: onlineToken(), name: useOnline.getState().name, minutes, public: isPublic });
      const race = await api<RaceView>(`race?id=${encodeURIComponent(r.race)}`);
      set({ kind: "battle", key: r.key, side: "a", race, run: { id: r.run, kind: "battle", status: "waiting", score: 0, strikes: 0, index: 0, startedAt: null, endsAt: null, now: race.now, puzzle: null } });
      watch();
    },
    joinBattle: async (code) => {
      await ensureOnline();
      reset();
      const r = await api<{ race: string; code: string; run: string; key: string }>("race/join", { token: onlineToken(), name: useOnline.getState().name, code });
      const race = await api<RaceView>(`race?id=${encodeURIComponent(r.race)}`);
      set({ kind: "battle", key: r.key, side: "b", race, run: { id: r.run, kind: "battle", status: "countdown", score: 0, strikes: 0, index: 0, startedAt: race.startedAt, endsAt: race.endsAt, now: race.now, puzzle: null } });
      watch();
    },
    leave: () => {
      const { race, run, key } = get();
      if (race?.status === "waiting" && run && key) api("race/cancel", { run: run.id, key }).catch(() => {});
      reset();
    },
    attempt: (move) => {
      const s = get();
      if (!s.run || !s.key || !s.ready || !running()) return;
      const pos = positionOf(s.fen).clone();
      const uci = uciOf(pos, move, false);
      Sound.forSan(makeSan(pos, move));
      pos.play(move);
      // Show the move straight away; the server's verdict follows.
      set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], ready: false });
      const index = s.run.index, token = generation;
      api<{ result: "correct" | "solved" | "wrong" | "stale"; reply?: string; answer?: string; run: RunView }>("race/move", { id: s.run.id, key: s.key, index, uci })
        .then((r) => {
          if (token !== generation) return;
          if (r.result === "correct" && r.reply) {
            animate(get().fen, [r.reply], token, () => set({ ready: running() }));
            set({ run: r.run });
          } else if (r.result === "solved") {
            Sound.success();
            set({ flash: "right", run: r.run });
            setTimeout(() => { if (token === generation) { set({ flash: undefined }); show(r.run); } }, 350);
          } else if (r.result === "wrong") {
            Sound.error();
            set({ flash: "wrong", run: r.run, answer: r.answer ? [r.answer.slice(0, 2), r.answer.slice(2, 4)] : undefined });
            setTimeout(() => { if (token === generation) { set({ flash: undefined, answer: undefined }); show(r.run); } }, 900);
          } else {
            shownPuzzle = "";
            show(r.run);
          }
        })
        .catch((e) => { set({ error: e.message }); shownPuzzle = ""; loadRun(); });
    },
  };
});
