import { makeSan } from "chessops/san";
import { Color, epdOf, fullmoveOf, GameTree, GNode, moveFromUci, negate, pieceCount, sanLine, Score, scoreText, winPercent } from "./chess";
import { openingFor } from "./openings";
import { load, save } from "./storage";
import { Engine, searchOnce } from "./uci";

// MARK: Evaluation cache

interface Cached {
  d: number;
  s: Score;
  b?: string;
}

let cache: Map<string, Cached> | undefined;
let dirty = false;

function evalCache(): Map<string, Cached> {
  if (!cache) {
    cache = new Map(Object.entries(load<Record<string, Cached>>("evalCache", {})));
    setInterval(() => {
      if (!dirty || !cache) return;
      dirty = false;
      // Keep the most recently stored positions.
      const entries = [...cache.entries()].slice(-6000);
      cache = new Map(entries);
      save("evalCache", Object.fromEntries(entries));
    }, 5000);
  }
  return cache;
}

export const cachedEval = (fen: string) => evalCache().get(epdOf(fen));

/** Remembers an engine result so the position is instant next time. Deeper results win. */
export function storeEval(fen: string, depth: number, score: Score, best?: string) {
  const key = epdOf(fen);
  const c = evalCache();
  const old = c.get(key);
  if (old && old.d >= depth) return;
  c.delete(key);
  c.set(key, { d: depth, s: score, b: best });
  dirty = true;
}

export const cacheSize = () => evalCache().size;
export function clearEvalCache() {
  cache = new Map();
  save("evalCache", {});
}

// MARK: Review

export interface ReviewSummary {
  accuracy: Record<Color, number | undefined>;
  inaccuracies: Record<Color, number>;
  mistakes: Record<Color, number>;
  blunders: Record<Color, number>;
}

const pov = (s: Score, color: Color) => (color === "white" ? winPercent(s) : 100 - winPercent(s));

/** Evaluates every mainline position, reusing cached results where they are deep enough. */
export async function reviewGame(tree: GameTree, engine: Engine, moveTimeMs: number, onProgress: (done: number, total: number) => void, cancelled: () => boolean) {
  const nodes = [tree.root, ...tree.mainline];
  for (let i = 0; i < nodes.length; i++) {
    if (cancelled()) return false;
    const node = nodes[i];
    const pos = tree.posAt(node);
    if (pos.isEnd()) {
      const o = pos.outcome();
      node.eval = o?.winner ? { cp: o.winner === "white" ? 100000 : -100000 } : { cp: 0 };
    } else {
      const hit = tree.rules === "chess" ? cachedEval(node.fen) : undefined;
      if (hit && hit.d >= 14) {
        node.eval = hit.s;
        node.best = hit.b;
      } else {
        const { info, best } = await searchOnce(engine, { position: tree.positionCommand(node), go: `go movetime ${moveTimeMs}`, chess960: tree.chess960, variant: tree.rules });
        if (info) {
          node.eval = node.turn === "white" ? info.score : negate(info.score);
          node.best = info.pv[0] ?? best;
          if (tree.rules === "chess") storeEval(node.fen, info.depth, node.eval, node.best);
        }
      }
    }
    onProgress(i + 1, nodes.length);
  }
  tree.touch();
  return true;
}

/** Grades every mainline move from the stored evaluations and marks the mistakes. */
export function summarise(tree: GameTree): ReviewSummary | undefined {
  const sum: ReviewSummary = { accuracy: { white: undefined, black: undefined }, inaccuracies: { white: 0, black: 0 }, mistakes: { white: 0, black: 0 }, blunders: { white: 0, black: 0 } };
  const acc: Record<Color, number[]> = { white: [], black: [] };
  for (const node of tree.mainline) {
    const parent = node.parent!;
    if (!parent.eval || !node.eval) continue;
    const mover = parent.turn;
    const loss = Math.max(0, pov(parent.eval, mover) - pov(node.eval, mover));
    acc[mover].push(Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669)));
    if (parent.best === node.uci || loss < 5) {
      if (node.nag && [2, 4, 6].includes(node.nag)) node.nag = undefined;
    } else if (loss >= 20) {
      node.nag = 4;
      sum.blunders[mover]++;
    } else if (loss >= 10) {
      node.nag = 2;
      sum.mistakes[mover]++;
    } else {
      node.nag = 6;
      sum.inaccuracies[mover]++;
    }
  }
  for (const c of ["white", "black"] as Color[]) if (acc[c].length) sum.accuracy[c] = acc[c].reduce((a, b) => a + b, 0) / acc[c].length;
  return sum.accuracy.white === undefined && sum.accuracy.black === undefined ? undefined : sum;
}

