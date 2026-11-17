import { Position } from "chessops/chess";
import type { Move, Role } from "chessops/types";
import { makeUci } from "chessops/util";
import { positionAfter, startFen, Variant, variantOf } from "./chess.js";
import { cleanName, fail, Handler, json, Row, sql, timeOf } from "./db.js";
import { applyMove, freshCode, startMs, verified } from "./game.js";
import { categoryOf, ratingIn } from "./ratings.js";
import { randomId } from "./token.js";

/**
 * Bots: small engines that run on the server, so they work in the web version
 * too, with no local engine. They are named after Castle's personalities,
 * marked as bots everywhere, and their games are never rated. Strength comes
 * from search depth, a time budget and a little deliberate randomness.
 */
export interface Bot { id: string; name: string; about: number; style: string; depth: number; ms: number; noise: number; blunder: number }
export const BOTS: Bot[] = [
  { id: "pip", name: "Pip", about: 600, style: "Beginner", depth: 1, ms: 200, noise: 220, blunder: 0.25 },
  { id: "nora", name: "Nora", about: 900, style: "Careful newcomer", depth: 1, ms: 300, noise: 90, blunder: 0.08 },
  { id: "viktor", name: "Viktor", about: 1100, style: "Gambiteer", depth: 2, ms: 400, noise: 60, blunder: 0.04 },
  { id: "amara", name: "Amara", about: 1300, style: "Solid", depth: 2, ms: 500, noise: 25, blunder: 0 },
  { id: "dmitri", name: "Dmitri", about: 1500, style: "Attacker", depth: 3, ms: 900, noise: 12, blunder: 0 },
  { id: "ingrid", name: "Ingrid", about: 1700, style: "Positional", depth: 4, ms: 1400, noise: 0, blunder: 0 },
];
export const botOf = (guest: unknown) => (typeof guest === "string" && guest.startsWith("bot:") ? BOTS.find((b) => `bot:${b.id}` === guest) : undefined);

const VALUE: Record<Role, number> = { pawn: 100, knight: 320, bishop: 330, rook: 500, queen: 900, king: 0 };
// Piece-square tables from White's side, rank 8 first (the usual simplified ones).
const PST: Partial<Record<Role, number[]>> = {
  pawn: [0, 0, 0, 0, 0, 0, 0, 0, 50, 50, 50, 50, 50, 50, 50, 50, 10, 10, 20, 30, 30, 20, 10, 10, 5, 5, 10, 25, 25, 10, 5, 5, 0, 0, 0, 20, 20, 0, 0, 0, 5, -5, -10, 0, 0, -10, -5, 5, 5, 10, 10, -20, -20, 10, 10, 5, 0, 0, 0, 0, 0, 0, 0, 0],
  knight: [-50, -40, -30, -30, -30, -30, -40, -50, -40, -20, 0, 0, 0, 0, -20, -40, -30, 0, 10, 15, 15, 10, 0, -30, -30, 5, 15, 20, 20, 15, 5, -30, -30, 0, 15, 20, 20, 15, 0, -30, -30, 5, 10, 15, 15, 10, 5, -30, -40, -20, 0, 5, 5, 0, -20, -40, -50, -40, -30, -30, -30, -30, -40, -50],
  bishop: [-20, -10, -10, -10, -10, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 10, 10, 5, 0, -10, -10, 5, 5, 10, 10, 5, 5, -10, -10, 0, 10, 10, 10, 10, 0, -10, -10, 10, 10, 10, 10, 10, 10, -10, -10, 5, 0, 0, 0, 0, 5, -10, -20, -10, -10, -10, -10, -10, -10, -20],
  rook: [0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 10, 10, 10, 10, 10, 5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, -5, 0, 0, 0, 0, 0, 0, -5, 0, 0, 0, 5, 5, 0, 0, 0],
  queen: [-20, -10, -10, -5, -5, -10, -10, -20, -10, 0, 0, 0, 0, 0, 0, -10, -10, 0, 5, 5, 5, 5, 0, -10, -5, 0, 5, 5, 5, 5, 0, -5, 0, 0, 5, 5, 5, 5, 0, -5, -10, 5, 5, 5, 5, 5, 0, -10, -10, 0, 5, 0, 0, 0, 0, -10, -20, -10, -10, -5, -5, -10, -10, -20],
  king: [-30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -30, -40, -40, -50, -50, -40, -40, -30, -20, -30, -30, -40, -40, -30, -30, -20, -10, -20, -20, -20, -20, -20, -20, -10, 20, 20, 0, 0, 0, 0, 20, 20, 20, 30, 10, 0, 0, 10, 30, 20],
};
const MATE = 100_000;

