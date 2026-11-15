import { create } from "zustand";
import { GameTree, negate, Score, winPercent } from "./chess";
import { db } from "./db";
import { launch, resolveEngine } from "./engines";
import { useOpenings } from "./openings";
import { Sound } from "./sound";
import { load, save } from "./storage";
import { Engine } from "./uci";

export type TournamentMode = "match" | "roundrobin" | "gauntlet" | "sprt";

export interface MatchRecord {
  number: number;
  white: number; // index into the entrant list
  black: number;
  result: "1-0" | "0-1" | "1/2-1/2";
  opening: string;
  plies: number;
  reason: string;
  tree: GameTree;
}

export interface Standing {
  index: number;
  name: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
}

interface Config {
  mode: TournamentMode;
  entrants: string[]; // engine ids, in seeding order
  rounds: number; // each round is two games per pairing, colours swapped
  moveTimeMs: number;
  useOpenings: boolean;
  saveGames: boolean;
  elo0: number;
  elo1: number;
}

interface State extends Config {
  running: boolean;
  names: string[];
  records: MatchRecord[];
  tree: GameTree;
  white: number;
  black: number;
  opening: string;
  score?: Score;
  depth: number;
  total: number;
  verdict?: string;
  error?: string;
  patch: (p: Partial<Config>) => void;
  start: () => Promise<void>;
  stop: () => void;
}

let pool: Engine[] = [];
let generation = 0;

/** The pairings in playing order: [white, black, opening slot]. */
function schedule(mode: TournamentMode, n: number, rounds: number): [number, number, number][] {
  const pairs: [number, number][] = [];
  if (mode === "match" || mode === "sprt") pairs.push([0, 1]);
  else if (mode === "gauntlet") for (let j = 1; j < n; j++) pairs.push([0, j]);
  else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push([i, j]);
  const games: [number, number, number][] = [];
  const reps = mode === "sprt" ? 1500 : rounds;
  let slot = 0;
  for (let r = 0; r < reps; r++) {
    for (const [a, b] of pairs) {
      games.push([a, b, slot], [b, a, slot]);
      slot++;
    }
  }
  return games;
}

export function standings(names: string[], records: MatchRecord[]): Standing[] {
  const table = names.map((name, index) => ({ index, name, played: 0, wins: 0, draws: 0, losses: 0, points: 0 }));
  for (const r of records) {
    const w = table[r.white], b = table[r.black];
    w.played++;
    b.played++;
    if (r.result === "1-0") { w.wins++; b.losses++; w.points++; }
    else if (r.result === "0-1") { b.wins++; w.losses++; b.points++; }
    else { w.draws++; b.draws++; w.points += 0.5; b.points += 0.5; }
  }
  return table.sort((a, b) => b.points - a.points || a.played - b.played);
}

const toElo = (p: number) => -400 * Math.log10(1 / Math.min(0.999, Math.max(0.001, p)) - 1);
const expected = (elo: number) => 1 / (1 + Math.pow(10, -elo / 400));

/** Rating edge of the first entrant over the second with a 95% margin. */
export function eloEstimate(records: MatchRecord[]): { diff: number; margin: number; w: number; d: number; l: number } | undefined {
  const games = records.filter((r) => (r.white === 0 && r.black === 1) || (r.white === 1 && r.black === 0));
  const n = games.length;
  let w = 0, d = 0, l = 0;
  for (const g of games) {
    if (g.result === "1/2-1/2") d++;
    else if ((g.result === "1-0") === (g.white === 0)) w++;
    else l++;
  }
  if (n < 2) return undefined;
  const p = (w + d / 2) / n;
  if (p <= 0 || p >= 1) return { diff: p <= 0 ? -999 : 999, margin: 0, w, d, l };
  const variance = (w / n) * (1 - p) ** 2 + (d / n) * (0.5 - p) ** 2 + (l / n) * p ** 2;
  const sigma = Math.sqrt(variance / n);
  return { diff: toElo(p), margin: (toElo(p + 1.96 * sigma) - toElo(p - 1.96 * sigma)) / 2, w, d, l };
}

/** Sequential probability ratio test: the log-likelihood ratio and the bounds that end the test. */
export function sprt(records: MatchRecord[], elo0: number, elo1: number): { llr: number; lower: number; upper: number } {
  const e = eloEstimate(records);
  const bound = Math.log((1 - 0.05) / 0.05);
  if (!e) return { llr: 0, lower: -bound, upper: bound };
  const n = e.w + e.d + e.l;
  const mean = (e.w + e.d / 2) / n;
  const variance = (e.w * (1 - mean) ** 2 + e.d * (0.5 - mean) ** 2 + e.l * mean ** 2) / n;
  if (variance <= 0) return { llr: 0, lower: -bound, upper: bound };
  const s0 = expected(elo0), s1 = expected(elo1);
  return { llr: (n * (s1 - s0) * (2 * mean - s0 - s1)) / (2 * variance), lower: -bound, upper: bound };
}

const defaults: Config = { mode: "match", entrants: ["wasabi", "stockfish"], rounds: 5, moveTimeMs: 200, useOpenings: true, saveGames: false, elo0: 0, elo1: 10 };

