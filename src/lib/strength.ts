import type { Score } from "./chess";

/**
 * Castle's strength model: how a computer opponent plays like a person of a
 * given rating.
 *
 * The engine searches a few candidate moves (MultiPV) to a shallow depth, and
 * the opponent picks among them, preferring good moves but sometimes taking a
 * worse one. How much worse is measured in winning chances, the way people's
 * mistakes are: dropping a pawn when already a rook up barely matters, dropping
 * one in a level position does. Weaker levels search less deeply (so they miss
 * tactics) and pick more loosely; now and then they don't see the position at
 * all and play almost any of their candidates.
 *
 * A level runs from 0 (the weakest) to 1 (the strongest the model plays). The
 * rating each level plays at was measured, not guessed: see CALIBRATION.
 */

export interface StrengthParams {
  /** Search depth, in plies. */
  depth: number;
  /** How many candidate moves are searched. */
  multipv: number;
  /** How loosely a move is picked: a move this many winning-chance points worse is e (2.7) times less likely. */
  temperature: number;
  /** The chance, on any move, of a lapse: picking among the candidates almost at random. */
  lapse: number;
}

export interface Candidate {
  /** The move, in UCI. */
  move: string;
  /** The score after it, from the point of view of the side choosing. */
  score: Score;
}

/** Winning chances 0–100 for the side the score belongs to. */
export function chances(s: Score): number {
  if ("mate" in s) return s.mate > 0 ? 100 : 0;
  const c = Math.max(-2000, Math.min(2000, s.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

/** The playing parameters for a level from 0 to 1. */
export function paramsForLevel(level: number): StrengthParams {
  const l = Math.min(1, Math.max(0, level));
  return {
    depth: Math.round(1 + 9 * l ** 1.5),
    // Weak levels consider (almost) every move, so the blunders people make are among their choices.
    multipv: Math.round(40 - 32 * l),
    temperature: 2 * 15 ** (1 - l),
    lapse: 0.12 * (1 - l) ** 2,
  };
}

/** Which measured table applies: the bundled Wasabi, or Stockfish (also used for other strong engines). */
export type ModelEngine = "stockfish" | "wasabi";

/**
 * Measured ratings for levels of the model, as [level, rating], by
 * scripts/calibrate-strength.mjs: games against Stockfish limited to known
 * ratings (its UCI_Elo, anchored to the CCRL list, at the 60s + 0.6s it is
 * calibrated for) and, below the lowest rating Stockfish offers, against the
 * model's own levels measured first. The same level plays differently with
 * each engine, so each has its own table. Ratings in between are interpolated.
 */
export const CALIBRATION: Record<ModelEngine, [number, number][]> = {
  // Stockfish 19, 10 games a pairing at 60 s + 0.6 s (November 2026).
  stockfish: [[0, 528], [0.1, 598], [0.2, 599], [0.3, 838], [0.4, 842], [0.5, 941], [0.6, 1159], [0.7, 1372], [0.75, 1457], [0.8, 1717], [0.85, 1857], [0.875, 2086], [0.9, 2292], [0.95, 2542], [1, 2671]],
  // Wasabi 2.1, 10 games a pairing at 60 s + 0.6 s (November 2026).
  wasabi: [[0, 190], [0.1, 206], [0.2, 361], [0.3, 570], [0.4, 581], [0.5, 794], [0.6, 1022], [0.7, 1149], [0.8, 1362], [0.825, 1420], [0.85, 1702], [0.9, 1924], [0.95, 2002], [1, 2238]],
};

/** The rating a level plays at. */
export function eloForLevel(level: number, engine: ModelEngine = "stockfish"): number {
  const t = CALIBRATION[engine];
  if (level <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (level <= t[i][0]) {
      const [l0, e0] = t[i - 1], [l1, e1] = t[i];
      return e0 + ((level - l0) / (l1 - l0)) * (e1 - e0);
    }
  }
  return t[t.length - 1][1];
}

/** The level that plays at a rating. Ratings outside the measured range are clamped to it. */
export function levelForElo(elo: number, engine: ModelEngine = "stockfish"): number {
  const t = CALIBRATION[engine];
  if (elo <= t[0][1]) return t[0][0];
  for (let i = 1; i < t.length; i++) {
    if (elo <= t[i][1]) {
      const [l0, e0] = t[i - 1], [l1, e1] = t[i];
      return e1 === e0 ? l0 : l0 + ((elo - e0) / (e1 - e0)) * (l1 - l0);
    }
  }
  return t[t.length - 1][0];
}

/** The range of ratings the model can play at with an engine. */
export const eloRange = (engine: ModelEngine = "stockfish"): [number, number] => {
  const t = CALIBRATION[engine];
  return [t[0][1], t[t.length - 1][1]];
};

/**
 * Picks a move from the engine's candidates. `random` is a source of numbers in
 * [0, 1), so tests and calibration can replay a game exactly.
 */
export function pickMove(candidates: Candidate[], params: StrengthParams, random: () => number = Math.random, bonus?: (move: string) => number): { move: string; loss: number } | undefined {
  if (!candidates.length) return undefined;
  const best = Math.max(...candidates.map((c) => chances(c.score)));
  const losses = candidates.map((c) => best - chances(c.score));
  // A leaning (an attacker's taste for checks, say) makes some moves look a little better than they are.
  const felt = bonus ? losses.map((l, i) => Math.max(0, l - bonus(candidates[i].move))) : losses;
  // A lapse: the position isn't really looked at. Even then, moves that lose at once are a little less likely.
  const temperature = random() < params.lapse ? Math.max(params.temperature, 60) : params.temperature;
  const weights = felt.map((l) => Math.exp(-l / temperature));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return { move: candidates[i].move, loss: losses[i] };
  }
  return { move: candidates[0].move, loss: losses[0] };
}

/** A small seeded random source (mulberry32), for repeatable games. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
