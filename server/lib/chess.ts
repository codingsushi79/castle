import { normalizeMove } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import type { Rules } from "chessops/types";
import { parseUci } from "chessops/util";
import { defaultPosition, setupPosition } from "chessops/variant";

export type Result = "1-0" | "0-1" | "1/2-1/2";
export interface Replay {
  ok: boolean;
  fen: string;
  turn: "white" | "black";
  ended?: { result: Result; reason: string };
}

/** Variants Castle Online plays. "chess960" is standard rules from a shuffled start. */
export const VARIANTS = ["chess", "chess960", "crazyhouse", "atomic", "kingofthehill", "3check", "antichess", "horde", "racingkings"] as const;
export type Variant = (typeof VARIANTS)[number];
export const variantOf = (v: unknown): Variant => (VARIANTS.includes(v as Variant) ? (v as Variant) : "chess");
export const rulesOf = (v: Variant): Rules => (v === "chess960" ? "chess" : v);

const VARIANT_WIN: Partial<Record<Rules, string>> = {
  kingofthehill: "king in the centre",
  "3check": "three checks",
  atomic: "king exploded",
  antichess: "no pieces left",
  horde: "horde destroyed",
  racingkings: "king reached the eighth rank",
};

/** One of the 960 Fischer random starting positions (518 is the classical one). */
export function chess960Fen(index: number): string {
  let n = ((index % 960) + 960) % 960;
  const back: (string | undefined)[] = new Array(8).fill(undefined);
  back[(n % 4) * 2 + 1] = "b";
  n = Math.floor(n / 4);
  back[(n % 4) * 2] = "b";
  n = Math.floor(n / 4);
  const empties = () => back.map((p, i) => (p ? -1 : i)).filter((i) => i >= 0);
  back[empties()[n % 6]] = "q";
  n = Math.floor(n / 6);
  const [a, b] = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][n];
  const e = empties();
  back[e[a]] = "n";
  back[e[b]] = "n";
  for (const piece of ["r", "k", "r"]) back[empties()[0]] = piece;
  const row = back.join("");
  return `${row}/pppppppp/8/8/8/8/PPPPPPPP/${row.toUpperCase()} w KQkq - 0 1`;
}

/** The starting FEN for a new game of a variant (a fresh shuffle for 960). */
export function startFen(v: Variant): string {
  if (v === "chess960") return chess960Fen(Math.floor(Math.random() * 960));
  return makeFen(defaultPosition(rulesOf(v)).toSetup());
}

function startPosition(v: Variant, fen?: string | null) {
  const rules = rulesOf(v);
  if (!fen) return defaultPosition(rules);
  return setupPosition(rules, parseFen(fen).unwrap()).unwrap();
}

/** Plays a game's moves from the start, checking each, and reports how it stands. */
export function replay(moves: string[], variant: Variant = "chess", initialFen?: string | null): Replay {
  const pos = startPosition(variant, initialFen);
  const seen = new Map<string, number>();
  const key = () => makeFen(pos.toSetup()).split(" ").slice(0, 4).join(" ");
  seen.set(key(), 1);
  for (const uci of moves) {
    const raw = parseUci(uci);
    const m = raw && normalizeMove(pos, raw);
    if (!m || !pos.isLegal(m)) return { ok: false, fen: makeFen(pos.toSetup()), turn: pos.turn };
    pos.play(m);
    const k = key();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const fen = makeFen(pos.toSetup());
  let ended: Replay["ended"];
  const outcome = pos.outcome();
  if (outcome) {
    const result: Result = outcome.winner === "white" ? "1-0" : outcome.winner === "black" ? "0-1" : "1/2-1/2";
    const reason = pos.isVariantEnd() ? (VARIANT_WIN[pos.rules] ?? "variant rules")
      : pos.isCheckmate() ? "checkmate" : pos.isStalemate() ? "stalemate" : "insufficient material";
    ended = { result, reason };
  } else if ((seen.get(key()) ?? 0) >= 3) ended = { result: "1/2-1/2", reason: "threefold repetition" };
  else if (pos.halfmoves >= 100) ended = { result: "1/2-1/2", reason: "fifty-move rule" };
  return { ok: true, fen, turn: pos.turn, ended };
}

/** Whether a side has any way left to win: a flag against a bare king is a draw. */
export function canMate(moves: string[], color: "white" | "black", variant: Variant = "chess", initialFen?: string | null): boolean {
  const pos = startPosition(variant, initialFen);
  for (const uci of moves) {
    const raw = parseUci(uci);
    const m = raw && normalizeMove(pos, raw);
    if (m && pos.isLegal(m)) pos.play(m);
  }
  return !pos.hasInsufficientMaterial(color);
}
