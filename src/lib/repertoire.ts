import type { Move } from "chessops/types";
import { create } from "zustand";
import { Color, epdOf, GameTree, GNode, moveFromUci, uciOf } from "./chess";
import { Sound } from "./sound";
import { load, save } from "./storage";
import { logActivity } from "./activity";

/** Spaced-repetition state for one repertoire position. */
export interface Card {
  interval: number; // days
  ease: number;
  reps: number;
  lapses: number;
  due: number;
}

function loadTree(color: Color): GameTree {
  const pgn = load<string>(`repertoire.${color}`, "");
  const tree = (pgn && GameTree.fromPgn(pgn)) || new GameTree();
  tree.headers.set("Event", `${color === "white" ? "White" : "Black"} repertoire`);
  tree.toStart();
  return tree;
}

interface State {
  color: Color;
  trees: Record<Color, GameTree>;
  cards: Record<string, Card>;
  training: boolean;
  status: "idle" | "asking" | "correct" | "wrong" | "finished";
  node?: GNode;
  answerFen?: string;
  answerMove?: [string, string];
  done: number;
  total: number;
  misses: number;
  setColor: (c: Color) => void;
  saveTrees: () => void;
  importTree: (source: GameTree, color: Color) => void;
  clear: (color: Color) => void;
  start: (limit?: number) => void;
  stop: () => void;
  attempt: (move: Move) => void;
}

let queue: GNode[] = [];
let missed = false;
let token = 0;

const key = (node: GNode, color: Color) => `${color}|${epdOf(node.fen)}`;

/** Positions where it is the repertoire side's move and a reply has been prepared. */
export function positions(tree: GameTree, color: Color): GNode[] {
  const out: GNode[] = [];
  const seen = new Set<string>();
  const stack = [tree.root];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.turn === color && n.children.length && !seen.has(epdOf(n.fen))) {
      seen.add(epdOf(n.fen));
      out.push(n);
    }
    stack.push(...n.children);
  }
  return out;
}

export const useRepertoire = create<State>((set, get) => {
  const grade = (node: GNode, ok: boolean) => {
    const k = key(node, get().color);
    const c: Card = { ...(get().cards[k] ?? { interval: 0, ease: 2.3, reps: 0, lapses: 0, due: Date.now() }) };
    if (ok) {
      c.reps++;
      c.interval = c.reps === 1 ? 1 : c.reps === 2 ? 3 : Math.round(c.interval * c.ease);
      c.ease = Math.min(3, c.ease + 0.05);
      c.due = Date.now() + c.interval * 86400000;
    } else {
      c.reps = 0;
      c.lapses++;
      c.interval = 0;
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.due = Date.now();
    }
    const cards = { ...get().cards, [k]: c };
    logActivity("repertoire", ok);
    save("repertoire.cards", cards);
    set({ cards });
  };

  const advance = () => {
    token++;
    missed = false;
    if (!queue.length) {
      set({ node: undefined, status: "finished", answerFen: undefined, answerMove: undefined });
      Sound.end();
      return;
    }
    set({ node: queue.shift(), status: "asking", answerFen: undefined, answerMove: undefined });
  };

  return {
    color: "white",
    trees: { white: loadTree("white"), black: loadTree("black") },
    cards: load<Record<string, Card>>("repertoire.cards", {}),
    training: false,
    status: "idle",
    done: 0,
    total: 0,
    misses: 0,
    setColor: (color) => set({ color }),
    saveTrees: () => {
      for (const c of ["white", "black"] as Color[]) save(`repertoire.${c}`, get().trees[c].toPgn());
    },
    importTree: (source, color) => {
      const target = get().trees[color];
      if (source.root.fen !== target.root.fen || source.rules !== "chess") return;
      const merge = (from: GNode, into: GNode) => {
        for (const child of from.children) {
          const parsed = child.uci ? moveFromUci(target.posAt(into), child.uci) : undefined;
          const next = parsed ? target.append(into, parsed) : undefined;
          if (!next) continue;
          if (!next.comment) next.comment = child.comment;
          merge(child, next);
        }
      };
      merge(source.root, target.root);
      target.touch();
      get().saveTrees();
    },
    clear: (color) => {
      const tree = new GameTree();
      tree.headers.set("Event", `${color === "white" ? "White" : "Black"} repertoire`);
      set({ trees: { ...get().trees, [color]: tree } });
      get().saveTrees();
    },
    start: (limit = 30) => {
      const { trees, color } = get();
      queue = dueNodes(trees[color], color, get().cards).sort(() => Math.random() - 0.5).slice(0, limit);
      set({ training: true, total: queue.length, done: 0, misses: 0 });
      advance();
    },
    stop: () => {
      token++;
      set({ training: false, status: "idle", node: undefined, answerFen: undefined });
    },
    attempt: (move) => {
      const s = get();
      const node = s.node;
      if (!node || !(s.status === "asking" || s.status === "wrong")) return;
      const tree = s.trees[s.color];
      const uci = uciOf(tree.posAt(node), move, false);
      const child = node.children.find((c) => c.uci === uci);
      if (!child) {
        if (!missed) {
          missed = true;
          grade(node, false);
          queue.push(node);
          set({ misses: s.misses + 1 });
        }
        set({ status: "wrong" });
        Sound.error();
        return;
      }
      if (!missed) {
        grade(node, true);
        set({ done: s.done + 1 });
      }
      Sound.forSan(child.san);
      set({ status: "correct", answerFen: child.fen, answerMove: child.lastMove });
      const t = token;
      setTimeout(() => t === token && advance(), 700);
    },
  };
});

export function dueNodes(tree: GameTree, color: Color, cards: Record<string, Card>): GNode[] {
  const now = Date.now();
  return positions(tree, color).filter((n) => (cards[key(n, color)]?.due ?? 0) <= now);
}

export function learnedCount(tree: GameTree, color: Color, cards: Record<string, Card>): number {
  return positions(tree, color).filter((n) => (cards[key(n, color)]?.interval ?? 0) >= 7).length;
}

/** Cards coming due on each of the next days. */
export function forecast(days = 14): { day: string; count: number }[] {
  const { trees, cards } = useRepertoire.getState();
  const counts = new Array(days).fill(0);
  const now = Date.now();
  for (const c of ["white", "black"] as Color[]) {
    for (const node of positions(trees[c], c)) {
      const d = Math.max(0, Math.ceil(((cards[key(node, c)]?.due ?? now) - now) / 86400000));
      if (d < days) counts[d]++;
    }
  }
  return counts.map((count, i) => ({ day: i === 0 ? "Now" : `+${i}`, count }));
}
