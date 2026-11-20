// Measures the rating each level of Castle's strength model (src/lib/strength.ts) plays at.
//
// Levels from about 1300 up play Stockfish limited to known ratings (UCI_Elo, anchored
// to the CCRL list). Below that, where Stockfish can't go, levels play the model's own
// levels that were measured first. Each level's rating is the one that best explains
// its results (maximum likelihood on the Elo curve). Paste the table it prints into
// CALIBRATION in src/lib/strength.ts.
//
//   node scripts/calibrate-strength.mjs [games-per-pairing] [parallel games]
//   MODEL_ENGINE=src-tauri/resources/wasabi/wasabi-2.1-macos node scripts/calibrate-strength.mjs
//
// Needs Stockfish on the PATH (or STOCKFISH=/path/to/stockfish), and the server's
// development tools (cd server && npm ci). Takes a while.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// esbuild comes with the server's development tools (cd server && npm ci).
const { build } = createRequire(path.join(root, "server/package.json"))("esbuild");
const out = path.join(os.tmpdir(), `castle-strength-${process.pid}.mjs`);
await build({
  stdin: { contents: `export * from "./src/lib/strength";\nexport { Chess } from "chessops/chess";\nexport { parseUci, makeUci } from "chessops/util";\nexport { makeFen } from "chessops/fen";`, resolveDir: root, loader: "ts" },
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", nodePaths: [path.join(root, "node_modules")],
});
const { paramsForLevel, pickMove, seeded, Chess, parseUci, makeFen } = await import(pathToFileURL(out).href);

const STOCKFISH = process.env.STOCKFISH || "stockfish";
// The engine the model searches with. Each engine gets its own table, since the same depth plays differently.
const MODEL_ENGINE = process.env.MODEL_ENGINE || STOCKFISH;
// Stockfish's UCI_Elo is calibrated at 60 seconds plus 0.6 a move, so its opponents get that clock.
const [BASE_MS, INC_MS] = (process.env.TC || "60+0.6").split("+").map((x) => Math.round(Number(x) * 1000));
const PER_PAIR = Number(process.argv[2] || 16);
const PARALLEL = Number(process.argv[3] || Math.max(2, Math.floor(os.cpus().length / 2) - 1));

class Uci {
  constructor(bin) {
    this.p = spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    this.buf = "";
    this.waiters = [];
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        for (const w of [...this.waiters]) w(line);
      }
    });
  }
  send(s) { this.p.stdin.write(s + "\n"); }
  until(pred) {
    return new Promise((resolve) => {
      const w = (line) => { if (pred(line)) { this.waiters.splice(this.waiters.indexOf(w), 1); resolve(line); } };
      this.waiters.push(w);
    });
  }
  async init(options) {
    this.send("uci");
    await this.until((l) => l === "uciok");
    for (const [k, v] of Object.entries(options)) this.send(`setoption name ${k} value ${v}`);
    this.send("isready");
    await this.until((l) => l === "readyok");
  }
  /** Runs a search and returns the final line for each multipv, and the best move. */
  async go(moves, go) {
    const lines = new Map();
    const collect = (l) => {
      if (!l.startsWith("info ") || !l.includes(" pv ") || / (lower|upper)bound/.test(l)) return;
      const w = l.split(" ");
      const k = Number(w[w.indexOf("multipv") + 1] || 1);
      const s = w.indexOf("score");
      const score = w[s + 1] === "mate" ? { mate: Number(w[s + 2]) } : { cp: Number(w[s + 2]) };
      lines.set(k, { move: w[w.indexOf("pv") + 1], score });
    };
    this.waiters.push(collect);
    this.send(`position startpos${moves.length ? " moves " + moves.join(" ") : ""}`);
    this.send(go);
    const best = (await this.until((l) => l.startsWith("bestmove"))).split(" ")[1];
    this.waiters.splice(this.waiters.indexOf(collect), 1);
    return { best, lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v) };
  }
  quit() { this.send("quit"); setTimeout(() => this.p.kill(), 500); }
}