/** Material and placement, from the side to move. */
function evaluate(pos: Position): number {
  let score = 0;
  for (const [sq, piece] of pos.board) {
    const rank = sq >> 3, file = sq & 7;
    const idx = piece.color === "white" ? (7 - rank) * 8 + file : rank * 8 + file;
    const v = VALUE[piece.role] + (PST[piece.role]?.[idx] ?? 0);
    score += piece.color === "white" ? v : -v;
  }
  return pos.turn === "white" ? score : -score;
}

function legalMoves(pos: Position): Move[] {
  const out: Move[] = [];
  for (const [from, dests] of pos.allDests()) {
    const piece = pos.board.get(from);
    for (const to of dests) {
      const last = (to >> 3) === (pos.turn === "white" ? 7 : 0);
      if (piece?.role === "pawn" && last) { out.push({ from, to, promotion: "queen" }); out.push({ from, to, promotion: "knight" }); }
      else out.push({ from, to });
    }
  }
  return out;
}

/** Captures (most valuable victim first) and promotions before quiet moves. */
function ordered(pos: Position, moves: Move[]): Move[] {
  const weight = (m: Move) => {
    if (!("from" in m)) return 0;
    const victim = pos.board.get(m.to);
    const own = victim && victim.color === pos.turn; // castling: the king "takes" its own rook
    return (victim && !own ? 10 * VALUE[victim.role] - VALUE[pos.board.get(m.from)!.role] / 10 : 0) + (m.promotion === "queen" ? 800 : 0);
  };
  return moves.map((m) => [m, weight(m)] as const).sort((a, b) => b[1] - a[1]).map(([m]) => m);
}

class Timeout extends Error {}

function search(pos: Position, depth: number, alpha: number, beta: number, ply: number, deadline: number): number {
  if (Date.now() > deadline) throw new Timeout();
  if (depth <= 0) return quiesce(pos, alpha, beta, 4, deadline);
  const moves = legalMoves(pos);
  if (!moves.length) return pos.isCheck() ? -MATE + ply : 0;
  for (const m of ordered(pos, moves)) {
    const child = pos.clone();
    child.play(m);
    const s = -search(child, depth - 1, -beta, -alpha, ply + 1, deadline);
    if (s >= beta) return beta;
    if (s > alpha) alpha = s;
  }
  return alpha;
}

function quiesce(pos: Position, alpha: number, beta: number, left: number, deadline: number): number {
  const stand = evaluate(pos);
  if (stand >= beta) return beta;
  if (stand > alpha) alpha = stand;
  if (left <= 0) return alpha;
  for (const m of ordered(pos, legalMoves(pos))) {
    if (!("from" in m)) continue;
    const victim = pos.board.get(m.to);
    if (!victim || victim.color === pos.turn) continue;
    const child = pos.clone();
    child.play(m);
    const s = -quiesce(child, -beta, -alpha, left - 1, deadline);
    if (s >= beta) return beta;
    if (s > alpha) alpha = s;
  }
  return alpha;
}

