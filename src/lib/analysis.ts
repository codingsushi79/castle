import { useEffect, useRef, useState } from "react";
import { GameTree, negate, sanLine, Score, tryPosition, turnOf, winPercent } from "./chess";
import { launch, resolveEngine } from "./engines";
import { cachedEval, storeEval } from "./review";
import { Engine } from "./uci";

export interface Line {
  rank: number;
  depth: number;
  score: Score;
  san: string;
  first: string;
  pv: string[];
  nps: number;
}

export interface Slot {
  key: number;
  engineId: string;
  name: string;
}

/** The same position with the other side to move, or undefined when that is illegal. */
export function passedFen(fen: string, rules: GameTree["rules"]): string | undefined {
  const pos = tryPosition(fen, rules);
  if (!pos || pos.isCheck()) return undefined;
  const p = fen.split(" ");
  const flipped = [p[0], p[1] === "w" ? "b" : "w", p[2], "-", p[4] ?? "0", p[5] ?? "1"].join(" ");
  return tryPosition(flipped, rules) ? flipped : undefined;
}

let slotKey = 1;

/** Live analysis of the position on a game tree by one or more engines. */
export function useAnalysis(tree: GameTree, revision: number) {
  const [running, setRunning] = useState(false);
  const [slots, setSlots] = useState<Slot[]>(() => {
    const e = resolveEngine();
    return [{ key: slotKey++, engineId: e?.id ?? "wasabi", name: e?.name ?? "Engine" }];
  });
  const [lines, setLines] = useState<Record<number, Line[]>>({});
  const [multipv, setMultipv] = useState(3);
  const [threat, setThreat] = useState(false);
  const [threatBlocked, setThreatBlocked] = useState(false);
  const [error, setError] = useState<string>();
  const engines = useRef(new Map<number, { id: string; engine?: Engine; starting?: Promise<Engine> }>());
  const generation = useRef(0);

  const node = tree.current;

  useEffect(() => {
    const gen = ++generation.current;
    const map = engines.current;
    // Drop engines whose slot is gone or changed.
    for (const [key, held] of map) {
      const slot = slots.find((s) => s.key === key);
      if (!running || !slot || slot.engineId !== held.id) {
        held.engine?.quit();
        held.starting?.then((e) => e.quit()).catch(() => {});
        map.delete(key);
      }
    }
    setLines({});
    setThreatBlocked(false);
    if (!running) return;

    let fen = node.fen;
    let command = tree.positionCommand(node);
    if (threat) {
      const passed = passedFen(node.fen, tree.rules);
      if (!passed) {
        setThreatBlocked(true);
        map.forEach((h) => h.engine?.stop());
        return;
      }
      fen = passed;
      command = `position fen ${passed}`;
    }
    const pos = tryPosition(fen, tree.rules);
    if (!pos || pos.isEnd()) {
      map.forEach((h) => h.engine?.stop());
      return;
    }
    const whiteToMove = turnOf(fen) === "white";
    const cores = navigator.hardwareConcurrency || 4;
    const threads = slots.length > 1 ? String(Math.max(1, Math.floor(cores / (slots.length + 1)))) : undefined;

    slots.forEach((slot, index) => {
      let held = map.get(slot.key);
      if (!held) {
        const entry = resolveEngine(slot.engineId);
        if (!entry) return setError("No engine is installed.");
        held = { id: slot.engineId };
        held.starting = launch(entry, threads ? { Threads: threads } : {});
        map.set(slot.key, held);
        const h = held;
        held.starting
          .then((engine) => {
            h.engine = engine;
            engine.onExit = () => {
              if (engines.current.get(slot.key) === h) engines.current.delete(slot.key);
            };
          })
          .catch((e) => {
            setError(String(e.message ?? e));
            if (engines.current.get(slot.key) === h) engines.current.delete(slot.key);
          });
      }
      const start = (engine: Engine) => {
        if (gen !== generation.current) return;
        engine.search({
          position: command,
          go: "go infinite",
          multipv,
          chess960: tree.chess960,
          variant: tree.rules,
          onInfo: (info) => {
            if (gen !== generation.current) return;
            const score = whiteToMove ? info.score : negate(info.score);
            const line: Line = { rank: info.multipv, depth: info.depth, score, san: sanLine(fen, info.pv, tree.rules), first: info.pv[0] ?? "", pv: info.pv, nps: info.nps };
            setLines((all) => {
              const mine = (all[slot.key] ?? []).filter((l) => l.rank !== line.rank);
              mine.push(line);
              mine.sort((a, b) => a.rank - b.rank);
              return { ...all, [slot.key]: mine };
            });
            if (index === 0 && !threat && info.multipv === 1 && info.depth >= 12) {
              node.eval = score;
              node.best = info.pv[0];
              if (tree.rules === "chess") storeEval(node.fen, info.depth, score, info.pv[0]);
            }
          },
        });
      };
      if (held.engine) start(held.engine);
      else held.starting?.then(start).catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, node, slots, multipv, threat, tree]);

  // Stop everything when the board goes away.
  useEffect(() => {
    const map = engines.current;
    return () => {
      generation.current++;
      for (const held of map.values()) {
        held.engine?.quit();
        held.starting?.then((e) => e.quit()).catch(() => {});
      }
      map.clear();
    };
  }, []);

  void revision;
  const primary = lines[slots[0]?.key] ?? [];
  const live = running && !threat ? primary[0]?.score : undefined;
  const score = live ?? node.eval ?? (tree.rules === "chess" ? cachedEval(node.fen)?.s : undefined);

  return {
    running, setRunning, slots, lines, primary, multipv, setMultipv, threat, setThreat, threatBlocked, score, error,
    setEngine: (key: number, engineId: string) => setSlots((s) => s.map((x) => (x.key === key ? { ...x, engineId, name: resolveEngine(engineId)?.name ?? "Engine" } : x))),
    addEngine: (engineId: string) => setSlots((s) => (s.length >= 4 ? s : [...s, { key: slotKey++, engineId, name: resolveEngine(engineId)?.name ?? "Engine" }])),
    removeSlot: (key: number) => setSlots((s) => (s.length > 1 ? s.filter((x) => x.key !== key) : s)),
  };
}

/** One candidate move after every running engine has had its say. */
export interface ConsensusMove {
  first: string;
  san: string;
  /** Winning chances for the side to move, 0–100, averaged over the engines. */
  win: number;
  /** The same, as an evaluation from White's point of view. */
  score: Score;
  /** How many engines list the move among their lines. */
  backers: number;
  /** Change in winning chances against the first engine's own view of the move:
   *  positive when the other engines rate it higher, negative when lower. */
  shift: number;
  pv: string[];
}

/** Evaluation (White's view) that gives these winning chances for the side to move. */
function scoreFromWin(win: number, whiteToMove: boolean): Score {
  const w = Math.max(0.5, Math.min(99.5, win)) / 100;
  // Inverse of winPercent: 50 + 50 * (2 / (1 + e^(-k·cp)) - 1).
  const cp = Math.round(-Math.log(1 / w - 1) / 0.00368208);
  return { cp: whiteToMove ? cp : -cp };
}

/**
 * Pools the lines of several engines into one ranking. Each engine scores every
 * candidate: moves it lists get its own winning chances; moves it does not list
 * get a little less than its weakest line, since it ranked them below that.
 * Engines are weighted by search depth, so a deep engine counts for more than a
 * shallow one. Moves several engines like rise; moves only one engine likes fall.
 */
export function consensus(fen: string, rules: GameTree["rules"], slots: Slot[], lines: Record<number, Line[]>): ConsensusMove[] {
  const whiteToMove = turnOf(fen) === "white";
  const mine = (s: Score) => (whiteToMove ? winPercent(s) : 100 - winPercent(s));
  const views = slots
    .map((s) => lines[s.key] ?? [])
    .filter((ls) => ls.length > 0)
    .map((ls) => {
      const byMove = new Map<string, number>();
      const scores = new Map<string, Score>();
      for (const l of ls) if (l.first && !byMove.has(l.first)) { byMove.set(l.first, mine(l.score)); scores.set(l.first, l.score); }
      const floor = Math.min(...byMove.values());
      const depth = Math.max(...ls.map((l) => l.depth));
      return { ls, byMove, scores, floor, weight: Math.max(1, depth) };
    });
  if (views.length < 2) return [];
  const moves = new Map<string, string[]>();
  for (const v of views) for (const l of v.ls) if (l.first && !moves.has(l.first)) moves.set(l.first, l.pv);
  const total = views.reduce((n, v) => n + v.weight, 0);
  const out: ConsensusMove[] = [];
  for (const [first, pv] of moves) {
    let sum = 0, backers = 0;
    const said = (v: (typeof views)[number]) => v.byMove.get(first) ?? Math.max(0, v.floor - 4);
    for (const v of views) {
      if (v.byMove.has(first)) backers++;
      sum += said(v) * v.weight;
    }
    const before = said(views[0]);
    const win = sum / total;
    // When every engine sees a forced mate, show the mate rather than a pawn count.
    const mates = views.map((v) => v.scores.get(first)).filter((s): s is { mate: number } => !!s && "mate" in s);
    const score: Score = mates.length === views.length && mates.every((m) => Math.sign(m.mate) === Math.sign(mates[0].mate))
      ? mates.reduce((a, b) => (Math.abs(b.mate) < Math.abs(a.mate) ? b : a))
      : scoreFromWin(win, whiteToMove);
    out.push({ first, pv, win, backers, shift: win - before, score, san: sanLine(fen, pv, rules, 1).replace(/^\d+\.(\.\.|…)?\s*/, "") });
  }
  return out.sort((a, b) => b.win - a.win || b.backers - a.backers);
}
