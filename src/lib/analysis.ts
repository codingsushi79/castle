import { useEffect, useRef, useState } from "react";
import { GameTree, negate, sanLine, Score, tryPosition, turnOf } from "./chess";
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