/** The bot's move: iterative deepening within its time, then its share of randomness. */
export function chooseMove(pos: Position, bot: Bot): Move | undefined {
  const moves = legalMoves(pos);
  if (!moves.length) return undefined;
  if (bot.blunder && Math.random() < bot.blunder) return moves[Math.floor(Math.random() * moves.length)];
  const deadline = Date.now() + bot.ms;
  let scored = moves.map((m) => ({ m, s: 0 }));
  for (let depth = 1; depth <= bot.depth; depth++) {
    try {
      const next = ordered(pos, moves).map((m) => {
        const child = pos.clone();
        child.play(m);
        return { m, s: -search(child, depth - 1, -MATE, MATE, 1, deadline) };
      });
      scored = next;
    } catch (e) {
      if (!(e instanceof Timeout)) throw e;
      break;
    }
  }
  const noisy = scored.map((x) => ({ m: x.m, s: x.s + (bot.noise ? (Math.random() - 0.5) * 2 * bot.noise : 0) }));
  return noisy.sort((a, b) => b.s - a.s)[0].m;
}

/** UCI for a bot's move; standard chess writes castling as the king's two-square move. */
function uciFor(pos: Position, m: Move, chess960: boolean): string {
  if (!chess960 && "from" in m) {
    const piece = pos.board.get(m.from), target = pos.board.get(m.to);
    if (piece?.role === "king" && target?.role === "rook" && target.color === piece.color) {
      const kingTo = (m.to > m.from ? 6 : 2) + (m.from & ~7);
      return makeUci({ from: m.from, to: kingTo });
    }
  }
  return makeUci(m);
}

/** Plays the bot's move in a game where it's the bot's turn. */
export async function botReply(g: Row): Promise<Row> {
  const color = g.ply % 2 === 0 ? "white" : "black";
  const bot = botOf(g[`${color}_guest`]);
  if (!bot || g.status !== "playing") return g;
  const variant = variantOf(g.variant);
  const pos = positionAfter(g.moves ? g.moves.split(" ") : [], variant, g.initial_fen);
  const m = chooseMove(pos, bot);
  if (!m) return g;
  return (await applyMove(g, color, uciFor(pos, m, variant === "chess960"))) ?? g;
}

export const botRoutes: Record<string, Handler> = {
  "GET bots": async () => json({ bots: BOTS.map(({ id, name, about, style }) => ({ id, name, about, style })) }),

  /** A casual game against a bot, starting at once. */
  "POST bot/play": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const bot = BOTS.find((x) => x.id === b.bot);
    if (!bot) return fail("No such bot.", 404);
    const variant: Variant = b.variant === "chess960" ? "chess960" : "chess";
    const { minutes, increment } = timeOf(b);
    const human = b.color === "white" || b.color === "black" ? b.color : Math.random() < 0.5 ? "white" : "black";
    const id = randomId(), key = randomId(18), code = await freshCode();
    const fen = variant === "chess" ? null : startFen(variant);
    const ms = startMs({ minutes });
    const name = cleanName(b.name), botName = `${bot.name} (bot)`;
    const rating = ratingIn(p, categoryOf(variant, minutes, increment));
    const seats = human === "white"
      ? { wg: p.id, wn: name, wk: key, wr: rating, bg: `bot:${bot.id}`, bn: botName, bk: null, br: bot.about }
      : { wg: `bot:${bot.id}`, wn: botName, wk: null, wr: bot.about, bg: p.id, bn: name, bk: key, br: rating };
    await sql`insert into games (id, code, status, public, rated, minutes, increment, creator_color, variant, initial_fen, category,
        white_guest, white_name, white_key, white_rating, black_guest, black_name, black_key, black_rating, white_ms, black_ms)
      values (${id}, ${code}, 'playing', false, false, ${minutes}, ${increment}, ${human}, ${variant}, ${fen}, ${categoryOf(variant, minutes, increment)},
        ${seats.wg}, ${seats.wn}, ${seats.wk}, ${seats.wr}, ${seats.bg}, ${seats.bn}, ${seats.bk}, ${seats.br}, ${ms}, ${ms})`;
    if (human === "black") await botReply((await sql`select * from games where id = ${id}`)[0]);
    return json({ id, code, color: human, key });
  },
};

