import { Chess } from "chessops/chess";
import { makeFen, parseFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import type { Role } from "chessops/types";
import { makeSquare, parseUci } from "chessops/util";
import { moveFromUci, type Color, type Score } from "./chess";
import type { Leaning, Personality } from "./personalities";
import { chances } from "./strength";
import { ChatEvent, line } from "./voices";

/**
 * What opponents notice and say during a game: your blunders and good moves,
 * their own mistakes, the opening, who is winning. Coaches also explain their
 * own moves and warn about threats. Everything here works from engine analyses
 * handed in by the game (play.ts), so it can be tested without an engine.
 */

/** An engine's view of a position: the score for the side to move, and its best line. */
export interface Analysis {
  score: Score;
  pv: string[];
}

const VALUE: Record<Role, number> = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };
export const PIECE_NAME: Record<Role, string> = { pawn: "pawn", knight: "knight", bishop: "bishop", rook: "rook", queen: "queen", king: "king" };

const position = (fen: string) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();

/** The facts about a move that comments are made from. */
export interface MoveFacts {
  san: string;
  role: Role;
  to: string;
  captured?: Role;
  check: boolean;
  castle: boolean;
  promotion: boolean;
}

export function factsOf(fen: string, uci: string): MoveFacts | undefined {
  const pos = position(fen);
  const m = moveFromUci(pos, uci);
  if (!m || !("from" in m)) return undefined;
  const piece = pos.board.get(m.from)!;
  const target = pos.board.get(m.to);
  const castle = piece.role === "king" && (Math.abs((m.from & 7) - (m.to & 7)) > 1 || (target?.color === piece.color && target.role === "rook"));
  const enPassant = piece.role === "pawn" && !target && (m.from & 7) !== (m.to & 7);
  const san = makeSan(pos, m);
  return {
    san, role: piece.role, to: makeSquare(m.to), castle, promotion: !!m.promotion,
    captured: castle ? undefined : enPassant ? "pawn" : target?.role, check: /[+#]$/.test(san),
  };
}

export function sanOf(fen: string, uci: string): string | undefined {
  const pos = position(fen);
  const m = moveFromUci(pos, uci);
  return m ? makeSan(pos, m) : undefined;
}

/**
 * What the side to move gains in material by following the line until the
 * exchanges settle (stopping after the other side's reply when the next move is
 * not a capture), and the most valuable piece it takes on the way.
 */
export function swing(fen: string, pv: string[]): { gain: number; took?: Role; square?: string } {
  const pos = position(fen);
  const me = pos.turn;
  let gain = 0;
  let took: Role | undefined, square: string | undefined;
  for (let i = 0; i < Math.min(pv.length, 8); i++) {
    const m = moveFromUci(pos, pv[i]);
    if (!m || !("from" in m)) break;
    const piece = pos.board.get(m.from)!;
    const target = pos.board.get(m.to);
    let victim = target && target.color !== piece.color ? target.role : undefined;
    if (!victim && piece.role === "pawn" && (m.from & 7) !== (m.to & 7)) victim = "pawn";
    if (victim) {
      const v = VALUE[victim] + (m.promotion ? VALUE[m.promotion] - 1 : 0);
      if (pos.turn === me) {
        gain += v;
        if (!took || VALUE[victim] > VALUE[took]) { took = victim; square = makeSquare(m.to); }
      } else gain -= v;
    } else if (m.promotion) gain += (pos.turn === me ? 1 : -1) * (VALUE[m.promotion] - 1);
    pos.play(m);
    // After the other side's reply, the material count stands if nothing is being taken next.
    if (pos.turn === me) {
      const next = pv[i + 1] ? parseUci(pv[i + 1]) : undefined;
      const nextTakes = next && "from" in next && pos.board.get(next.to) !== undefined && pos.board.get(next.to)!.color !== me;
      if (!nextTakes) return { gain, took, square };
    }
  }
  // The line ran out (or stopped making sense): count what was taken so far.
  return { gain, took, square };
}

/** Winning chances 0–100 for the given side, from an analysis of a position where `toMove` moves. */
const chancesFor = (a: Analysis, toMove: Color, side: Color) => (toMove === side ? chances(a.score) : 100 - chances(a.score));

/** A short reason why a move was bad, from the line that punishes it and the line that was better. */
export function reasonFor(fenBefore: string, before: Analysis | undefined, fenAfter: string, after: Analysis): string | undefined {
  // `after` is from the opponent's side: the opponent moves next.
  if ("mate" in after.score && after.score.mate > 0) {
    const reply = after.pv[0] && sanOf(fenAfter, after.pv[0]);
    return after.score.mate === 1 ? `it allows mate${reply ? ` with ${reply}` : ""}.` : `it allows a forced mate${reply ? `, starting with ${reply}` : ""}.`;
  }
  const loss = swing(fenAfter, after.pv);
  if (loss.gain >= 2 && loss.took) {
    const reply = sanOf(fenAfter, after.pv[0]);
    return loss.took === "pawn" ? `it loses a pawn${reply ? ` after ${reply}` : ""}.` : `your ${PIECE_NAME[loss.took]} on ${loss.square} is lost${reply ? ` after ${reply}` : ""}.`;
  }
  if (before) {
    if ("mate" in before.score && before.score.mate > 0) return `you had a forced mate.`;
    const win = swing(fenBefore, before.pv);
    if (win.gain >= 2 && win.took) return `${sanOf(fenBefore, before.pv[0])} wins ${win.took === "pawn" ? "a pawn" : `the ${PIECE_NAME[win.took]} on ${win.square}`}.`;
  }
  return undefined;
}

/** How good a move was: the winning chances it gave away, 0–100. */
export function lossOf(mover: Color, before: Analysis, after: Analysis): number {
  const opp: Color = mover === "white" ? "black" : "white";
  return Math.max(0, chancesFor(before, mover, mover) - chancesFor(after, opp, mover));
}

export interface ChatLine {
  text: string;
  /** Important lines are always said; the rest depend on how chatty the opponent is. */
  important: boolean;
}

export interface Hint {
  text: string;
  square: string;
  arrow?: [string, string];
}

/** The running commentary for one game. */
export class Commentator {
  private advantage: "even" | "winning" | "losing" = "even";
  private saidEndgame = false;
  private lastOpening = "";
  private openingsNamed = 0;
  private saidLeftBook = false;
  /** Set when the opponent's own last move threw away a lot: the best punishment. */
  private myBlunder?: { punish: string };

  constructor(readonly p: Personality, readonly me: Color, private random: () => number = Math.random) {}

  private say(event: ChatEvent, vars: Record<string, string> = {}, important = false): ChatLine | undefined {
    if (!important && this.random() > this.p.chattiness) return undefined;
    const text = line(this.p, event, vars, this.random);
    return text ? { text, important } : undefined;
  }

  hello(): ChatLine | undefined {
    return this.say("hello", {}, true);
  }

  /** The opening has a (new) name. Generic names ("King's Pawn Game") aren't worth a remark, and three is plenty. */
  opening(name: string): ChatLine | undefined {
    const family = name.split(":")[0];
    if (!name || family === this.lastOpening.split(":")[0] || /Pawn Game|Pawn Opening|Knight Opening|Zukertort|Van't Kruijs/.test(family) || this.openingsNamed >= 3) return undefined;
    this.lastOpening = name;
    this.openingsNamed++;
    return this.say("opening", { opening: family }, this.p.temperament === "coach");
  }

  /** You've left the course's lines. */
  offCourse(fen: string, expected: string): ChatLine | undefined {
    const san = sanOf(fen, expected);
    return san ? { text: `That's not the line we studied: the course plays ${san} here. Let's carry on from your move.`, important: true } : undefined;
  }

  /** The opponent has run out of opening book moves. */
  leftBook(): ChatLine | undefined {
    if (this.saidLeftBook) return undefined;
    this.saidLeftBook = true;
    return this.say("leftBook");
  }

  /**
   * The opponent's own move. `before` is the analysis of the position it moved
   * from, `after` of the position now (your move). Returns what it says.
   */
  ownMove(fenBefore: string, uci: string, fenAfter: string, before?: Analysis, after?: Analysis): ChatLine[] {
    const out: (ChatLine | undefined)[] = [];
    const facts = factsOf(fenBefore, uci);
    if (!facts) return [];
    this.myBlunder = undefined;
    if (before && after && lossOf(this.me, before, after) >= 20 && after.pv[0]) {
      this.myBlunder = { punish: after.pv[0] };
    }
    if (this.p.temperament === "coach") out.push(this.explain(fenBefore, facts, fenAfter, after));
    else if (facts.castle) out.push(this.say("castle"));
    else if (facts.promotion) out.push(this.say("promote", {}, true));
    else if (facts.captured && VALUE[facts.captured] >= 3) out.push(this.say("bigCapture", { piece: PIECE_NAME[facts.captured] }));
    else if (facts.check) out.push(this.say("check"));
    if (after) out.push(this.standing(fenAfter, after, this.me === "white" ? "black" : "white"));
    return out.filter((l): l is ChatLine => !!l);
  }

  /** A coach says why it played its move, and warns about what it threatens. */
  private explain(fenBefore: string, f: MoveFacts, fenAfter: string, after?: Analysis): ChatLine | undefined {
    const ply = (parseInt(fenBefore.split(" ")[5], 10) - 1) * 2 + (fenBefore.split(" ")[1] === "b" ? 1 : 0);
    let text: string | undefined;
    if (f.castle) text = line(this.p, "castle", {}, this.random);
    else if (f.promotion) text = line(this.p, "promote", {}, this.random);
    else if (f.captured) text = f.captured === "pawn" ? `${f.san}: I'm taking a pawn.` : `${f.san}: I'm taking your ${PIECE_NAME[f.captured]}.`;
    else if (f.check) text = `${f.san}, check. ${line(this.p, "check", {}, this.random) ?? ""}`.trim();
    else if (ply < 20 && (f.role === "knight" || f.role === "bishop") && /[18]$/.test(fenSquareRank(fenBefore, f))) text = `${f.san}: developing my ${PIECE_NAME[f.role]} towards the centre.`;
    else if (ply < 16 && f.role === "pawn" && /^[cdef][45]$/.test(f.to)) text = `${f.san}: a pawn in the centre, to claim space.`;
    // A threat: what I'd take next if you don't react.
    if (after && after.pv.length >= 2) {
      const pos = position(fenAfter);
      // The analysis is from your side; skip your best reply to see my follow-up. Only warn when the threat is real.
      const threat = swing(fenAfterMove(fenAfter, after.pv[0]), after.pv.slice(1));
      if (threat.gain >= 3 && threat.took && pos.board.get(parseSquareSafe(threat.square))?.color !== this.me) {
        const warn = `Watch out: I'm threatening your ${PIECE_NAME[threat.took]} on ${threat.square}.`;
        text = text ? `${text} ${warn}` : warn;
      }
    }
    if (!text && this.random() < this.p.chattiness * 0.3) text = line(this.p, "idle", {}, this.random);
    return text ? { text, important: false } : undefined;
  }

  /**
   * Your move. `before` is the analysis of the position you moved from (your
   * best move and score), `after` of the position after it (the opponent's view).
   */
  yourMove(fenBefore: string, uci: string, fenAfter: string, before: Analysis | undefined, after: Analysis | undefined): ChatLine[] {
    const out: (ChatLine | undefined)[] = [];
    const you: Color = this.me === "white" ? "black" : "white";
    const blunder = this.myBlunder;
    this.myBlunder = undefined;
    if (before && after) {
      const loss = lossOf(you, before, after);
      const best = before.pv[0] && before.pv[0] !== uci ? sanOf(fenBefore, before.pv[0]) : undefined;
      const why = reasonFor(fenBefore, before, fenAfter, after) ?? "";
      const vars = { san: sanOf(fenBefore, uci) ?? "", best: best ?? "", why: capitalise(why), reply: after.pv[0] ? sanOf(fenAfter, after.pv[0]) ?? "" : "" };
      const lost = swing(fenAfter, after.pv);
      if (lost.took) Object.assign(vars, { piece: PIECE_NAME[lost.took] });
      if (blunder) {
        // Did you punish the opponent's mistake?
        if (blunder.punish === uci || loss < 5) out.push(this.say("iBlundered", vars, true));
        else out.push(this.say("letOff", { ...vars, best: sanOf(fenBefore, blunder.punish) ?? best ?? "" }, this.p.temperament === "coach"));
      } else if (best && loss >= 20 && "mate" in before.score && before.score.mate > 0) out.push(this.say("youMissed", vars, true));
      else if (loss >= 20) out.push(this.say("youBlunder", vars, true));
      else if (loss >= 9 && best) {
        const missedWin = swing(fenBefore, before.pv);
        out.push(missedWin.gain >= 3 ? this.say("youMissed", vars, true) : this.say("youMistake", vars, this.p.temperament === "coach"));
      } else if (!best && loss < 2 && (before.pv[0] === uci) && (swing(fenBefore, before.pv).gain >= 3 || ("mate" in before.score && before.score.mate > 0))) {
        out.push(this.say("youGood", vars, true));
      }
      out.push(this.standing(fenAfter, after, this.me));
    }
    return out.filter((l): l is ChatLine => !!l);
  }

  /** Who's winning, said once each time it changes, and the endgame when it comes. */
  private standing(fen: string, a: Analysis, toMove: Color): ChatLine | undefined {
    const mine = chancesFor(a, toMove, this.me);
    let event: ChatEvent | undefined;
    if (mine >= 85 && this.advantage !== "winning") { this.advantage = "winning"; event = "winning"; }
    else if (mine <= 15 && this.advantage !== "losing") { this.advantage = "losing"; event = "losing"; }
    else if (mine > 30 && mine < 70) this.advantage = "even";
    if (event) return this.say(event, {}, this.p.temperament === "coach");
    if (!this.saidEndgame && isEndgame(fen)) { this.saidEndgame = true; return this.say("endgame", {}, this.p.temperament === "coach"); }
    return undefined;
  }

  /** The end of the game, from the opponent's side. */
  end(result: "1-0" | "0-1" | "1/2-1/2"): ChatLine | undefined {
    const event: ChatEvent = result === "1/2-1/2" ? "draw" : (result === "1-0") === (this.me === "white") ? "win" : "loss";
    return this.say(event, {}, true);
  }

  takeback(): ChatLine | undefined {
    this.myBlunder = undefined;
    return this.say("takeback", {}, true);
  }

  /** A hint for your move, from the analysis of the position: first which piece, then the move. */
  hint(fen: string, a: Analysis, level: 1 | 2): Hint | undefined {
    const uci = a.pv[0];
    const facts = uci && factsOf(fen, uci);
    if (!facts) return undefined;
    const from = uci.slice(0, 2), to = uci.slice(2, 4);
    if (level === 1) {
      const idea = facts.check ? " Look for a check." : facts.captured ? " Is there something to take?" : "";
      return { text: `Look at your ${PIECE_NAME[facts.role]} on ${from}.${idea}`, square: from };
    }
    return { text: `I'd play ${facts.san}.`, square: from, arrow: [from, to] };
  }
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function fenAfterMove(fen: string, uci: string): string {
  const pos = position(fen);
  const m = moveFromUci(pos, uci);
  if (m) pos.play(m);
  return makeFen(pos.toSetup());
}

function parseSquareSafe(sq?: string): number {
  if (!sq) return -1;
  return (sq.charCodeAt(0) - 97) + (Number(sq[1]) - 1) * 8;
}

/** The rank a moved piece started on, to tell development from shuffling. */
function fenSquareRank(fenBefore: string, f: MoveFacts): string {
  const pos = position(fenBefore);
  for (const [sq, piece] of pos.board) {
    if (piece.role !== f.role || piece.color !== pos.turn) continue;
    const name = makeSquare(sq);
    const m = parseUci(name + f.to);
    if (m && pos.isLegal(m) && makeSan(pos, m) === f.san) return name;
  }
  return "";
}

/** No queens, or few pieces left besides kings and pawns. */
export function isEndgame(fen: string): boolean {
  const board = fen.split(" ")[0];
  const pieces = board.replace(/[^nbrqNBRQ]/g, "");
  const weight = [...pieces].reduce((a, c) => a + VALUE[({ n: "knight", b: "bishop", r: "rook", q: "queen" } as const)[c.toLowerCase() as "n"]], 0);
  return weight <= 13 || (!/q/i.test(board) && weight <= 20);
}

/**
 * How much an opponent's leanings (Personality.leaning) favour each move in a
 * position, in winning-chance points. `human` is the move a human-like network
 * (Maia) would play, which gets a nudge of its own.
 */
export function styleBonus(leaning: Leaning | undefined, fen: string, human?: string): (uci: string) => number {
  const pos = position(fen);
  const ply = (parseInt(fen.split(" ")[5], 10) - 1) * 2 + (pos.turn === "black" ? 1 : 0);
  const theirKing = pos.board.kingOf(pos.turn === "white" ? "black" : "white");
  return (uci) => {
    let b = uci === human ? 4 : 0;
    if (!leaning) return b;
    const m = moveFromUci(pos, uci);
    if (!m || !("from" in m)) return b;
    const piece = pos.board.get(m.from);
    const target = pos.board.get(m.to);
    if (!piece) return b;
    const capture = !!target && target.color !== piece.color;
    const after = pos.clone();
    after.play(m);
    const check = after.isCheck();
    if (check) b += leaning.checks ?? 0;
    if (capture) b += leaning.captures ?? 0;
    if (capture && VALUE[target!.role] === VALUE[piece.role] && piece.role !== "pawn") b += leaning.trades ?? 0;
    if (!capture && !check) b += leaning.quiet ?? 0;
    if (piece.role === "queen" && ply < 20) b += leaning.earlyQueen ?? 0;
    if (piece.role === "pawn" && theirKing !== undefined && Math.abs((m.to & 7) - (theirKing & 7)) <= 1 && Math.abs((m.to >> 3) - (theirKing >> 3)) < Math.abs((m.from >> 3) - (theirKing >> 3))) b += leaning.storms ?? 0;
    return b;
  };
}
