import { makeSan } from "chessops/san";
import { create } from "zustand";
import { GameTree, moveFromUci, negate, Score, winPercent } from "./chess";
import { db } from "./db";
import { launch, resolveEngine } from "./engines";
import { notify } from "./notify";
import { Puzzle } from "./puzzles";
import { load, save } from "./storage";
import { Engine, searchOnce } from "./uci";

export interface Pack {
  id: string;
  name: string;
  created: number;
  puzzles: Puzzle[];
  solved: string[];
}

interface PackState {
  packs: Pack[];
  building?: { name: string; done: number; total: number; found: number };
  build: (name: string, ids: number[]) => Promise<void>;
  cancel: () => void;
  remove: (id: string) => void;
  markSolved: (packId: string, puzzleId: string) => void;
}

let token = 0;
const pov = (s: Score, white: boolean) => (white ? winPercent(s) : 100 - winPercent(s));

/**
 * Finds tactical moments in games: a move that throws away a lot, answered by a
 * clearly best reply. Each becomes a puzzle starting just before the slip, like
 * the Lichess puzzle generator does.
 */
async function puzzlesFrom(tree: GameTree, engine: Engine, cancelled: () => boolean): Promise<Puzzle[]> {
  const out: Puzzle[] = [];
  const nodes = [tree.root, ...tree.mainline];
  const evals = new Map<number, Score>();
  const evalOf = async (i: number) => {
    if (evals.has(i)) return evals.get(i)!;
    const n = nodes[i];
    if (n.eval) { evals.set(i, n.eval); return n.eval; }
    const { info } = await searchOnce(engine, { position: tree.positionCommand(n), go: "go movetime 120" });
    const s = info ? (n.turn === "white" ? info.score : negate(info.score)) : { cp: 0 };
    evals.set(i, s);
    return s;
  };
  for (let i = 1; i < nodes.length - 1 && !cancelled(); i++) {
    const before = nodes[i - 1], after = nodes[i];
    if (tree.posAt(after).isEnd()) break;
    const mover = before.turn === "white";
    const loss = pov(await evalOf(i - 1), mover) - pov(await evalOf(i), mover);
    // The slip must hand over a real advantage, not just trim a big one.
    if (loss < 30 || pov(await evalOf(i), !mover) < 70) continue;
    // The punishing reply must be the only good one.
    const { lines } = await searchOnce(engine, { position: tree.positionCommand(after), go: "go movetime 600", multipv: 2 });
    if (!lines[0]?.pv.length) continue;
    const best = pov(after.turn === "white" ? lines[0].score : negate(lines[0].score), !mover);
    const second = lines[1] ? pov(after.turn === "white" ? lines[1].score : negate(lines[1].score), !mover) : 0;
    if (best < 75 || best - second < 20) continue;
    const solution = lines[0].pv.slice(0, 5);
    // End on the solver's move.
    if (solution.length % 2 === 0) solution.pop();
    if (!moveFromUci(tree.posAt(after), solution[0])) continue;
    const themes = ["fromGames"];
    const pos = tree.posAt(after);
    const first = moveFromUci(pos, solution[0])!;
    const san = makeSan(pos, first);
    if (san.includes("#")) themes.push("mateIn1");
    else if (san.includes("x")) themes.push("hangingPiece");
    out.push({
      id: `g-${tree.tag("White")}-${tree.tag("Black")}-${tree.tag("Date")}-${i}`.replace(/\s+/g, ""),
      fen: before.fen,
      moves: [after.uci!, ...solution],
      rating: Math.round(1000 + (100 - Math.min(100, best - second)) * 12),
      themes,
      source: `${tree.tag("White", "White")} – ${tree.tag("Black", "Black")}, move ${Math.ceil(i / 2)}`,
    });
    i++;
  }
  return out;
}

export const usePacks = create<PackState>((set, get) => ({
  packs: load<Pack[]>("puzzlePacks", []),
  build: async (name, ids) => {
    const t = ++token;
    const entry = resolveEngine();
    if (!entry) return;
    set({ building: { name, done: 0, total: ids.length, found: 0 } });
    const engine = await launch(entry);
    const puzzles: Puzzle[] = [];
    try {
      for (const id of ids) {
        if (t !== token) break;
        const tree = GameTree.fromPgn(await db.get(id).catch(() => ""));
        if (tree && tree.rules === "chess" && tree.mainline.length >= 10) puzzles.push(...(await puzzlesFrom(tree, engine, () => t !== token)));
        const b = get().building;
        if (b) set({ building: { ...b, done: b.done + 1, found: puzzles.length } });
      }
    } finally {
      engine.quit();
    }
    if (t !== token) return;
    const unique = [...new Map(puzzles.map((p) => [p.id, p])).values()];
    const pack: Pack = { id: Date.now().toString(36), name, created: Date.now(), puzzles: unique, solved: [] };
    const packs = [pack, ...get().packs];
    save("puzzlePacks", packs);
    set({ packs, building: undefined });
    notify("Puzzle pack ready", `${unique.length} puzzles from ${ids.length} games in “${name}”.`);
  },
  cancel: () => {
    token++;
    set({ building: undefined });
  },
  remove: (id) => {
    const packs = get().packs.filter((p) => p.id !== id);
    save("puzzlePacks", packs);
    set({ packs });
  },
  markSolved: (packId, puzzleId) => {
    const packs = get().packs.map((p) => (p.id === packId && !p.solved.includes(puzzleId) ? { ...p, solved: [...p.solved, puzzleId] } : p));
    save("puzzlePacks", packs);
    set({ packs });
  },
}));
