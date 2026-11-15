import { listen } from "@tauri-apps/api/event";
import { call, isTauri } from "./storage";

export interface UciOption {
  name: string;
  kind: "spin" | "check" | "combo" | "button" | "string";
  default: string;
  min?: number;
  max?: number;
  choices: string[];
}

/** One principal variation. The score is from the point of view of the side to move. */
export interface EngineInfo {
  multipv: number;
  depth: number;
  seldepth: number;
  score: { cp: number } | { mate: number };
  nodes: number;
  nps: number;
  time: number;
  pv: string[];
}

export interface SearchJob {
  position: string;
  go: string;
  multipv?: number;
  chess960?: boolean;
  variant?: string;
  onInfo?: (info: EngineInfo) => void;
  onBest?: (move: string | undefined) => void;
}

type State = "stopped" | "starting" | "idle" | "searching" | "stopping";

const engines = new Map<string, Engine>();
let wired = false;
let counter = 0;

function wire() {
  if (wired || !isTauri) return;
  wired = true;
  listen<{ id: string; lines: string[] }>("engine-output", (e) => engines.get(e.payload.id)?.receive(e.payload.lines));
  listen<string>("engine-exit", (e) => engines.get(e.payload)?.exited());
}

/** A UCI engine running as a child process of the app. */
export class Engine {
  readonly id = `e${Date.now().toString(36)}-${counter++}`;
  name = "";
  author = "";
  options: UciOption[] = [];
  state: State = "stopped";
  onExit?: () => void;
  private current?: SearchJob;
  private pending?: SearchJob;
  private applied = new Map<string, string>();
  private ready?: () => void;

  constructor(readonly path: string, private settings: Record<string, string> = {}) {}

  /** Starts the process and resolves once the engine has answered `readyok`. */
  start(): Promise<void> {
    wire();
    if (this.state !== "stopped") return Promise.resolve();
    engines.set(this.id, this);
    this.state = "starting";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("The engine did not answer.")), 15000);
      this.ready = () => {
        clearTimeout(timer);
        resolve();
      };
      call("engine_start", { id: this.id, path: this.path })
        .then(() => this.send("uci"))
        .catch((e) => {
          clearTimeout(timer);
          this.state = "stopped";
          engines.delete(this.id);
          reject(new Error(String(e)));
        });
    });
  }

  send(line: string) {
    call("engine_send", { id: this.id, line }).catch(() => {});
  }

  option(name: string) {
    return this.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
  }

  setOption(name: string, value: string) {
    const opt = this.option(name);
    if (!opt) return;
    if (opt.kind === "button") return this.send(`setoption name ${opt.name}`);
    if (this.applied.get(opt.name) === value) return;
    this.applied.set(opt.name, value);
    this.send(`setoption name ${opt.name} value ${value}`);
  }

  /** Starts a search, replacing any search already running. */
  search(job: SearchJob) {
    this.pending = job;
    if (this.state === "idle") this.startPending();
    else if (this.state === "searching") {
      this.send("stop");
      this.state = "stopping";
    }
  }

  /** Cancels the running search; its best move is discarded. */
  stop() {
    this.pending = undefined;
    if (this.state === "searching") {
      this.send("stop");
      this.state = "stopping";
    }
  }

  newGame() {
    if (this.state === "idle") this.send("ucinewgame");
  }

  quit() {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.current = undefined;
    this.pending = undefined;
    engines.delete(this.id);
    call("engine_kill", { id: this.id }).catch(() => {});
  }

  private startPending() {
    const job = this.pending;
    if (!job || this.state !== "idle") return;
    this.pending = undefined;
    this.current = job;
    if (job.multipv) this.setOption("MultiPV", String(job.multipv));
    this.setOption("UCI_Chess960", job.chess960 ? "true" : "false");
    if (this.option("UCI_Variant")) this.setOption("UCI_Variant", job.variant ?? "chess");
    this.send(job.position);
    this.send(job.go);
    this.state = "searching";
  }

  exited() {
    if (this.state === "stopped") return;
    const job = this.current;
    this.state = "stopped";
    this.current = undefined;
    this.pending = undefined;
    engines.delete(this.id);
    job?.onBest?.(undefined);
    this.onExit?.();
  }

  receive(lines: string[]) {
    for (const line of lines) this.handle(line);
  }

  private handle(line: string) {
    if (line.startsWith("info ")) {
      if (this.state !== "searching" || !this.current?.onInfo) return;
      const info = parseInfo(line);
      if (info) this.current.onInfo(info);
    } else if (line.startsWith("bestmove")) {
      const move = line.split(" ")[1];
      const job = this.current;
      const was = this.state;
      this.current = undefined;
      if (was === "searching" || was === "stopping") this.state = "idle";
      if (was === "searching") job?.onBest?.(move && move !== "(none)" && move !== "0000" ? move : undefined);
      this.startPending();
    } else if (line.startsWith("id name ")) {
      this.name = line.slice(8);
    } else if (line.startsWith("id author ")) {
      this.author = line.slice(10);
    } else if (line.startsWith("option name ")) {
      const opt = parseOption(line);
      if (opt) this.options.push(opt);
    } else if (line === "uciok") {
      for (const [k, v] of Object.entries(this.settings)) this.setOption(k, v);
      this.send("isready");
    } else if (line === "readyok" && this.state === "starting") {
      this.state = "idle";
      this.ready?.();
      this.startPending();
    }
  }
}