/** A player: a model level, or Stockfish at a rating. */
async function makePlayer(spec, seed) {
  const e = new Uci(spec.kind === "sf" ? STOCKFISH : MODEL_ENGINE);
  if (spec.kind === "sf") {
    await e.init({ Threads: 1, Hash: 16, UCI_LimitStrength: "true", UCI_Elo: spec.elo });
    return { e, move: async (moves, clocks) => (await e.go(moves, `go wtime ${clocks.white} btime ${clocks.black} winc ${INC_MS} binc ${INC_MS}`)).best };
  }
  const params = paramsForLevel(spec.level);
  const random = seeded(seed);
  await e.init({ Threads: 1, Hash: 16, MultiPV: params.multipv });
  return {
    e,
    move: async (moves) => {
      const r = await e.go(moves, `go depth ${params.depth}`);
      return pickMove(r.lines, params, random)?.move ?? r.best;
    },
  };
}

// Short, balanced openings so games differ; each is played with both colours.
const OPENINGS = [
  "e2e4 e7e5 g1f3 b8c6", "e2e4 c7c5 g1f3 d7d6", "d2d4 d7d5 c2c4 e7e6", "d2d4 g8f6 c2c4 g7g6", "e2e4 e7e6 d2d4 d7d5",
  "e2e4 c7c6 d2d4 d7d5", "c2c4 e7e5 b1c3 g8f6", "g1f3 d7d5 g2g3 g8f6", "d2d4 d7d5 c1f4 g8f6", "e2e4 d7d5 e4d5 d8d5",
  "e2e4 e7e5 f1c4 g8f6", "d2d4 g8f6 c2c4 e7e6", "e2e4 c7c5 b1c3 b8c6", "e2e4 g7g6 d2d4 f8g7", "d2d4 f7f5 g2g3 g8f6", "e2e4 e7e5 g1f3 g8f6",
].map((l) => l.split(" "));

async function playGame(white, black, opening, seed) {
  const [w, b] = await Promise.all([makePlayer(white, seed), makePlayer(black, seed + 1)]);
  const pos = Chess.default();
  const moves = [];
  const seen = new Map();
  const clocks = { white: BASE_MS, black: BASE_MS };
  let result = 0.5;
  try {
    for (let ply = 0; ply < 240; ply++) {
      if (pos.isEnd()) { result = pos.isCheckmate() ? (pos.turn === "white" ? 0 : 1) : 0.5; break; }
      const key = makeFen(pos.toSetup()).split(" ").slice(0, 4).join(" ");
      seen.set(key, (seen.get(key) ?? 0) + 1);
      if (seen.get(key) >= 3 || pos.halfmoves >= 100 || pos.isInsufficientMaterial()) break;
      const mover = pos.turn === "white" ? w : b;
      const started = Date.now();
      const uci = ply < opening.length ? opening[ply] : await mover.move(moves, clocks);
      if (ply >= opening.length) clocks[pos.turn] = Math.max(100, clocks[pos.turn] - (Date.now() - started) + INC_MS);
      const m = uci && parseUci(uci);
      if (!m || !pos.isLegal(m)) { result = pos.turn === "white" ? 0 : 1; break; }
      pos.play(m);
      moves.push(uci);
    }
  } finally {
    w.e.quit(); b.e.quit();
  }
  return result; // for White
}

/** Runs tasks with at most PARALLEL at once. */
async function pool(tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (next < tasks.length) { const i = next++; results[i] = await tasks[i](); }
  }));
  return results;
}

