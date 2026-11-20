import { parseSan } from "chessops/san";
import type { Move, Rules } from "chessops/types";
import { create } from "zustand";
import { chess960Fen, Color, GameTree, GNode, Outcome, START_FEN, uciOf } from "./chess";
import { Analysis, ChatLine, Commentator, Hint, styleBonus } from "./coach";
import { courseById, parseLine } from "./courses";
import { db } from "./db";
import { entryOf, launch, resolveEngine, type EngineEntry } from "./engines";
import { openingFor } from "./openings";
import { bookMoves, installedMaia, maiaDir, personaById, Personality } from "./personalities";
import { Sound } from "./sound";
import { load, save } from "./storage";
import { eloRange, levelForElo, ModelEngine, paramsForLevel, pickMove, StrengthParams } from "./strength";
import { Engine, searchOnce } from "./uci";

export interface PlaySetup {
  /** "online" hands the Play page over to Castle Online. */
  opponent: "engine" | "persona" | "human" | "online";
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
  /** How strongly a coach plays. */
  coachElo: number;
  /** A coach's course whose lines the game follows, "" for none. */
  courseId: string;
  /** Opponents talk during the game. */
  talk: boolean;
  /** …and their lines are read aloud. */
  speak: boolean;
}

export interface ChatMessage {
  id: number;
  who: "them" | "system";
  text: string;
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
  /** The personality or coach being played, if any. */
  persona?: Personality;
  /** The rating the opponent is playing at, when it is limited. */
  opponentElo?: number;
  detail: string;
  error?: string;
  chat: ChatMessage[];
  hint?: Hint;
  /** Whether hints and commentary are available (a second engine is analysing). */
  coaching: boolean;
  patch: (p: Partial<PlaySetup>) => void;
  setCustomStart: (c?: { fen: string; rules: Rules }) => void;
  start: () => Promise<void>;
  humanMove: (move: Move) => void;
  resign: () => void;
  takeBack: () => void;
  askHint: () => void;
  backToSetup: () => void;
}

let engine: Engine | undefined;
let maiaEngine: Engine | undefined;
let analyst: Engine | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let lastTick = Date.now();
let persona: Personality | undefined;
let strength: { params: StrengthParams; kind: ModelEngine } | undefined;
let book: string[] = [];
let wasInBook = false;
/** You left the course's lines, so the coach doesn't also announce the end of its book. */
let leftCourse = false;
let commentator: Commentator | undefined;
let analyses = new Map<string, Promise<Analysis | undefined>>();
let analystQueue: Promise<unknown> = Promise.resolve();
let hintLevel = 0;
let chatId = 0;
let token = 0;

const defaults: PlaySetup = {
  opponent: "engine", side: "white", engineId: "wasabi", personaId: "amara", minutes: 10, increment: 5, limit: true, elo: 1500, rules: "chess", chess960: false,
  handicap: false, blackMinutes: 10, blackIncrement: 5, delay: 0, delayMode: "none", coachElo: 1200, courseId: "", talk: true, speak: false,
};

export const hasClock = (s: PlaySetup) => s.minutes > 0 || (s.handicap && s.blackMinutes > 0);
const incrementOf = (s: PlaySetup, c: Color) => (s.handicap && c === "black" ? s.blackIncrement : s.increment);
let moveStartedAt = Date.now();

/** Which measured strength table an engine uses. */
export const modelEngineOf = (entry?: EngineEntry): ModelEngine => (entry?.id === "wasabi" ? "wasabi" : "stockfish");

/**
 * The engine a personality or coach plays a rating with: Stockfish when it's
 * installed and its measured range covers the rating, otherwise the bundled
 * Wasabi if its range does (it goes lower: it is weaker at the same depth), and
 * otherwise whichever comes closest.
 */
export function personaEngine(rating?: number): EngineEntry | undefined {
  const stockfish = entryOf("stockfish")?.path ? entryOf("stockfish") : undefined;
  const wasabi = entryOf("wasabi")?.path ? entryOf("wasabi") : undefined;
  const covers = (e: EngineEntry | undefined) => { if (!e || rating === undefined) return false; const [lo, hi] = eloRange(modelEngineOf(e)); return rating >= lo && rating <= hi; };
  if (covers(stockfish)) return stockfish;
  if (covers(wasabi)) return wasabi;
  if (stockfish && wasabi && rating !== undefined) return rating < eloRange("stockfish")[0] ? wasabi : stockfish;
  return stockfish ?? wasabi ?? resolveEngine();
}