export interface MistakePuzzle {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  themes: string[];
  source?: string;
}

function hash(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  return h.toString(36);
}

/** Every mistake and blunder of the reviewed game as a "find the better move" puzzle. */
export function mistakePuzzles(tree: GameTree, color?: Color): MistakePuzzle[] {
  const out: MistakePuzzle[] = [];
  const label = `${tree.tag("White", "White").replace(/^\?$/, "White")} – ${tree.tag("Black", "Black").replace(/^\?$/, "Black")}`;
  for (const node of tree.mainline) {
    const before = node.parent!, setup = before.parent;
    if (!(node.nag === 2 || node.nag === 4) || !setup || !before.uci || !before.best || before.best === node.uci) continue;
    if (color && before.turn !== color) continue;
    if (!moveFromUci(tree.posAt(before), before.best)) continue;
    out.push({ id: "m-" + hash(epdOf(before.fen)), fen: setup.fen, moves: [before.uci, before.best], rating: node.nag === 4 ? 1400 : 1700, themes: ["mistake"], source: label });
  }
  return out;
}

// MARK: Written report

type Phase = "opening" | "middlegame" | "endgame";
type Kind = "missed mate" | "missed capture" | "hung material" | "missed check" | "quiet move";

export interface Slip {
  node: GNode;
  mover: Color;
  loss: number;
  phase: Phase;
  kind: Kind;
  better: string;
}

interface History {
  date: string;
  color: Color;
  phases: Record<Phase, number>;
  kinds: Partial<Record<Kind, number>>;
}

const phaseOf = (node: GNode): Phase => {
  const pieces = pieceCount(node.fen);
  if (fullmoveOf(node.fen) <= 12 && pieces >= 26) return "opening";
  return pieces <= 12 ? "endgame" : "middlegame";
};

/** Every mistake and blunder of a reviewed game, classified. */
export function slipsOf(tree: GameTree): Slip[] {
  const out: Slip[] = [];
  for (const node of tree.mainline) {
    const parent = node.parent!;
    if (!(node.nag === 2 || node.nag === 4) || !parent.eval || !node.eval || !parent.best) continue;
    const mover = parent.turn;
    const pos = tree.posAt(parent);
    const best = moveFromUci(pos, parent.best);
    if (!best) continue;
    const bestSan = makeSan(pos, best);
    let kind: Kind = "quiet move";
    if ("mate" in parent.eval && (parent.eval.mate > 0) === (mover === "white")) kind = "missed mate";
    else if (bestSan.includes("x")) kind = "missed capture";
    else if (node.children[0]?.san.includes("x") && node.children[0].uci === node.best) kind = "hung material";
    else if (bestSan.includes("+")) kind = "missed check";
    out.push({ node, mover, loss: Math.max(0, pov(parent.eval, mover) - pov(node.eval, mover)), phase: phaseOf(parent), kind, better: bestSan });
  }
  return out;
}

export interface Report {
  headline: string;
  paragraphs: string[];
  keyMoments: { node: GNode; text: string }[];
  patterns: string[];
}

