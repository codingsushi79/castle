import { create } from "zustand";
import { Color, moveFromUci, positionOf, fenOf, turnOf, uciOf } from "./chess";
import { makeSan } from "chessops/san";
import type { Move } from "chessops/types";
import { Sound } from "./sound";
import { load, save } from "./storage";
import { logActivity } from "./activity";
import { usePacks } from "./packs";


export interface Puzzle {
  id: string;
  fen: string;
  moves: string[]; // the opponent's setup move, then the solution
  rating: number;
  themes: string[];
  source?: string;
}

/** "battle" is a race against another player online (lib/battle.ts runs it). */
export type PuzzleMode = "rated" | "rush" | "mistakes" | "daily" | "pack" | "battle" | "storm" | "learn";
export type PuzzleStatus = "loading" | "solving" | "wrong" | "solved" | "revealed" | "empty" | "rushOver";

export interface PuzzleStats {
  ratingHistory: { t: number; r: number }[];
  themes: Record<string, { attempts: number; solved: number }>;
  rushScores: number[];
  dailySolved: number[];
}

export const THEME_NAMES: Record<string, string> = {
  all: "All themes", mateIn1: "Mate in 1", mateIn2: "Mate in 2", mateIn3: "Mate in 3", fork: "Fork", pin: "Pin", skewer: "Skewer",
  discoveredAttack: "Discovered attack", sacrifice: "Sacrifice", deflection: "Deflection", attraction: "Attraction",
  backRankMate: "Back-rank mate", hangingPiece: "Hanging piece", trappedPiece: "Trapped piece", endgame: "Endgame",
  middlegame: "Middlegame", opening: "Opening", promotion: "Promotion", kingsideAttack: "Kingside attack", quietMove: "Quiet move",
  zugzwang: "Zugzwang", defensiveMove: "Defensive move", rookEndgame: "Rook endgame", pawnEndgame: "Pawn endgame",
  smotheredMate: "Smothered mate", doubleCheck: "Double check", xRayAttack: "X-ray attack", clearance: "Clearance",
  intermezzo: "Intermezzo", advancedPawn: "Advanced pawn", mistake: "My mistakes",
};

export const dayNumber = (d = new Date()) => Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 86400000);

interface State {
  all: Puzzle[];
  loaded: boolean;
  mode: PuzzleMode;
  status: PuzzleStatus;
  puzzle?: Puzzle;
  fen: string;
  lastMove?: [string, string];
  hint?: string;
  userColor: Color;
  theme: string;
  played: string[];
  rating: number;
  solved: number;
  failed: number;
  streak: number;
  delta: number;
  rushActive: boolean;
  rushScore: number;
  rushStrikes: number;
  rushRemaining: number;
  rushMinutes: number;
  mistakes: Puzzle[];
  packId?: string;
  stats: PuzzleStats;
  openPack: (id?: string) => void;
  load: () => void;
  setMode: (m: PuzzleMode) => void;
  setTheme: (t: string) => void;
  next: () => void;
  retry: () => void;
  attempt: (move: Move) => void;
  showHint: () => void;
  reveal: () => void;
  startRush: (minutes: number) => void;
  addMistakes: (p: Puzzle[]) => number;
  daily: () => Puzzle | undefined;
  markDailySolved: () => void;
}

let step = 0;
let scored = false;
let generation = 0;
const seen = new Set<string>();
let rushTimer: ReturnType<typeof setInterval> | undefined;