const expected = (a, b) => 1 / (1 + 10 ** ((b - a) / 400));
/** The rating that best explains these results: [opponent rating, score][]. */
function fit(games) {
  let lo = -500, hi = 3800;
  // The derivative of the log-likelihood is sum(score - expected), which falls as the rating rises.
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const g = games.reduce((a, [opp, s]) => a + (s - expected(mid, opp)), 0);
    if (g > 0) lo = mid; else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

async function measure(level, opponents) {
  const tasks = [];
  let seed = Math.round(level * 1e6);
  for (const opp of opponents) {
    for (let i = 0; i < PER_PAIR; i++) {
      const opening = OPENINGS[Math.floor(i / 2) % OPENINGS.length];
      const asWhite = i % 2 === 0;
      const me = { kind: "model", level };
      const s = seed += 7;
      tasks.push(async () => {
        const r = await playGame(asWhite ? me : opp.spec, asWhite ? opp.spec : me, opening, s);
        return [opp.elo, asWhite ? r : 1 - r];
      });
    }
  }
  const games = await pool(tasks);
  const score = games.reduce((a, [, s]) => a + s, 0);
  return { elo: fit(games), score, n: games.length, games };
}

const table = new Map();
const started = Date.now();
const log = (s) => console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${s}`);

// From the strongest level down. While a level's rating is within Stockfish's range, it
// plays Stockfish at ratings around a guess; below that, the levels already measured
// whose ratings are nearest the guess. A lopsided result says little, so a level that
// scores under 12% or over 88% plays a second round against opponents nearer its
// first estimate. Where neighbouring levels end up more than 300 apart, the level
// halfway between them is measured too.
const SF_MIN = 1320, SF_MAX = 3190;
const opponentsNear = (elo, level) => {
  if (elo >= SF_MIN + 150) {
    const elos = [elo - 250, elo, elo + 250].map((e) => Math.min(SF_MAX, Math.max(SF_MIN, Math.round(e / 10) * 10)));
    return [...new Set(elos)].map((e) => ({ elo: e, spec: { kind: "sf", elo: e } }));
  }
  // Below Stockfish's range: the measured levels nearest in strength, and Stockfish's
  // lowest setting too while it's close enough for the results to mean something.
  const near = [...table.entries()].filter(([l]) => l !== level).sort((a, b) => Math.abs(a[1] - elo) - Math.abs(b[1] - elo)).slice(0, 2);
  const out = near.map(([l, e]) => ({ elo: e, spec: { kind: "model", level: l } }));
  if (elo >= SF_MIN - 450 || !out.length) out.unshift({ elo: SF_MIN, spec: { kind: "sf", elo: SF_MIN } });
  return out.slice(0, 3);
};
const describe = (ops) => ops.map((o) => (o.spec.kind === "sf" ? `Stockfish ${o.elo}` : `level ${o.spec.level}`)).join(", ");

async function calibrate(level, guess) {
  let opponents = opponentsNear(guess, level);
  let r = await measure(level, opponents);
  let note = `${r.score}/${r.n} against ${describe(opponents)}`;
  const frac = r.score / r.n;
  if (frac < 0.12 || frac > 0.88) {
    opponents = opponentsNear(r.elo, level);
    const again = await measure(level, opponents);
    r = { elo: fit([...r.games, ...again.games]), games: [...r.games, ...again.games] };
    note += `; then ${again.score}/${again.n} against ${describe(opponents)}`;
  }
  table.set(level, r.elo);
  log(`level ${level}: ${r.elo} (${note})`);
  return r.elo;
}

let levels = process.env.LEVELS ? process.env.LEVELS.split(",").map(Number) : [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0];
let guess = Number(process.env.GUESS || 2900);
let prev;
for (const level of levels) {
  const elo = await calibrate(level, guess);
  guess = elo - (prev === undefined ? 300 : Math.min(500, Math.max(100, prev - elo)));
  prev = elo;
}
// Fill in the steep parts.
for (let pass = 0; pass < 2; pass++) {
  const sorted = [...table.entries()].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < sorted.length; i++) {
    const [l0, e0] = sorted[i - 1], [l1, e1] = sorted[i];
    if (e1 - e0 > 300 && l1 - l0 > 0.02) await calibrate(Math.round(((l0 + l1) / 2) * 1000) / 1000, (e0 + e1) / 2);
  }
}
// Measurements are noisy; a stronger level never plays weaker, so smooth into an increasing curve.
const sorted = [...table.entries()].sort((a, b) => a[0] - b[0]);
const blocks = sorted.map(([l, e]) => ({ ls: [l], e, n: 1 }));
for (let i = 1; i < blocks.length; i++) {
  if (blocks[i].e < blocks[i - 1].e) {
    const a = blocks[i - 1], b = blocks[i];
    blocks.splice(i - 1, 2, { ls: [...a.ls, ...b.ls], e: (a.e * a.n + b.e * b.n) / (a.n + b.n), n: a.n + b.n });
    i = Math.max(0, i - 2);
  }
}
table.clear();
for (const b of blocks) for (const l of b.ls) table.set(l, Math.round(b.e));
console.log("\nexport const CALIBRATION: [number, number][] = [");
for (const [l, e] of [...table.entries()].sort((a, b) => a[0] - b[0])) console.log(`  [${l}, ${e}],`);
console.log(`];  // ${path.basename(MODEL_ENGINE)}, ${PER_PAIR} games a pairing at ${process.env.TC || "60+0.6"}`);
fs.rmSync(out, { force: true });