export const useMatches = create<State>((set, get) => {
  const stop = () => {
    generation++;
    pool.forEach((e) => e.quit());
    pool = [];
    set({ running: false });
  };

  const play = async (gen: number, games: [number, number, number][]) => {
    const openings = new Map<number, { name: string; moves: string[] } | undefined>();
    for (let g = 0; g < games.length; g++) {
      if (gen !== generation) return;
      const [white, black, slot] = games[g];
      const s = get();
      if (!openings.has(slot)) {
        const lines = useOpenings.getState().lines;
        openings.set(slot, s.useOpenings && lines.length ? lines[Math.floor(Math.random() * lines.length)] : undefined);
      }
      const line = openings.get(slot);
      const tree = new GameTree();
      for (const uci of line?.moves ?? []) tree.play(uci);
      tree.headers.set("Event", "Engine tournament");
      tree.headers.set("Round", String(g + 1));
      tree.headers.set("White", s.names[white]);
      tree.headers.set("Black", s.names[black]);
      if (line) tree.headers.set("Opening", line.name);
      set({ tree, white, black, opening: line?.name ?? "Starting position", score: undefined, depth: 0 });
      pool[white].newGame();
      pool[black].newGame();

      let decisive = 0, quiet = 0;
      let score: Score | undefined;
      let result: MatchRecord["result"] | undefined;
      let reason = "";
      while (!result) {
        if (gen !== generation) return;
        const node = tree.current;
        const o = tree.outcome(node);
        if (o) { result = o.result; reason = o.reason; break; }
        if (tree.mainline.length >= 400) { result = "1/2-1/2"; reason = "Game too long"; break; }
        if (decisive >= 8 && score) { result = winPercent(score) > 50 ? "1-0" : "0-1"; reason = "Adjudicated: decisive advantage"; break; }
        if (quiet >= 30 && tree.mainline.length > 120) { result = "1/2-1/2"; reason = "Adjudicated: dead level"; break; }
        const whiteToMove = node.turn === "white";
        const engine = pool[whiteToMove ? white : black];
        const answer = await new Promise<{ best?: string; score?: Score; depth: number }>((resolve) => {
          let last: { score: Score; depth: number } | undefined;
          engine.search({
            position: tree.positionCommand(node),
            go: `go movetime ${s.moveTimeMs}`,
            onInfo: (i) => { if (i.multipv === 1) last = { score: whiteToMove ? i.score : negate(i.score), depth: i.depth }; },
            onBest: (best) => resolve({ best, score: last?.score, depth: last?.depth ?? 0 }),
          });
        });
        if (gen !== generation) return;
        const played = answer.best ? tree.play(answer.best) : undefined;
        if (!played) { result = whiteToMove ? "0-1" : "1-0"; reason = "Engine failed to move"; break; }
        if (answer.score) {
          score = answer.score;
          played.eval = score;
          const wp = winPercent(score);
          decisive = wp > 97 || wp < 3 ? decisive + 1 : 0;
          quiet = Math.abs(wp - 50) < 2 ? quiet + 1 : 0;
          set({ score, depth: answer.depth });
        }
      }
      tree.headers.set("Termination", reason);
      tree.result = result;
      const records = [...get().records, { number: g + 1, white, black, result, opening: line?.name ?? "Starting position", plies: tree.mainline.length, reason, tree }];
      set({ records });
      if (s.saveGames) db.saveGame(tree, "Engine games");
      if (s.mode === "sprt") {
        const t = sprt(records, s.elo0, s.elo1);
        if (t.llr >= t.upper || t.llr <= t.lower) {
          set({ verdict: t.llr >= t.upper ? `Accepted: ${s.names[0]} is stronger by at least ${s.elo0} Elo.` : `Rejected: no gain of ${s.elo1} Elo for ${s.names[0]}.` });
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    if (gen === generation) {
      Sound.end();
      stop();
    }
  };

  return {
    ...defaults,
    ...load<Partial<Config>>("tournament", {}),
    running: false,
    names: [],
    records: [],
    tree: new GameTree(),
    white: 0,
    black: 1,
    opening: "",
    depth: 0,
    total: 0,
    patch: (p) => {
      set(p);
      const s = get();
      save("tournament", Object.fromEntries(Object.keys(defaults).map((k) => [k, s[k as keyof Config]])));
    },
    start: async () => {
      stop();
      const s = get();
      const gen = ++generation;
      const ids = s.mode === "match" || s.mode === "sprt" ? s.entrants.slice(0, 2) : s.entrants;
      if (ids.length < 2) return set({ error: "Pick at least two engines." });
      set({ error: undefined, verdict: undefined, records: [], running: true });
      try {
        const names: string[] = [];
        const started: Engine[] = [];
        for (const id of ids) {
          const entry = resolveEngine(id);
          if (!entry) throw new Error("An engine is missing.");
          const taken = names.filter((n) => n.replace(/ \(\d+\)$/, "") === entry.name).length;
          names.push(taken ? `${entry.name} (${taken + 1})` : entry.name);
          started.push(await launch(entry, { Threads: "1", Hash: "64" }));
        }
        if (gen !== generation) return started.forEach((e) => e.quit());
        pool = started;
        const games = schedule(s.mode, ids.length, s.rounds);
        set({ names, total: s.mode === "sprt" ? 0 : games.length });
        play(gen, games);
      } catch (e: any) {
        stop();
        set({ error: String(e.message ?? e) });
      }
    },
    stop,
  };
});
