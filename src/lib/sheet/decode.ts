import { Chess } from "chessops/chess";
import { makeSan } from "chessops/san";
import type { NormalMove, Role } from "chessops/types";
import { makeSquare } from "chessops/util";
import { fenOf, START_FEN, positionOf, uciOf } from "../chess";
import type { HalfMarks, Mark } from "./scan";

/**
 * Turns the circles read from a scoresheet into moves. Each half-move gives
 * the piece and the square it went to; the game is replayed from the start,
 * and the legal move that fits is chosen. When nothing fits exactly (a circle
 * misread or filled by mistake), the moves that fit all but one group are
 * offered instead. Anything you correct by hand is kept, and the moves after
 * it are worked out again from there.
 */

const ROLES: Role[] = ["king", "queen", "rook", "bishop", "knight"];

export interface Option {
  uci: string;
  san: string;
}

export interface Ply {
  index: number;
  moveNumber: number;
  color: "white" | "black";
  /** The move chosen (by the marks, or by you), if any. */
  uci?: string;
  san?: string;
  /**
   * ok: exactly one legal move fits. inferred: several fit (two knights that
   * can reach the square, say), and only this one lets the moves after it fit.
   * chosen: you picked it. ambiguous: several fit and the game can't tell which.
   * guessed: none fit exactly; this one fits all but one group. unreadable:
   * nothing close.
   */
  status: "ok" | "inferred" | "chosen" | "ambiguous" | "guessed" | "unreadable";
  options: Option[];
  fenBefore: string;
  /** What the marks said, for showing beside the scan: "N e 4", with ? for anything unclear. */
  read: string;
}

const PIECE_LETTERS = ["K", "Q", "R", "B", "N"];

/** Every legal move, with UCI in the usual castling style (e1g1). */
function legalMoves(fen: string): { move: NormalMove; uci: string; role: Role; to: number; san: string }[] {
  const pos = positionOf(fen) as Chess;
  const out: { move: NormalMove; uci: string; role: Role; to: number; san: string }[] = [];
  for (const [from, dests] of pos.allDests()) {
    const piece = pos.board.get(from)!;
    for (const to of dests) {
      const promos: (Role | undefined)[] = piece.role === "pawn" && (to >> 3 === 7 || to >> 3 === 0) ? ["queen", "rook", "bishop", "knight"] : [undefined];
      for (const promotion of promos) {
        const move: NormalMove = { from, to, promotion };
        const uci = uciOf(pos, move, false);
        // The square the move is written to: for castling, where the king ends up.
        const shown = uci.slice(2, 4);
        const target = (shown.charCodeAt(0) - 97) + (Number(shown[1]) - 1) * 8;
        out.push({ move, uci, role: piece.role, to: target, san: makeSan(pos, move) });
      }
    }
  }
  return out;
}

/** The values a group allows: what's filled, or (if nothing clear) anything faint, or anything at all. */
function allowed(m: Mark, n: number, emptyMeans?: number): { set: Set<number>; sure: boolean } {
  if (m.filled.length === 1) return { set: new Set(m.filled), sure: true };
  if (m.filled.length > 1) return { set: new Set(m.filled), sure: false };
  if (m.faint.length) return { set: new Set([...m.faint, ...(emptyMeans !== undefined ? [emptyMeans] : [])]), sure: false };
  return emptyMeans !== undefined ? { set: new Set([emptyMeans]), sure: true } : { set: new Set(Array.from({ length: n }, (_, i) => i)), sure: false };
}

function describe(h: HalfMarks): string {
  const part = (m: Mark, labels: string[], none: string) => (m.filled.length === 1 ? labels[m.filled[0]] : m.filled.length > 1 ? `{${m.filled.map((i) => labels[i]).join("/")}}` : m.faint.length ? "?" : none);
  return `${part(h.piece, PIECE_LETTERS, "")}${part(h.file, [..."abcdefgh"], "?")}${part(h.rank, [..."12345678"], "?")}`;
}

type Legal = ReturnType<typeof legalMoves>[number];

