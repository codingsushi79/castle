import { Chess } from "chessops/chess";
import { makeSan } from "chessops/san";
import type { NormalMove, Role } from "chessops/types";
import { makeSquare } from "chessops/util";
import { fenOf, START_FEN, positionOf, uciOf } from "../chess";
import type { HalfMarks, Mark } from "./scan";

/**
 * Turns the circles read from a scoresheet into moves. Each half-move gives
 * the piece and the square it went to, and only legal moves count.
 *
 * Usually exactly one legal move fits. When several do (two knights, or three
 * queens, that can reach the same square: the moves SAN has to disambiguate,
 * once or twice), or when none fits exactly (a circle misread or filled by
 * mistake), the whole game decides: every reading of the game is followed at
 * once (a beam search), scored by how many half-moves fit exactly, and the
 * best reading wins. So a choice is settled by any move after it, however far
 * on, and a move that stops fitting later sends the search back to try the
 * other choices it made earlier. Anything chosen by hand is kept, and the rest
 * is worked out again around it.
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

interface Legal {
  move: NormalMove;
  uci: string;
  role: Role;
  /** The square the move is written to: for castling, where the king ends up. */
  to: number;
}

/** Every legal move, with UCI in the usual castling style (e1g1). */
function legalMoves(fen: string): Legal[] {
  const pos = positionOf(fen) as Chess;
  const out: Legal[] = [];
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
        out.push({ move, uci, role: piece.role, to: target });
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
const sanOf = (fen: string, m: Legal) => makeSan(positionOf(fen), m.move);

/** One step of one reading of the game, linked back to the step before. */
interface Step {
  prev?: Step;
  ply: number;
  fen: string;
  move: Legal;
  kind: "exact" | "near" | "chosen";
  pool: Legal[];
  sure: boolean;
}

interface Reading {
  last?: Step;
  fen: string;
  score: number;
  /** Where this reading ran into a half-move nothing fits, if it did. */
  stuck?: { ply: number; fen: string };
  /** The position has no legal moves (mate or stalemate): the game is over. */
  over?: boolean;
}

/** How many readings are followed at once. */
const BEAM = 24;

/** Decodes a game from its half-moves in order; `chosen` holds moves picked by hand, by ply. */
export function decodeGame(halves: HalfMarks[], chosen: Map<number, string> = new Map(), startFen = START_FEN): { plies: Ply[]; fen: string; unfinished: boolean } {
  // The game ends at the first blank half-move.
  let end = halves.findIndex((h) => h.blank);
  if (end < 0) end = halves.length;
  const legalCache = new Map<string, Legal[]>();
  const legalAt = (fen: string) => {
    let l = legalCache.get(fen);
    if (!l) legalCache.set(fen, (l = legalMoves(fen)));
    return l;
  };

  let beam: Reading[] = [{ fen: startFen, score: 0 }];
  const finished: Reading[] = [];
  for (let i = 0; i < end && beam.length; i++) {
    const next: Reading[] = [];
    for (const r of beam) {
      const legal = legalAt(r.fen);
      if (!legal.length) { finished.push({ ...r, over: true }); continue; }
      let pool: Legal[], kind: Step["kind"], sure = true;
      if (chosen.has(i)) {
        const picked = legal.find((m) => m.uci === chosen.get(i));
        if (!picked) continue; // a reading where your choice isn't legal is wrong
        pool = [picked]; kind = "chosen";
      } else {
        const c = candidates(halves[i], legal);
        sure = c.sure;
        pool = c.exact.length ? c.exact : c.near;
        kind = c.exact.length ? "exact" : "near";
        if (!pool.length) { finished.push({ ...r, stuck: { ply: i, fen: r.fen } }); continue; }
      }
      const points = kind === "near" ? 0 : 3;
      for (const move of pool) next.push({ fen: play(r.fen, move), score: r.score + points, last: { prev: r.last, ply: i, fen: r.fen, move, kind, pool, sure } });
    }
    // Readings that reach the same position have the same future: keep the better one (the first, on a tie).
    const best = new Map<string, Reading>();
    for (const r of next) { const b = best.get(r.fen); if (!b || r.score > b.score) best.set(r.fen, r); }
    beam = [...best.values()].sort((a, b) => b.score - a.score).slice(0, BEAM);
  }
  const all = [...beam, ...finished].sort((a, b) => b.score - a.score || depth(b) - depth(a));
  const winner = all[0];

  // The winning reading, step by step, and for each step whether an equally good reading disagrees.
  const steps: Step[] = [];
  for (let s = winner?.last; s; s = s.prev) steps.unshift(s);
  const rivals = all.filter((r) => r !== winner && r.score === winner.score);
  const movesOf = (r: Reading) => { const m = new Map<number, string>(); for (let s = r.last; s; s = s.prev) m.set(s.ply, s.move.uci); return m; };
  const rivalMoves = rivals.map(movesOf);
  const plies: Ply[] = steps.map((s) => {
    const options = s.pool.map((m) => ({ uci: m.uci, san: sanOf(s.fen, m) }));
    let status: Ply["status"];
    if (s.kind === "chosen") status = "chosen";
    else if (s.kind === "near") status = "guessed";
    else if (s.pool.length === 1) status = s.sure ? "ok" : "ambiguous";
    else status = rivalMoves.some((m) => m.has(s.ply) && m.get(s.ply) !== s.move.uci) ? "ambiguous" : "inferred";
    return { index: s.ply, moveNumber: Math.floor(s.ply / 2) + 1, color: s.ply % 2 === 0 ? "white" : "black", fenBefore: s.fen, read: describe(halves[s.ply]), uci: s.move.uci, san: sanOf(s.fen, s.move), status, options };
  });
  let fen = winner?.fen ?? startFen;
  let unfinished = end < halves.length && halves.slice(end).some((h) => !h.blank);
  if (winner?.stuck) {
    const { ply, fen: at } = winner.stuck;
    const options = legalAt(at).map((m) => ({ uci: m.uci, san: sanOf(at, m) }));
    plies.push({ index: ply, moveNumber: Math.floor(ply / 2) + 1, color: ply % 2 === 0 ? "white" : "black", fenBefore: at, read: describe(halves[ply]), status: "unreadable", options });
    fen = at;
    unfinished = true;
  }
  return { plies, fen, unfinished };
}

const depth = (r: Reading) => (r.last ? r.last.ply + 1 : 0);

/** Squares as names, for messages. */
export const squareName = (sq: number) => makeSquare(sq);