/** The range of ratings personalities can play at with the engines installed. */
export function personaRange(): [number, number] {
  const kinds = [entryOf("stockfish")?.path ? "stockfish" : undefined, entryOf("wasabi")?.path ? "wasabi" : undefined].filter(Boolean) as ModelEngine[];
  if (!kinds.length) return eloRange(modelEngineOf(resolveEngine()));
  return [Math.min(...kinds.map((k) => eloRange(k)[0])), Math.max(...kinds.map((k) => eloRange(k)[1]))];
}

/** The SAN lines a course plays, as a book. */
export function courseBook(courseId: string): string[] {
  const course = courseById(courseId);
  return course ? course.chapters.map((c) => parseLine(c.line).map((m) => m.san).join(" ")) : [];
}

/** Reads a line aloud, in a voice that suits the opponent. */
function speakLine(text: string, p?: Personality) {
  if (typeof speechSynthesis === "undefined") return;
  const u = new SpeechSynthesisUtterance(text);
  const seed = [...(p?.id ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0);
  u.pitch = 0.8 + (seed % 7) / 10;
  u.rate = p?.temperament === "cheerful" || p?.temperament === "showman" ? 1.1 : 1;
  speechSynthesis.speak(u);
}

export const usePlay = create<PlayState>((set, get) => {
  const say = (lines: (ChatLine | undefined)[] | ChatLine | undefined, t = token) => {
    if (t !== token) return;
    const list = (Array.isArray(lines) ? lines : [lines]).filter((l): l is ChatLine => !!l);
    if (!list.length || !get().talk) return;
    set({ chat: [...get().chat, ...list.map((l) => ({ id: ++chatId, who: "them" as const, text: l.text }))].slice(-80) });
    if (get().speak) for (const l of list) speakLine(l.text, persona);
  };

  /** The analyst's view of a position, worked out once, one position at a time. */
  const analysisOf = (fen: string): Promise<Analysis | undefined> => {
    let p = analyses.get(fen);
    if (!p) {
      const a = analyst;
      if (!a) return Promise.resolve(undefined);
      p = analystQueue.then(async () => {
        if (a.state === "stopped") return undefined;
        const r = await searchOnce(a, { position: `position fen ${fen}`, go: "go depth 14 movetime 700" });
        return r.info ? { score: r.info.score, pv: r.info.pv } : undefined;
      });
      analystQueue = p.catch(() => undefined);
      analyses.set(fen, p);
    }
    return p;
  };

  const quitEngines = () => {
    for (const e of [engine, maiaEngine, analyst]) e?.quit();
    engine = maiaEngine = analyst = undefined;
  };

  const finish = (o: Outcome) => {
    const s = get();
    clearInterval(timer);
    quitEngines();
    s.tree.headers.set("Termination", o.reason);
    s.tree.result = o.result;
    set({ outcome: o, phase: "finished", thinking: false, hint: undefined });
    Sound.end();
    say(commentator?.end(o.result));
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
    // The analyst looks at each new position while the next move is being thought about.
    else if (analyst) analysisOf(node.fen);
    return true;
  };

  /** Says what the opening is, the first time it gets a (new) name. */
  const nameOpening = (node: GNode) => {
    const s = get();
    if (!commentator || s.tree.mainline.length > 20) return;
    const o = openingFor(s.tree, node);
    if (o) say(commentator.opening(o.name));
  };

  /** The opponent's comments on its own move, once the analyst has seen both positions. */
  const afterOwnMove = (before: GNode, uci: string, after: GNode) => {
    const c = commentator;
    if (!c) return;
    const t = token;
    nameOpening(after);
    if (get().phase !== "playing") return;
    Promise.all([analysisOf(before.fen), analysisOf(after.fen)]).then(([a, b]) => say(c.ownMove(before.fen, uci, after.fen, a, b), t));
  };

  const playOwn = (move: Move | string, node: GNode) => {
    const s = get();
    const pos = s.tree.posAt(node);
    const uci = typeof move === "string" ? move : uciOf(pos, move, s.tree.chess960);
    set({ thinking: false });
    if (commit(move)) afterOwnMove(node, uci, get().tree.last);
  };

  const engineMove = () => {
    const s = get();
    if (s.phase !== "playing") return;
    const node = s.tree.last;
    const t = token;
    const live = () => t === token && get().phase === "playing" && get().tree.last === node;
    set({ thinking: true, detail: "", hint: undefined });

    // Personalities and coaches play their favourite openings (or the course's lines) from memory.
    if (persona && s.tree.isStandardStart) {
      const pos = s.tree.posAt(node);
      const options = bookMoves({ ...persona, book }, s.tree.mainline.map((n) => n.san)).map((san) => parseSan(pos, san)).filter((m): m is Move => !!m);
      if (options.length) {
        wasInBook = true;
        const move = options[Math.floor(Math.random() * options.length)];
        setTimeout(() => live() && playOwn(move, node), 500 + Math.random() * 700);
        return;
      }
      if (wasInBook && commentator) {
        wasInBook = false;
        if (!leftCourse) say(commentator.leftBook());
      }
    }
    if (!engine) return;
    const position = s.tree.positionCommand(node);
    const engineColor: Color = s.humanColor === "white" ? "black" : "white";
    const started = Date.now();

    // Limited strength: pick among the engine's candidates the way a player of that rating would.
    if (strength) {
      const { params } = strength;
      const human = maiaEngine ? searchOnce(maiaEngine, { position, go: "go nodes 1" }).then((r) => r.best) : Promise.resolve(undefined);
      set({ detail: "" });
      Promise.all([searchOnce(engine, { position, go: `go depth ${params.depth}`, multipv: params.multipv, chess960: s.tree.chess960, variant: s.tree.rules }), human]).then(([r, humanMove]) => {
        if (!live()) return;
        const candidates = r.lines.filter((l) => l.pv.length).map((l) => ({ move: l.pv[0], score: l.score }));
        const pick = pickMove(candidates, params, Math.random, s.tree.rules === "chess" && !s.tree.chess960 ? styleBonus(persona?.leaning, node.fen, humanMove) : undefined);
        const choice = pick?.move ?? r.best;
        // People take a moment, more when they have time; the clock still runs while they do.
        const budget = hasClock(s) ? Math.min(2500, (get().clocks[engineColor] * 1000) / 40) : 1800;
        const wait = Math.max(0, Math.min(budget, 350 + Math.random() * 1300) - (Date.now() - started));
        setTimeout(() => {
          if (!live()) return;
          if (!choice) return fallback(node);
          playOwn(choice, node);
        }, wait);
      });
      return;
    }

    let go = "go movetime 1200";
    if (hasClock(s)) {
      // The computer is told it has a quarter of its real clock, so it keeps a brisk pace.
      const ms = (c: Color) => Math.max(50, Math.round((s.clocks[c] * 1000) / (c === engineColor ? 4 : 1)));
      const inc = (c: Color) => Math.round((incrementOf(s, c) + (s.delayMode === "none" ? 0 : s.delay)) * 250);
      go = `go wtime ${ms("white")} btime ${ms("black")} winc ${inc("white")} binc ${inc("black")}`;
    }
    engine.search({
      position,
      go,
      chess960: s.tree.chess960,
      variant: s.tree.rules,
      onInfo: (i) => i.multipv === 1 && set({ detail: `Depth ${i.depth}` }),
      onBest: (best) => {
        if (!live()) return;
        if (!best) return fallback(node);
        playOwn(best, node);
      },
    });
  };

  /** Any legal move, when the engine gives none. */
  const fallback = (node: GNode) => {
    set({ thinking: false });
    const legal = [...get().tree.posAt(node).allDests()].find(([, tos]) => tos.nonEmpty());
    if (legal) commit({ from: legal[0], to: legal[1].first()! });
  };

  /** The move the course expects you to play here, if the game is still on one of its lines. */
  const courseMove = (node: GNode): string | undefined => {
    const s = get();
    if (!s.courseId || s.opponent !== "persona" || !persona?.coach || !s.tree.isStandardStart) return undefined;
    const played = s.tree.path(node).map((n) => n.san);
    const next = bookMoves({ ...persona, book: courseBook(s.courseId) }, played);
    if (!next.length) return undefined;
    const pos = s.tree.posAt(node);
    const m = parseSan(pos, next[0]);
    return m ? uciOf(pos, m, false) : undefined;
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
    chat: [],
    coaching: false,

    patch: (p) => {
      set(p);
      const s = get();
      save("playSetup", Object.fromEntries(Object.keys(defaults).map((k) => [k, s[k as keyof PlaySetup]])));
      if (p.speak === false && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    setCustomStart: (customStart) => set({ customStart }),

    start: async () => {
      const s = get();
      if (s.opponent === "online") return;
      token++;
      quitEngines();
      persona = undefined;
      strength = undefined;
      commentator = undefined;
      analyses = new Map();
      analystQueue = Promise.resolve();
      hintLevel = 0;
      wasInBook = false;
      leftCourse = false;
      book = [];
      const rules = s.customStart?.rules ?? s.rules;
      const chess960 = !s.customStart && rules === "chess" && s.chess960;
      const tree = s.customStart ? new GameTree(s.customStart.fen, rules) : chess960 ? new GameTree(chess960Fen(Math.floor(Math.random() * 960)), "chess", true) : rules === "chess" ? new GameTree(START_FEN) : GameTree.variantStart(rules);
      const course = s.courseId ? courseById(s.courseId) : undefined;
      const humanColor: Color = course && s.opponent === "persona" && personaById(s.personaId)?.coach ? course.side : s.side === "random" ? (Math.random() < 0.5 ? "white" : "black") : s.side;
      let opponentName = "";
      let opponentElo: number | undefined;
      set({ error: undefined });
      try {
        if (s.opponent !== "human") {
          let entry = resolveEngine(s.engineId);
          let target: number | undefined = s.limit ? s.elo : undefined;
          if (s.opponent === "persona") {
            persona = personaById(s.personaId) ?? personaById("amara")!;
            opponentName = persona.name;
            target = persona.coach ? s.coachElo : persona.rating >= 3000 ? undefined : persona.rating;
            book = persona.coach && course && persona.coach.courses.includes(course.id) ? courseBook(course.id) : persona.book;
            entry = personaEngine(target);
          }
          if (rules !== "chess") {
            entry = entryOf("fairy-stockfish");
            if (!entry?.path) throw new Error("Variants need Fairy-Stockfish. Install it from the Engines page.");
          }
          if (!entry) throw new Error("No engine is installed.");
          const e = await launch(entry);
          const kind = modelEngineOf(entry);
          if (target !== undefined && e.option("MultiPV")) {
            // Each engine can only play so strongly this way; above that, it plays at its best.
            const [lo, hi] = eloRange(kind);
            opponentElo = Math.min(hi, Math.max(lo, target));
            strength = { params: paramsForLevel(levelForElo(opponentElo, kind)), kind };
            // As when the ratings were measured: one thread and a small hash, so a depth means the same strength.
            e.setOption("Threads", "1");
            e.setOption("Hash", "16");
          } else if (target !== undefined) {
            // An engine that can't list candidates is limited the way it offers.
            const opt = e.option("UCI_Elo");
            if (e.option("UCI_LimitStrength") && opt) {
              e.setOption("UCI_LimitStrength", "true");
              e.setOption("UCI_Elo", String(Math.min(Math.max(target, opt.min ?? 0), opt.max ?? 4000)));
              opponentElo = Math.max(target, opt.min ?? 0);
            } else if (e.option("Skill Level")) {
              const o = e.option("Skill Level")!;
              const lo = o.min ?? 0, hi = o.max ?? 20;
              e.setOption("Skill Level", String(Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, (target - 800) / 2000)))));
            }
          }
          e.send("ucinewgame");
          e.onExit = () => set({ thinking: false });
          engine = e;
          opponentName ||= entry.name;
          // Human-like choices from a Maia network, when it's installed.
          const lc0 = entryOf("lc0");
          if (persona?.maia && strength && lc0?.path && rules === "chess" && !chess960 && (await installedMaia()).includes(persona.maia)) {
            maiaEngine = await launch(lc0, { WeightsFile: `${await maiaDir()}/maia-${persona.maia}.pb.gz`, Threads: "1" }).catch(() => undefined);
          }
          // A second engine watches the game, so the opponent can comment and coaches can give hints.
          if (persona && rules === "chess" && !chess960 && (s.talk || persona.coach)) {
            analyst = await launch(entry, { Threads: "1" }).catch(() => undefined);
            commentator = new Commentator(persona, humanColor === "white" ? "black" : "white");
          }
        }
      } catch (e: any) {
        quitEngines();
        set({ error: String(e.message ?? e) });
        return;
      }
      const seconds = s.minutes * 60;
      const blackSeconds = s.handicap ? s.blackMinutes * 60 : seconds;
      tree.headers.set("Event", s.opponent === "human" ? "Over-the-board game" : s.opponent === "persona" ? `Game against ${opponentName}` : "Game against the computer");
      if (hasClock(s)) tree.headers.set("TimeControl", s.handicap ? `${seconds}+${s.increment} / ${blackSeconds}+${s.blackIncrement}` : `${seconds}+${s.increment}${s.delayMode !== "none" ? ` d${s.delay}` : ""}`);
      if (s.opponent !== "human") {
        const them = humanColor === "white" ? "Black" : "White";
        tree.headers.set("White", humanColor === "white" ? "Me" : opponentName);
        tree.headers.set("Black", humanColor === "black" ? "Me" : opponentName);
        if (opponentElo) tree.headers.set(`${them}Elo`, String(Math.round(opponentElo)));
      }
      set({
        tree, humanColor, opponentName, opponentElo, persona, outcome: undefined, thinking: false, phase: "playing", clocks: { white: seconds, black: blackSeconds },
        detail: "", chat: [], hint: undefined, coaching: !!analyst,
      });
      if (commentator) say(commentator.hello());
      if (course && persona?.coach && s.courseId) set({ chat: [...get().chat, { id: ++chatId, who: "system", text: `Practising the ${course.name}. ${persona.name} will follow the course's lines and tell you when you leave them.` }] });
      if (analyst) analysisOf(tree.last.fen);
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
      const before = s.tree.last;
      const uci = uciOf(s.tree.posAt(before), move, s.tree.chess960);
      const expected = courseMove(before);
      if (!commit(move)) return;
      hintLevel = 0;
      set({ hint: undefined });
      const after = get().tree.last;
      if (commentator && get().phase === "playing") {
        const c = commentator, t = token;
        // Leaving the course is said straight away; the rest once the analyst has seen the move.
        if (expected && expected !== uci && !leftCourse) {
          leftCourse = true;
          say(c.offCourse(before.fen, expected));
        }
        nameOpening(after);
        Promise.all([analysisOf(before.fen), analysisOf(after.fen)]).then(([a, b]) => say(c.yourMove(before.fen, uci, after.fen, a, b), t));
      }
      if (get().phase === "playing" && s.opponent !== "human") engineMove();
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
      hintLevel = 0;
      set({ hint: undefined });
      if (commentator) say(commentator.takeback());
    },

    askHint: () => {
      const s = get();
      if (s.phase !== "playing" || !commentator || s.tree.last.turn !== s.humanColor) return;
      const node = s.tree.last;
      const c = commentator, t = token;
      hintLevel = Math.min(2, hintLevel + 1);
      const level = hintLevel as 1 | 2;
      analysisOf(node.fen).then((a) => {
        if (t !== token || get().tree.last !== node || !a) return;
        const hint = c.hint(node.fen, a, level);
        if (!hint) return;
        set({ hint, chat: [...get().chat, { id: ++chatId, who: "them", text: hint.text }] });
        if (get().speak) speakLine(hint.text, persona);
      });
    },

    backToSetup: () => {
      token++;
      clearInterval(timer);
      quitEngines();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
      set({ phase: "setup", thinking: false, hint: undefined });
    },
  };
});