/** The legal moves that fit a half-move's circles exactly, and those that fit all but one group. */
function candidates(h: HalfMarks, legal: Legal[]): { exact: Legal[]; near: Legal[]; sure: boolean } {
  const piece = allowed(h.piece, 5, 5); // 5 stands for a pawn: no circle filled
  const file = allowed(h.file, 8), rank = allowed(h.rank, 8);
  const roleIndex = (r: Role) => (r === "pawn" ? 5 : ROLES.indexOf(r));
  const fits = (m: Legal) => [piece.set.has(roleIndex(m.role)), file.set.has(m.to & 7), rank.set.has(m.to >> 3)];
  // A promotion with only the square marked becomes a queen; you can change it.
  const queenFirst = (list: Legal[]) => [...list].sort((a, b) => Number(b.move.promotion === "queen") - Number(a.move.promotion === "queen"));
  const notUnderpromotion = (list: Legal[]) => list.filter((m) => !m.move.promotion || m.move.promotion === "queen" || list.every((o) => o.uci.slice(0, 4) !== m.uci.slice(0, 4) || o === m));
  return {
    exact: queenFirst(notUnderpromotion(legal.filter((m) => fits(m).every(Boolean)))),
    near: queenFirst(notUnderpromotion(legal.filter((m) => fits(m).filter(Boolean).length === 2))),
    sure: piece.sure && file.sure && rank.sure,
  };
}

const play = (fen: string, m: Legal) => {
  const pos = positionOf(fen).clone();
  pos.play(m.move);
  return fenOf(pos);
};

/**
 * How well the following half-moves fit if the game goes this way: decoded
 * greedily for a while, scoring exact fits highly. A wrong turn soon stops fitting.
 */
function lookahead(halves: HalfMarks[], from: number, fen: string, depth = 14): number {
  let score = 0;
  for (let i = from; i < Math.min(halves.length, from + depth); i++) {
    if (halves[i].blank) break;
    const legal = legalMoves(fen);
    if (!legal.length) return score;
    const { exact, near } = candidates(halves[i], legal);
    const next = exact[0] ?? near[0];
    if (!next) return score - 6;
    score += exact.length === 1 ? 3 : exact.length ? 2 : 0;
    fen = play(fen, next);
  }
  return score;
}

/** Decodes a game from its half-moves in order; `chosen` holds moves picked by hand, by ply. */
export function decodeGame(halves: HalfMarks[], chosen: Map<number, string> = new Map(), startFen = START_FEN): { plies: Ply[]; fen: string; unfinished: boolean } {
  const plies: Ply[] = [];
  let fen = startFen;
  // The game ends at the first blank half-move.
  let end = halves.findIndex((h) => h.blank);
  if (end < 0) end = halves.length;
  for (let i = 0; i < end; i++) {
    const h = halves[i];
    const legal = legalMoves(fen);
    if (!legal.length) break;
    const base = { index: i, moveNumber: Math.floor(i / 2) + 1, color: i % 2 === 0 ? "white" : "black", fenBefore: fen, read: describe(h) } as const;
    const { exact, near, sure } = candidates(h, legal);
    const opt = (list: Legal[]) => list.map((m) => ({ uci: m.uci, san: m.san }));
    const pool = exact.length ? exact : near;
    const picked = chosen.has(i) ? legal.find((m) => m.uci === chosen.get(i)) : undefined;
    let move: Legal | undefined;
    let status: Ply["status"];
    if (picked) { move = picked; status = "chosen"; }
    else if (!pool.length) {
      plies.push({ ...base, status: "unreadable", options: opt(legal) });
      return { plies, fen, unfinished: true };
    } else if (pool.length === 1) { move = pool[0]; status = exact.length ? (sure ? "ok" : "ambiguous") : "guessed"; }
    else {
      // Several fit: the one the rest of the game agrees with.
      const scored = pool.map((m) => ({ m, score: lookahead(halves.slice(0, end), i + 1, play(fen, m)) })).sort((a, b) => b.score - a.score);
      move = scored[0].m;
      const clear = scored[0].score > scored[1].score;
      status = exact.length ? (clear ? "inferred" : "ambiguous") : "guessed";
    }
    plies.push({ ...base, uci: move.uci, san: move.san, status, options: opt(pool.length ? pool : legal) });
    fen = play(fen, move);
  }
  return { plies, fen, unfinished: end < halves.length && halves.slice(end).some((h) => !h.blank) };
}

/** Squares as names, for messages. */
export const squareName = (sq: number) => makeSquare(sq);
