import { castlingSide, Position } from "chessops/chess";
import { chessgroundDests } from "chessops/compat";
import { makeFen, parseFen } from "chessops/fen";
import {
  ChildNode,
  defaultGame,
  Game as PgnGame,
  makeComment,
  makePgn,
  Node as PgnNode,
  parseComment,
  parsePgn,
  PgnNodeData,
} from "chessops/pgn";
import { makeSan, parseSan } from "chessops/san";
import { Move, Rules, isDrop } from "chessops/types";
import { makeSquare, makeUci, parseSquare, parseUci, kingCastlesTo } from "chessops/util";
import { defaultPosition, setupPosition } from "chessops/variant";

export type Color = "white" | "black";
export type ShapeColor = "green" | "red" | "blue" | "yellow";
export interface Shape {
  from: string;
  to: string;
  color: ShapeColor;
}
/** An evaluation from White's point of view. */
export type Score = { cp: number } | { mate: number };

export const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export const VARIANTS: { rules: Rules; name: string; uci: string }[] = [
  { rules: "chess", name: "Standard", uci: "chess" },
  { rules: "crazyhouse", name: "Crazyhouse", uci: "crazyhouse" },
  { rules: "atomic", name: "Atomic", uci: "atomic" },
  { rules: "kingofthehill", name: "King of the Hill", uci: "kingofthehill" },
  { rules: "3check", name: "Three-check", uci: "3check" },
  { rules: "antichess", name: "Antichess", uci: "antichess" },
  { rules: "horde", name: "Horde", uci: "horde" },
  { rules: "racingkings", name: "Racing Kings", uci: "racingkings" },
];

export const variantName = (rules: Rules, chess960 = false) =>
  chess960 ? "Chess960" : (VARIANTS.find((v) => v.rules === rules)?.name ?? "Standard");

const cache = new Map<string, Position>();

/** The position for a FEN under the given rules. Throws on an illegal position. */
export function positionOf(fen: string, rules: Rules = "chess"): Position {
  const key = rules + fen;
  let pos = cache.get(key);
  if (!pos) {
    pos = setupPosition(rules, parseFen(fen).unwrap()).unwrap();
    if (cache.size > 4000) cache.clear();
    cache.set(key, pos);
  }
  return pos;
}

export function tryPosition(fen: string, rules: Rules = "chess"): Position | undefined {
  try {
    return positionOf(fen, rules);
  } catch {
    return undefined;
  }
}

export const fenOf = (pos: Position) => makeFen(pos.toSetup());
export const epdOf = (fen: string) => fen.split(" ").slice(0, 4).join(" ");
export const turnOf = (fen: string): Color => (fen.split(" ")[1] === "b" ? "black" : "white");
export const fullmoveOf = (fen: string) => parseInt(fen.split(" ")[5] ?? "1", 10) || 1;
export const pieceCount = (fen: string) => fen.split(" ")[0].replace(/[^a-zA-Z]/g, "").length;

/** UCI text for a move. Standard chess writes castling as the king's own move. */
export function uciOf(pos: Position, move: Move, chess960: boolean): string {
  if (!chess960 && !isDrop(move)) {
    const side = castlingSide(pos, move);
    if (side) return makeSquare(move.from) + makeSquare(kingCastlesTo(pos.turn, side));
  }
  return makeUci(move);
}

/** Resolves UCI text (either castling style) to a legal move. */
export function moveFromUci(pos: Position, uci: string): Move | undefined {
  const raw = parseUci(uci);
  if (!raw) return undefined;
  if (pos.isLegal(raw)) return raw;
  if (!isDrop(raw)) {
    // King moving two files: translate to king-takes-rook.
    const piece = pos.board.get(raw.from);
    if (piece?.role === "king") {
      for (const side of ["a", "h"] as const) {
        const rook = pos.castles.rook[pos.turn][side];
        if (rook !== undefined && kingCastlesTo(pos.turn, side) === raw.to) {
          const m = { from: raw.from, to: rook };
          if (pos.isLegal(m)) return m;
        }
      }
    }
  }
  return undefined;
}

export const destsOf = (pos: Position, chess960: boolean) => chessgroundDests(pos, { chess960 }) as Map<string, string[]>;