export const usePuzzles = create<State>((set, get) => {
  const persist = () => {
    const s = get();
    save("puzzle", { rating: s.rating, solved: s.solved, failed: s.failed });
    save("puzzleStats", s.stats);
  };

  const start = (p: Puzzle, rescore = true) => {
    const token = ++generation;
    seen.add(p.id);
    step = 0;
    if (rescore) scored = false;
    set({ puzzle: p, fen: p.fen, lastMove: undefined, hint: undefined, played: [], status: "solving", userColor: turnOf(p.fen) === "white" ? "black" : "white", ...(rescore ? { delta: 0 } : {}) });
    setTimeout(() => token === generation && scripted(), get().mode === "rush" ? 300 : 550);
  };

  const scripted = () => {
    const { puzzle, fen, played } = get();
    if (!puzzle || step >= puzzle.moves.length) return;
    const pos = positionOf(fen).clone();
    const m = moveFromUci(pos, puzzle.moves[step]);
    if (!m) return;
    const san = makeSan(pos, m);
    const uci = uciOf(pos, m, false);
    pos.play(m);
    step++;
    Sound.forSan(san);
    set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], played: [...played, san] });
  };

  const score = (ok: boolean) => {
    const s = get();
    if (scored || !s.puzzle) return;
    scored = true;
    const stats: PuzzleStats = { ...s.stats, themes: { ...s.stats.themes } };
    for (const t of s.puzzle.themes) {
      const cur = stats.themes[t] ?? { attempts: 0, solved: 0 };
      stats.themes[t] = { attempts: cur.attempts + 1, solved: cur.solved + (ok ? 1 : 0) };
    }
    let { rating } = s;
    let delta = 0;
    if (s.mode === "rated") {
      const expected = 1 / (1 + Math.pow(10, (s.puzzle.rating - rating) / 400));
      delta = Math.round(32 * ((ok ? 1 : 0) - expected));
      rating = Math.max(400, rating + delta);
      stats.ratingHistory = [...stats.ratingHistory, { t: Date.now(), r: rating }].slice(-2000);
    }
    set({ stats, rating, delta, solved: s.solved + (ok ? 1 : 0), failed: s.failed + (ok ? 0 : 1), streak: ok ? s.streak + 1 : 0 });
    logActivity(s.mode === "rush" ? "rush" : "puzzle", ok);
    persist();
  };

  const endRush = (record: boolean) => {
    clearInterval(rushTimer);
    rushTimer = undefined;
    const s = get();
    if (!s.rushActive) return;
    generation++;
    const stats = record ? { ...s.stats, rushScores: [...s.stats.rushScores, s.rushScore] } : s.stats;
    set({ rushActive: false, status: "rushOver", stats });
    if (record) {
      persist();
      Sound.end();
    }
  };

  const finish = () => {
    const firstTry = !scored;
    score(true);
    set({ status: "solved" });
    Sound.success();
    const s = get();
    if (s.mode === "daily") s.markDailySolved();
    else if (s.mode === "pack" && firstTry && s.puzzle && s.packId) usePacks.getState().markSolved(s.packId, s.puzzle.id);
    else if (s.mode === "mistakes" && firstTry && s.puzzle) {
      const mistakes = s.mistakes.filter((m) => m.id !== s.puzzle!.id);
      save("mistakes", mistakes);
      set({ mistakes });
    } else if (s.mode === "rush") {
      set({ rushScore: s.rushScore + 1 });
      const token = generation;
      setTimeout(() => token === generation && get().next(), 350);
    }
  };

  const saved = load("puzzle", { rating: 1200, solved: 0, failed: 0 });
  return {
    all: [],
    loaded: false,
    mode: "rated",
    status: "loading",
    fen: "8/8/8/8/8/8/8/8 w - - 0 1",
    userColor: "white",
    theme: "all",
    played: [],
    rating: saved.rating,
    solved: saved.solved,
    failed: saved.failed,
    streak: 0,
    delta: 0,
    rushActive: false,
    rushScore: 0,
    rushStrikes: 0,
    rushRemaining: 0,
    rushMinutes: 3,
    mistakes: load<Puzzle[]>("mistakes", []),
    stats: { ratingHistory: [], themes: {}, rushScores: [], dailySolved: [], ...load<Partial<PuzzleStats>>("puzzleStats", {}) },

    load: async () => {
      if (get().loaded) return;
      const text = await fetch(`${import.meta.env.BASE_URL}data/puzzles.tsv`).then((r) => r.text()).catch(() => "");
      const all: Puzzle[] = [];
      for (const line of text.split("\n")) {
        const c = line.split("\t");
        if (c.length >= 5) all.push({ id: c[0], fen: c[1], moves: c[2].split(" "), rating: parseInt(c[3], 10) || 1500, themes: c[4].split(" ") });
      }
      set({ all, loaded: true });
      if (!["rush", "battle", "storm", "learn"].includes(get().mode)) get().next();
    },

    daily: () => {
      const pool = get().all.filter((p) => p.rating >= 1000 && p.rating <= 1900 && p.moves.length <= 6);
      return pool.length ? pool[(dayNumber() * 2654435761) % pool.length] : get().all[0];
    },

    markDailySolved: () => {
      const s = get();
      if (s.stats.dailySolved.includes(dayNumber())) return;
      set({ stats: { ...s.stats, dailySolved: [...s.stats.dailySolved, dayNumber()] } });
      persist();
    },

    openPack: (packId) => {
      set({ packId, mode: "pack" });
      if (packId) get().next();
      else { generation++; set({ puzzle: undefined, status: "empty" }); }
    },

    setMode: (mode) => {
      endRush(false);
      set({ mode });
      if (mode === "rush") {
        generation++;
        set({ puzzle: undefined, status: "rushOver", rushScore: 0, rushStrikes: 0 });
      } else if (mode === "pack") { generation++; set({ puzzle: undefined, status: "empty", packId: undefined }); }
      else if (mode === "battle" || mode === "storm" || mode === "learn") { generation++; set({ puzzle: undefined, status: "empty" }); }
      else get().next();
    },

    setTheme: (theme) => {
      set({ theme });
      if (get().mode === "rated") get().next();
    },

    startRush: (minutes) => {
      set({ mode: "rush", rushMinutes: minutes, rushScore: 0, rushStrikes: 0, rushRemaining: minutes * 60, rushActive: true });
      let last = Date.now();
      clearInterval(rushTimer);
      rushTimer = setInterval(() => {
        const now = Date.now();
        const left = Math.max(0, get().rushRemaining - (now - last) / 1000);
        last = now;
        set({ rushRemaining: left });
        if (left <= 0) endRush(true);
      }, 100);
      get().next();
    },

    addMistakes: (list) => {
      const known = new Set(get().mistakes.map((m) => m.id));
      const fresh = list.filter((m) => !known.has(m.id));
      const mistakes = [...fresh, ...get().mistakes];
      save("mistakes", mistakes);
      set({ mistakes });
      return fresh.length;
    },

    next: () => {
      const s = get();
      if (!s.loaded) return;
      const pickRandom = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
      if (s.mode === "daily") {
        const p = s.daily();
        if (p) start(p);
      } else if (s.mode === "pack") {
        const pack = usePacks.getState().packs.find((p) => p.id === s.packId);
        if (!pack) { generation++; set({ puzzle: undefined, status: "empty" }); return; }
        const pool = pack.puzzles.filter((p) => !pack.solved.includes(p.id) && !seen.has(p.id));
        const pick = pool[0] ?? pack.puzzles.find((p) => !pack.solved.includes(p.id)) ?? pack.puzzles[Math.floor(Math.random() * pack.puzzles.length)];
        if (pick) start(pick); else { generation++; set({ puzzle: undefined, status: "empty" }); }
      } else if (s.mode === "mistakes") {
        let pool = s.mistakes.filter((m) => !seen.has(m.id));
        if (!pool.length) {
          s.mistakes.forEach((m) => seen.delete(m.id));
          pool = s.mistakes;
        }
        if (!pool.length) {
          generation++;
          set({ puzzle: undefined, status: "empty" });
        } else start(pool[0]);
      } else if (s.mode === "rush") {
        if (!s.rushActive) return;
        const target = 600 + s.rushScore * 70;
        const pool = s.all.filter((p) => Math.abs(p.rating - target) <= 120 && !seen.has(p.id) && p.moves.length <= 6);
        start(pool.length ? pickRandom(pool) : pickRandom(s.all));
      } else {
        const pool = s.all.filter((p) => (s.theme === "all" || p.themes.includes(s.theme)) && !seen.has(p.id));
        let candidates: Puzzle[] = [];
        for (let w = 75; !candidates.length && w <= 3200; w *= 2) candidates = pool.filter((p) => Math.abs(p.rating - s.rating) <= w);
        if (pool.length < 5) seen.clear();
        const pick = candidates.length ? pickRandom(candidates) : pool.length ? pickRandom(pool) : pickRandom(s.all);
        if (pick) start(pick);
      }
    },

    retry: () => {
      const p = get().puzzle;
      if (p) start(p, false);
    },

    attempt: (move) => {
      const s = get();
      const p = s.puzzle;
      if (!p || s.status !== "solving" || step === 0 || step >= p.moves.length) return;
      const pos = positionOf(s.fen).clone();
      const uci = uciOf(pos, move, false);
      const san = makeSan(pos, move);
      pos.play(move);
      // Any checkmate is as good as the listed one.
      if (uci !== p.moves[step] && !pos.isCheckmate()) {
        score(false);
        set({ status: "wrong" });
        Sound.error();
        const token = generation;
        if (s.mode === "rush") {
          const strikes = s.rushStrikes + 1;
          set({ rushStrikes: strikes });
          if (strikes >= 3) return endRush(true);
          setTimeout(() => token === generation && get().next(), 600);
        } else setTimeout(() => token === generation && get().status === "wrong" && set({ status: "solving" }), 900);
        return;
      }
      step++;
      Sound.forSan(san);
      set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], played: [...s.played, san], hint: undefined });
      if (step >= p.moves.length || pos.isCheckmate()) return finish();
      const token = generation;
      setTimeout(() => {
        if (token !== generation) return;
        scripted();
        if (step >= p.moves.length) finish();
      }, s.mode === "rush" ? 250 : 450);
    },

    showHint: () => {
      const s = get();
      if (s.status !== "solving" || s.mode === "rush" || !s.puzzle || step >= s.puzzle.moves.length) return;
      score(false);
      set({ hint: s.puzzle.moves[step].slice(0, 2) });
    },

    reveal: () => {
      const s = get();
      if (s.mode === "rush" || !s.puzzle || !(s.status === "solving" || s.status === "wrong")) return;
      score(false);
      set({ status: "revealed", hint: undefined });
      const token = generation;
      const playNext = () => {
        if (token !== generation || step >= s.puzzle!.moves.length) return;
        scripted();
        setTimeout(playNext, 700);
      };
      playNext();
    },
  };
});

export const canMovePuzzle = (s: Pick<State, "status" | "fen" | "userColor">) => s.status === "solving" && step > 0 && turnOf(s.fen) === s.userColor;

export function dailyStreak(stats: PuzzleStats): number {
  const days = new Set(stats.dailySolved);
  let day = dayNumber();
  if (!days.has(day)) day--;
  let n = 0;
  while (days.has(day)) { n++; day--; }
  return n;
}
