import { parseSan } from "chessops/san";
import { create } from "zustand";
import { epdOf, fenOf, GameTree, GNode, positionOf, START_FEN, uciOf } from "./chess";

export interface Opening {
  eco: string;
  name: string;
}

interface Book {
  loaded: boolean;
  byEpd: Map<string, Opening>;
  /** Short named lines (as UCI moves) used to start engine games from varied positions. */
  lines: { name: string; moves: string[] }[];
  /** Every named line, for the palette and the opening quiz. */
  all: { eco: string; name: string; moves: string[]; sans: string[] }[];
  load: () => void;
}

export const useOpenings = create<Book>((set, get) => ({
  loaded: false,
  byEpd: new Map(),
  lines: [],
  all: [],
  load: async () => {
    if (get().loaded) return;
    const text = await fetch(`${import.meta.env.BASE_URL}data/openings.tsv`).then((r) => r.text()).catch(() => "");
    const rows = text.split("\n").slice(1);
    const byEpd = new Map<string, Opening>();
    const lines: Book["lines"] = [];
    const all: Book["all"] = [];
    let i = 0;
    const step = () => {
      const until = performance.now() + 12;
      while (i < rows.length && performance.now() < until) {
        const cols = rows[i++].split("\t");
        if (cols.length !== 3) continue;
        const pos = positionOf(START_FEN).clone();
        const ucis: string[] = [];
        const sans: string[] = [];
        let ok = true;
        for (const token of cols[2].split(" ")) {
          if (token.endsWith(".")) continue;
          const m = parseSan(pos, token);
          if (!m) { ok = false; break; }
          ucis.push(uciOf(pos, m, false));
          sans.push(token);
          pos.play(m);
        }
        if (!ok) continue;
        byEpd.set(epdOf(fenOf(pos)), { eco: cols[0], name: cols[1] });
        if (ucis.length >= 4 && ucis.length <= 8) lines.push({ name: cols[1], moves: ucis });
        all.push({ eco: cols[0], name: cols[1], moves: ucis, sans });
      }
      if (i < rows.length) setTimeout(step, 0);
      else set({ loaded: true, byEpd, lines, all });
    };
    step();
  },
}));

/** The deepest named position on the way to a node. */
export function openingFor(tree: GameTree, node: GNode = tree.current): Opening | undefined {
  const book = useOpenings.getState();
  if (!book.loaded || tree.rules !== "chess") return undefined;
  for (let n: GNode | undefined = node; n; n = n.parent) {
    const o = book.byEpd.get(epdOf(n.fen));
    if (o) return o;
  }
  return undefined;
}
