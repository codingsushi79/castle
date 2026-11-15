import { parseSan } from "chessops/san";
import type { Move, Rules } from "chessops/types";
import { create } from "zustand";
import { chess960Fen, Color, GameTree, Outcome, START_FEN } from "./chess";
import { db } from "./db";
import { entryOf, launch, resolveEngine } from "./engines";
import { bookMoves, installedMaia, maiaDir, PERSONALITIES, Personality } from "./personalities";
import { Sound } from "./sound";
import { load, save } from "./storage";
import { Engine } from "./uci";

export interface PlaySetup {
  opponent: "engine" | "persona" | "human";
  side: "white" | "black" | "random";
  engineId: string;
  personaId: string;
  minutes: number;
  increment: number;
  limit: boolean;
  elo: number;
  rules: Rules;
  chess960: boolean;
  /** Black gets its own time and increment (a handicap clock). */
  handicap: boolean;
  blackMinutes: number;
  blackIncrement: number;
  /** Seconds of delay per move: "simple" waits before the clock runs, "bronstein" gives back up to that much. */
  delay: number;
  delayMode: "none" | "simple" | "bronstein";
}

interface PlayState extends PlaySetup {
  phase: "setup" | "playing" | "finished";
  customStart?: { fen: string; rules: Rules };
  tree: GameTree;
  humanColor: Color;
  outcome?: Outcome;
  clocks: Record<Color, number>;
  thinking: boolean;
  opponentName: string;
  detail: string;
  error?: string;
  patch: (p: Partial<PlaySetup>) => void;
  setCustomStart: (c?: { fen: string; rules: Rules }) => void;
  start: () => Promise<void>;
  humanMove: (move: Move) => void;
  resign: () => void;
  takeBack: () => void;
  backToSetup: () => void;
}

let engine: Engine | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = Date.now();
let persona: Personality | undefined;
let maiaMode = false;
let token = 0;

const defaults: PlaySetup = { opponent: "engine", side: "white", engineId: "wasabi", personaId: "amara", minutes: 10, increment: 5, limit: true, elo: 1500, rules: "chess", chess960: false, handicap: false, blackMinutes: 10, blackIncrement: 5, delay: 0, delayMode: "none" };

export const hasClock = (s: PlaySetup) => s.minutes > 0 || (s.handicap && s.blackMinutes > 0);
const incrementOf = (s: PlaySetup, c: Color) => (s.handicap && c === "black" ? s.blackIncrement : s.increment);
let moveStartedAt = Date.now();