/** Numbered SAN text for a line of UCI moves. */
export function sanLine(fen: string, ucis: string[], rules: Rules = "chess", limit = 14): string {
  const pos = tryPosition(fen, rules)?.clone();
  if (!pos) return ucis.slice(0, limit).join(" ");
  const parts: string[] = [];
  ucis.slice(0, limit).every((u, i) => {
    const m = moveFromUci(pos, u);
    if (!m) return false;
    if (pos.turn === "white") parts.push(`${pos.fullmoves}.`);
    else if (i === 0) parts.push(`${pos.fullmoves}…`);
    parts.push(makeSan(pos, m));
    pos.play(m);
    return true;
  });
  return parts.join(" ");
}

export const NAGS: Record<number, string> = { 1: "!", 2: "?", 3: "!!", 4: "??", 5: "!?", 6: "?!" };

let nextId = 1;

export class GNode {
  id = nextId++;
  parent?: GNode;
  children: GNode[] = [];
  uci?: string;
  san = "";
  fen: string;
  comment = "";
  nag?: number;
  eval?: Score;
  best?: string;
  clock?: number;
  shapes: Shape[] = [];

  constructor(fen: string, parent?: GNode) {
    this.fen = fen;
    this.parent = parent;
  }

  get turn(): Color {
    return turnOf(this.fen);
  }

  /** "12." or "12…" for the move that led here. */
  get numberLabel(): string {
    if (!this.parent) return "";
    const n = fullmoveOf(this.parent.fen);
    return this.parent.turn === "white" ? `${n}.` : `${n}…`;
  }

  get isMainline(): boolean {
    let n: GNode = this;
    while (n.parent) {
      if (n.parent.children[0] !== n) return false;
      n = n.parent;
    }
    return true;
  }

  get lastMove(): [string, string] | undefined {
    if (!this.uci) return undefined;
    if (this.uci[1] === "@") return [this.uci.slice(2, 4), this.uci.slice(2, 4)];
    return [this.uci.slice(0, 2), this.uci.slice(2, 4)];
  }
}

export type Outcome = { result: "1-0" | "0-1" | "1/2-1/2"; reason: string };

export class GameTree {
  id = nextId++;
  headers = new Map<string, string>();
  root: GNode;
  current: GNode;
  rules: Rules;
  chess960: boolean;
  revision = 0;
  private listeners = new Set<() => void>();

  constructor(fen: string = START_FEN, rules: Rules = "chess", chess960 = false) {
    this.rules = rules;
    this.chess960 = chess960;
    this.root = new GNode(fen);
    this.current = this.root;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
    for (const [k, v] of [["Event", "Casual game"], ["Site", "Castle"], ["Date", today], ["Round", "-"], ["White", "White"], ["Black", "Black"], ["Result", "*"]]) {
      this.headers.set(k, v);
    }
    this.syncSetupHeaders();
  }

  static variantStart(rules: Rules): GameTree {
    return new GameTree(fenOf(defaultPosition(rules)), rules);
  }