export function parseOption(line: string): UciOption | undefined {
  const words = line.split(/\s+/);
  const t = words.indexOf("type");
  if (t < 3 || t + 1 >= words.length) return undefined;
  const kind = words[t + 1] as UciOption["kind"];
  if (!["spin", "check", "combo", "button", "string"].includes(kind)) return undefined;
  const opt: UciOption = { name: words.slice(2, t).join(" "), kind, default: "", choices: [] };
  let i = t + 2;
  while (i < words.length) {
    const key = words[i++];
    const value: string[] = [];
    while (i < words.length && !["default", "min", "max", "var"].includes(words[i])) value.push(words[i++]);
    const text = value.join(" ");
    if (key === "default") opt.default = text;
    else if (key === "min") opt.min = parseInt(text, 10);
    else if (key === "max") opt.max = parseInt(text, 10);
    else if (key === "var") opt.choices.push(text);
  }
  return opt;
}

export function parseInfo(line: string): EngineInfo | undefined {
  const w = line.split(/\s+/);
  const info: EngineInfo = { multipv: 1, depth: 0, seldepth: 0, score: { cp: 0 }, nodes: 0, nps: 0, time: 0, pv: [] };
  let hasScore = false;
  for (let i = 1; i < w.length; ) {
    const n = () => parseInt(w[i + 1] ?? "0", 10) || 0;
    switch (w[i]) {
      case "depth": info.depth = n(); i += 2; break;
      case "seldepth": info.seldepth = n(); i += 2; break;
      case "multipv": info.multipv = Math.max(1, n()); i += 2; break;
      case "nodes": info.nodes = n(); i += 2; break;
      case "nps": info.nps = n(); i += 2; break;
      case "time": info.time = n(); i += 2; break;
      case "score": {
        const v = parseInt(w[i + 2] ?? "0", 10) || 0;
        info.score = w[i + 1] === "mate" ? { mate: v } : { cp: v };
        hasScore = true;
        i += 3;
        if (w[i] === "lowerbound" || w[i] === "upperbound") return undefined;
        break;
      }
      case "pv": info.pv = w.slice(i + 1); i = w.length; break;
      case "string": return undefined;
      default: i += 1;
    }
  }
  return hasScore && info.pv.length ? info : undefined;
}

/** Runs one search and resolves with the last line reported and the best move. */
export function searchOnce(engine: Engine, job: Omit<SearchJob, "onInfo" | "onBest">): Promise<{ info?: EngineInfo; best?: string; lines: EngineInfo[] }> {
  return new Promise((resolve) => {
    const lines = new Map<number, EngineInfo>();
    engine.search({
      ...job,
      onInfo: (i) => lines.set(i.multipv, i),
      onBest: (best) => resolve({ info: lines.get(1), best, lines: [...lines.values()].sort((a, b) => a.multipv - b.multipv) }),
    });
  });
}