export const usePlay = create<PlayState>((set, get) => {
  const finish = (o: Outcome) => {
    const s = get();
    clearInterval(timer);
    engine?.quit();
    engine = undefined;
    s.tree.headers.set("Termination", o.reason);
    s.tree.result = o.result;
    set({ outcome: o, phase: "finished", thinking: false });
    Sound.end();
    db.saveGame(s.tree, "My games");
  };

  const commit = (move: Move | string) => {
    const s = get();
    const mover = s.tree.last.turn;
    s.tree.toEnd();
    const node = s.tree.play(move);
    if (!node) return false;
    if (hasClock(s)) {
      const used = (Date.now() - moveStartedAt) / 1000;
      const giveBack = s.delayMode === "bronstein" ? Math.min(used, s.delay) : 0;
      const clocks = { ...s.clocks, [mover]: s.clocks[mover] + incrementOf(s, mover) + giveBack };
      node.clock = Math.round(clocks[mover]);
      set({ clocks });
    }
    lastTick = Date.now();
    moveStartedAt = Date.now();
    Sound.forSan(node.san);
    const o = s.tree.outcome(node);
    if (o) finish(o);
    return true;
  };

  const engineMove = () => {
    const s = get();
    if (s.phase !== "playing") return;
    const node = s.tree.last;
    const t = token;
    set({ thinking: true, detail: "" });

    // Personalities play their favourite openings from memory.
    if (persona && s.tree.isStandardStart) {
      const pos = s.tree.posAt(node);
      const options = bookMoves(persona, s.tree.mainline.map((n) => n.san)).map((san) => parseSan(pos, san)).filter((m): m is Move => !!m);
      if (options.length) {
        const move = options[Math.floor(Math.random() * options.length)];
        setTimeout(() => {
          if (t !== token || get().phase !== "playing" || get().tree.last !== node) return;
          set({ thinking: false });
          commit(move);
        }, 500 + Math.random() * 700);
        return;
      }
    }
    if (!engine) return;
    let go = "go movetime 1200";
    if (maiaMode) go = "go nodes 1";
    else if (hasClock(s)) {
      // The computer is told it has a quarter of its real clock, so it keeps a brisk pace.
      const engineColor: Color = s.humanColor === "white" ? "black" : "white";
      const ms = (c: Color) => Math.max(50, Math.round((s.clocks[c] * 1000) / (c === engineColor ? 4 : 1)));
      const inc = (c: Color) => Math.round((incrementOf(s, c) + (s.delayMode === "none" ? 0 : s.delay)) * 250);
      go = `go wtime ${ms("white")} btime ${ms("black")} winc ${inc("white")} binc ${inc("black")}`;
    }
    const started = Date.now();
    engine.search({
      position: s.tree.positionCommand(node),
      go,
      chess960: s.tree.chess960,
      variant: s.tree.rules,
      onInfo: (i) => i.multipv === 1 && set({ detail: `Depth ${i.depth}` }),
      onBest: (best) => {
        // Human-like networks answer instantly; give them a moment so the game has a rhythm.
        const wait = maiaMode ? Math.max(0, 600 + Math.random() * 900 - (Date.now() - started)) : 0;
        setTimeout(() => {
          if (t !== token || get().phase !== "playing" || get().tree.last !== node) return;
          set({ thinking: false });
          if (!best || !commit(best)) {
            const legal = [...s.tree.posAt(node).allDests()].find(([, tos]) => tos.nonEmpty());
            if (legal) commit({ from: legal[0], to: legal[1].first()! });
          }
        }, wait);
      },
    });
  };

  return {
    ...defaults,
    ...load<Partial<PlaySetup>>("playSetup", {}),
    phase: "setup",
    tree: new GameTree(),
    humanColor: "white",
    clocks: { white: 0, black: 0 },
    thinking: false,
    opponentName: "",
    detail: "",

    patch: (p) => {
      set(p);
      const s = get();
      save("playSetup", Object.fromEntries(Object.keys(defaults).map((k) => [k, s[k as keyof PlaySetup]])));
    },
    setCustomStart: (customStart) => set({ customStart }),

    start: async () => {
      const s = get();
      token++;
      engine?.quit();
      engine = undefined;
      persona = undefined;
      maiaMode = false;
      const rules = s.customStart?.rules ?? s.rules;
      const chess960 = !s.customStart && rules === "chess" && s.chess960;
      const tree = s.customStart ? new GameTree(s.customStart.fen, rules) : chess960 ? new GameTree(chess960Fen(Math.floor(Math.random() * 960)), "chess", true) : rules === "chess" ? new GameTree(START_FEN) : GameTree.variantStart(rules);
      const humanColor: Color = s.side === "random" ? (Math.random() < 0.5 ? "white" : "black") : s.side;
      let opponentName = "";
      set({ error: undefined });
      try {
        if (s.opponent !== "human") {
          let entry = resolveEngine(s.engineId);
          const overrides: Record<string, string> = {};
          let elo: number | undefined = s.limit ? s.elo : undefined;
          if (rules !== "chess") {
            entry = entryOf("fairy-stockfish");
            if (!entry?.path) throw new Error("Variants need Fairy-Stockfish. Install it from the Engines page.");
          } else if (s.opponent === "persona") {
            persona = PERSONALITIES.find((p) => p.id === s.personaId) ?? PERSONALITIES[3];
            opponentName = persona.name;
            elo = persona.rating >= 3000 ? undefined : persona.rating;
            const lc0 = entryOf("lc0");
            if (persona.maia && lc0?.path && (await installedMaia()).includes(persona.maia) && !chess960) {
              entry = lc0;
              overrides.WeightsFile = `${await maiaDir()}/maia-${persona.maia}.pb.gz`;
              overrides.Threads = "1";
              maiaMode = true;
              elo = undefined;
            } else {
              entry = entryOf("stockfish")?.path ? entryOf("stockfish") : resolveEngine();
            }
          }
          if (!entry) throw new Error("No engine is installed.");
          const e = await launch(entry, overrides);
          if (elo !== undefined) {
            const opt = e.option("UCI_Elo");
            if (e.option("UCI_LimitStrength") && opt) {
              e.setOption("UCI_LimitStrength", "true");
              e.setOption("UCI_Elo", String(Math.min(Math.max(elo, opt.min ?? 0), opt.max ?? 4000)));
            } else if (e.option("Skill Level")) {
              const o = e.option("Skill Level")!;
              const lo = o.min ?? 0, hi = o.max ?? 20;
              e.setOption("Skill Level", String(Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, (elo - 800) / 2000)))));
            }
          }
          e.send("ucinewgame");
          e.onExit = () => set({ thinking: false });
          engine = e;
          opponentName ||= entry.name;
        }
      } catch (e: any) {
        set({ error: String(e.message ?? e) });
        return;
      }
      const seconds = s.minutes * 60;
      const blackSeconds = s.handicap ? s.blackMinutes * 60 : seconds;
      tree.headers.set("Event", s.opponent === "human" ? "Over-the-board game" : s.opponent === "persona" ? `Game against ${opponentName}` : "Game against the computer");
      if (hasClock(s)) tree.headers.set("TimeControl", s.handicap ? `${seconds}+${s.increment} / ${blackSeconds}+${s.blackIncrement}` : `${seconds}+${s.increment}${s.delayMode !== "none" ? ` d${s.delay}` : ""}`);
      if (s.opponent !== "human") {
        tree.headers.set("White", humanColor === "white" ? "Me" : opponentName);
        tree.headers.set("Black", humanColor === "black" ? "Me" : opponentName);
      }
      set({ tree, humanColor, opponentName, outcome: undefined, thinking: false, phase: "playing", clocks: { white: seconds, black: blackSeconds }, detail: "" });
      moveStartedAt = Date.now();
      lastTick = Date.now();
      clearInterval(timer);
      timer = setInterval(() => {
        const st = get();
        const now = Date.now();
        const dt = (now - lastTick) / 1000;
        lastTick = now;
        if (st.phase !== "playing" || !hasClock(st) || !st.tree.last.parent) return;
        const mover = st.tree.last.turn;
        // Simple delay: the clock waits before it starts to run.
        if (st.delayMode === "simple" && now - moveStartedAt < st.delay * 1000) return;
        const left = Math.max(0, st.clocks[mover] - dt);
        set({ clocks: { ...st.clocks, [mover]: left } });
        if (left <= 0) finish({ result: mover === "white" ? "0-1" : "1-0", reason: "Time out" });
      }, 100);
      if (s.opponent !== "human" && tree.current.turn !== humanColor) engineMove();
    },

    humanMove: (move) => {
      const s = get();
      if (s.phase !== "playing" || s.thinking || s.tree.current !== s.tree.last) return;
      if (s.opponent !== "human" && s.tree.last.turn !== s.humanColor) return;
      if (commit(move) && get().phase === "playing" && s.opponent !== "human") engineMove();
    },

    resign: () => {
      const s = get();
      if (s.phase !== "playing") return;
      const loser = s.opponent === "human" ? s.tree.last.turn : s.humanColor;
      finish({ result: loser === "white" ? "0-1" : "1-0", reason: "Resignation" });
    },

    takeBack: () => {
      const s = get();
      if (s.phase !== "playing" || s.thinking) return;
      s.tree.toEnd();
      const steps = s.opponent !== "human" && s.tree.last.turn === s.humanColor ? 2 : 1;
      for (let i = 0; i < steps && s.tree.current.parent; i++) s.tree.delete(s.tree.current);
    },

    backToSetup: () => {
      token++;
      clearInterval(timer);
      engine?.quit();
      engine = undefined;
      set({ phase: "setup", thinking: false });
    },
  };
});