/** A plain-language account of a reviewed game. `me` focuses the advice on one side. */
export function writeReport(tree: GameTree, summary: ReviewSummary, me?: Color, record = true): Report {
  const all = slipsOf(tree);
  const nodes = [tree.root, ...tree.mainline];
  const named = (v: string, d: string) => (!v || v === "?" ? d : v);
  const white = named(tree.tag("White"), "White"), black = named(tree.tag("Black"), "Black");
  const name = (c: Color) => (c === "white" ? white : black);
  const paragraphs: string[] = [];

  const opening = openingFor(tree, tree.last);
  const result = tree.result;
  const outcome = result === "1-0" ? `${white} won` : result === "0-1" ? `${black} won` : result === "1/2-1/2" ? "The game was drawn" : "The game is unfinished";
  const acc = (c: Color) => (summary.accuracy[c] === undefined ? "" : `${summary.accuracy[c]!.toFixed(0)}%`);
  paragraphs.push(`${outcome} in ${Math.ceil(tree.mainline.length / 2)} moves${opening ? ` from the ${opening.name}` : ""}. ${white} played at ${acc("white")} accuracy and ${black} at ${acc("black")}.`);

  // The turning point: the single move that shifted the winning chances most.
  let turn: { node: GNode; swing: number } | undefined;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1].eval, b = nodes[i].eval;
    if (!a || !b) continue;
    const swing = Math.abs(winPercent(b) - winPercent(a));
    if (!turn || swing > turn.swing) turn = { node: nodes[i], swing };
  }
  if (turn && turn.swing >= 15) {
    const n = turn.node, p = n.parent!;
    const better = p.best ? sanLine(p.fen, [p.best], tree.rules, 1) : "";
    paragraphs.push(`The game turned on ${n.numberLabel} ${n.san}. Before it the evaluation was ${scoreText(p.eval!)}; after it, ${scoreText(n.eval!)}.${better ? ` The engine preferred ${better}.` : ""}`);
  } else {
    paragraphs.push("Neither side made a move that swung the game sharply; the result came from small advantages adding up.");
  }

  for (const c of ["white", "black"] as Color[]) {
    if (me && c !== me) continue;
    const mine = all.filter((s) => s.mover === c);
    if (!mine.length) {
      paragraphs.push(`${name(c)} made no mistakes or blunders.`);
      continue;
    }
    const byPhase = (p: Phase) => mine.filter((s) => s.phase === p).length;
    const worst = (["opening", "middlegame", "endgame"] as Phase[]).sort((a, b) => byPhase(b) - byPhase(a))[0];
    const kinds = new Map<Kind, number>();
    mine.forEach((s) => kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1));
    const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
    paragraphs.push(mine.length === 1
      ? `${name(c)} made one serious error, a ${top[0]} in the ${worst}.`
      : `${name(c)} made ${mine.length} serious errors, most of them in the ${worst}. The commonest kind was a ${top[0]} (${top[1]} of ${mine.length}).`);
  }

  const keyMoments = [...all]
    .filter((s) => !me || s.mover === me)
    .sort((a, b) => b.loss - a.loss)
    .slice(0, 5)
    .sort((a, b) => nodes.indexOf(a.node) - nodes.indexOf(b.node))
    .map((s) => ({
      node: s.node,
      text: `${s.node.numberLabel} ${s.node.san} (${s.kind}): ${s.better} was better; the move played cost about ${s.loss.toFixed(0)}% in winning chances.`,
    }));

  // Patterns across reviewed games.
  const history = load<History[]>("reviewHistory", []);
  if (record) {
    for (const c of (me ? [me] : ["white", "black"]) as Color[]) {
      const mine = all.filter((s) => s.mover === c);
      const entry: History = { date: new Date().toISOString(), color: c, phases: { opening: 0, middlegame: 0, endgame: 0 }, kinds: {} };
      mine.forEach((s) => {
        entry.phases[s.phase]++;
        entry.kinds[s.kind] = (entry.kinds[s.kind] ?? 0) + 1;
      });
      history.push(entry);
    }
    save("reviewHistory", history.slice(-200));
  }
  const patterns: string[] = [];
  if (history.length >= 4) {
    const phases: Record<Phase, number> = { opening: 0, middlegame: 0, endgame: 0 };
    const kinds: Partial<Record<Kind, number>> = {};
    let total = 0;
    for (const h of history) {
      for (const p of Object.keys(phases) as Phase[]) { phases[p] += h.phases[p]; total += h.phases[p]; }
      for (const [k, v] of Object.entries(h.kinds)) kinds[k as Kind] = (kinds[k as Kind] ?? 0) + (v ?? 0);
    }
    if (total >= 5) {
      const worst = (Object.keys(phases) as Phase[]).sort((a, b) => phases[b] - phases[a])[0];
      patterns.push(`Across ${history.length} reviewed sides, ${Math.round((phases[worst] / total) * 100)}% of serious errors came in the ${worst}.`);
      const top = Object.entries(kinds).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0];
      if (top) patterns.push(`The error that keeps coming back is the ${top[0]}: ${top[1]} of ${total}.`);
      if (kinds["hung material"] && kinds["hung material"]! / total > 0.25) patterns.push("Before each move, check what your move leaves undefended.");
      if (kinds["missed capture"] && kinds["missed capture"]! / total > 0.25) patterns.push("Look at every capture and check for both sides before choosing a move.");
      if (worst === "endgame") patterns.push("The endgame trainer on the Training page targets exactly this.");
    }
  }

  const headline = turn && turn.swing >= 15 ? `Decided by ${turn.node.numberLabel} ${turn.node.san}` : "A steady game";
  return { headline, paragraphs, keyMoments, patterns };
}