  private syncSetupHeaders() {
    const std = this.rules === "chess" && !this.chess960;
    if (!std) this.headers.set("Variant", variantName(this.rules, this.chess960));
    if (this.root.fen !== START_FEN) {
      this.headers.set("SetUp", "1");
      this.headers.set("FEN", this.root.fen);
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  /** Call after any change so views re-render. */
  touch() {
    this.revision++;
    this.listeners.forEach((fn) => fn());
  }

  get fen() {
    return this.current.fen;
  }
  get pos() {
    return positionOf(this.current.fen, this.rules);
  }
  posAt(node: GNode) {
    return positionOf(node.fen, this.rules);
  }
  get isStandardStart() {
    return this.rules === "chess" && !this.chess960 && this.root.fen === START_FEN;
  }
  tag(name: string, fallback = "") {
    return this.headers.get(name) ?? fallback;
  }
  get result() {
    return this.headers.get("Result") ?? "*";
  }
  set result(r: string) {
    this.headers.set("Result", r);
    this.touch();
  }

  /** Adds a child without moving `current`. Returns undefined for an illegal move. */
  append(parent: GNode, move: Move): GNode | undefined {
    const pos = this.posAt(parent);
    if (!pos.isLegal(move)) return undefined;
    const uci = uciOf(pos, move, this.chess960);
    const existing = parent.children.find((c) => c.uci === uci);
    if (existing) return existing;
    const san = makeSan(pos, move);
    const next = pos.clone();
    next.play(move);
    const node = new GNode(fenOf(next), parent);
    node.uci = uci;
    node.san = san;
    parent.children.push(node);
    return node;
  }

  play(move: Move | string): GNode | undefined {
    const m = typeof move === "string" ? moveFromUci(this.pos, move) : move;
    if (!m) return undefined;
    const node = this.append(this.current, m);
    if (node) {
      this.current = node;
      this.touch();
    }
    return node;
  }

  playSan(san: string): GNode | undefined {
    const m = parseSan(this.pos, san);
    return m ? this.play(m) : undefined;
  }

  delete(node: GNode) {
    const parent = node.parent;
    if (!parent) return;
    for (let n: GNode | undefined = this.current; n; n = n.parent) {
      if (n === node) {
        this.current = parent;
        break;
      }
    }
    parent.children = parent.children.filter((c) => c !== node);
    this.touch();
  }

  promote(node: GNode) {
    for (let n = node; n.parent; n = n.parent) {
      const i = n.parent.children.indexOf(n);
      if (i > 0) {
        n.parent.children.splice(i, 1);
        n.parent.children.unshift(n);
        break;
      }
    }
    this.touch();
  }

  go(node: GNode) {
    if (this.current !== node) {
      this.current = node;
      this.touch();
    }
  }
  back() {
    if (this.current.parent) this.go(this.current.parent);
  }
  forward() {
    if (this.current.children[0]) this.go(this.current.children[0]);
  }
  toStart() {
    this.go(this.root);
  }
  toEnd() {
    this.go(this.last);
  }

  get mainline(): GNode[] {
    const out: GNode[] = [];
    for (let n = this.root.children[0]; n; n = n.children[0]) out.push(n);
    return out;
  }
  get last(): GNode {
    let n = this.root;
    while (n.children[0]) n = n.children[0];
    return n;
  }
  path(node: GNode): GNode[] {
    const out: GNode[] = [];
    for (let n: GNode | undefined = node; n && n.parent; n = n.parent) out.unshift(n);
    return out;
  }

  /** The UCI `position` command describing the route to a node. */
  positionCommand(node: GNode = this.current): string {
    const moves = this.path(node).map((n) => n.uci);
    const base = this.isStandardStart ? "position startpos" : `position fen ${this.root.fen}`;
    return moves.length ? `${base} moves ${moves.join(" ")}` : base;
  }

  outcome(node: GNode = this.current): Outcome | undefined {
    const pos = this.posAt(node);
    const o = pos.outcome();
    if (o) {
      if (!o.winner) return { result: "1/2-1/2", reason: pos.isStalemate() ? "Stalemate" : pos.isInsufficientMaterial() ? "Insufficient material" : "Draw" };
      const reason = pos.isCheckmate() ? "Checkmate" : `${variantName(this.rules)} win`;
      return { result: o.winner === "white" ? "1-0" : "0-1", reason };
    }
    if (pos.halfmoves >= 100) return { result: "1/2-1/2", reason: "Fifty-move rule" };
    const key = epdOf(node.fen);
    let seen = 1;
    for (let n = node.parent; n; n = n.parent) if (epdOf(n.fen) === key) seen++;
    return seen >= 3 ? { result: "1/2-1/2", reason: "Threefold repetition" } : undefined;
  }

  toggleShape(node: GNode, shape: Shape) {
    const i = node.shapes.findIndex((s) => s.from === shape.from && s.to === shape.to);
    if (i >= 0) {
      const same = node.shapes[i].color === shape.color;
      node.shapes.splice(i, 1);
      if (same) return this.touch();
    }
    node.shapes.push(shape);
    this.touch();
  }

  // MARK: PGN

  static fromPgnGame(game: PgnGame<PgnNodeData>): GameTree {
    const variant = game.headers.get("Variant") ?? "";
    const chess960 = /960|fischer/i.test(variant);
    const rules: Rules = chess960 ? "chess" : (VARIANTS.find((v) => v.name.toLowerCase() === variant.toLowerCase() || v.uci === variant.toLowerCase())?.rules ?? "chess");
    let fen = game.headers.get("FEN") ?? fenOf(defaultPosition(rules));
    if (!tryPosition(fen, rules)) fen = fenOf(defaultPosition(rules));
    const tree = new GameTree(fen, rules, chess960);
    tree.headers = new Map(game.headers);
    if (!tree.headers.has("Result")) tree.headers.set("Result", "*");
    const applyComments = (node: GNode, comments?: string[]) => {
      for (const raw of comments ?? []) {
        const c = parseComment(raw);
        if (c.text) node.comment = node.comment ? `${node.comment} ${c.text}` : c.text;
        if (c.clock !== undefined) node.clock = c.clock;
        if (c.evaluation) node.eval = "mate" in c.evaluation ? { mate: c.evaluation.mate } : { cp: Math.round(c.evaluation.pawns * 100) };
        for (const s of c.shapes) node.shapes.push({ from: makeSquare(s.from), to: makeSquare(s.to), color: s.color });
      }
    };
    applyComments(tree.root, game.comments);
    const walk = (from: PgnNode<PgnNodeData>, into: GNode) => {
      for (const child of from.children) {
        const move = parseSan(tree.posAt(into), child.data.san);
        if (!move) continue;
        const node = tree.append(into, move);
        if (!node) continue;
        const nag = child.data.nags?.find((n) => n >= 1 && n <= 6);
        if (nag) node.nag = nag;
        applyComments(node, child.data.comments);
        walk(child, node);
      }
    };
    // Iterative on the main line so very long games cannot overflow the stack.
    walk(game.moves, tree.root);
    return tree;
  }

  static fromPgn(text: string): GameTree | undefined {
    const games = parsePgn(text);
    return games.length ? GameTree.fromPgnGame(games[0]) : undefined;
  }

  toPgn(): string {
    const game = defaultGame<PgnNodeData>(() => new Map(this.headers));
    const comment = (n: GNode) =>
      makeComment({
        text: n.comment || undefined,
        shapes: n.shapes.map((s) => ({ color: s.color, from: parseSquare(s.from)!, to: parseSquare(s.to)! })),
        clock: n.clock,
        evaluation: n.eval ? ("mate" in n.eval ? { mate: n.eval.mate } : { pawns: n.eval.cp / 100 }) : undefined,
      });
    const rootComment = comment(this.root);
    if (rootComment) game.comments = [rootComment];
    const build = (from: GNode, into: PgnNode<PgnNodeData>) => {
      for (const child of from.children) {
        const text = comment(child);
        const node = new ChildNode<PgnNodeData>({
          san: child.san,
          nags: child.nag ? [child.nag] : undefined,
          comments: text ? [text] : undefined,
        });
        into.children.push(node);
        build(child, node);
      }
    };
    build(this.root, game.moves);
    return makePgn(game);
  }

  clone(): GameTree {
    return GameTree.fromPgn(this.toPgn()) ?? new GameTree();
  }
}

/** Splits a PGN file into the text of each game. */
export function splitPgn(text: string): string[] {
  const games: string[] = [];
  let current: string[] = [];
  let sawMoves = false;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    const isTag = t.startsWith("[") && t.endsWith("]");
    if (isTag && sawMoves) {
      games.push(current.join("\n").trim());
      current = [];
      sawMoves = false;
    }
    if (!isTag && t) sawMoves = true;
    current.push(line);
  }
  const rest = current.join("\n").trim();
  if (rest) games.push(rest);
  return games;
}

// MARK: Scores

export const negate = (s: Score): Score => ("mate" in s ? { mate: -s.mate } : { cp: -s.cp });

/** White's winning chances, 0 to 100. */
export function winPercent(s: Score): number {
  if ("mate" in s) return s.mate > 0 ? 100 : 0;
  const c = Math.max(-2000, Math.min(2000, s.cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function scoreText(s: Score): string {
  if ("mate" in s) return s.mate > 0 ? `#${s.mate}` : `#-${-s.mate}`;
  if (Math.abs(s.cp) >= 90000) return s.cp > 0 ? "1-0" : "0-1";
  return (s.cp >= 0 ? "+" : "") + (s.cp / 100).toFixed(2);
}

export function scoreShort(s: Score): string {
  if ("mate" in s) return `M${Math.abs(s.mate)}`;
  return Math.abs(s.cp) >= 90000 ? "#" : (Math.abs(s.cp) / 100).toFixed(1);
}

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

/** Material balance in pawns from White's point of view. */
export function materialBalance(fen: string): number {
  const values: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let sum = 0;
  for (const ch of fen.split(" ")[0]) {
    const v = values[ch.toLowerCase()];
    if (v) sum += ch === ch.toLowerCase() ? -v : v;
  }
  return sum;
}
