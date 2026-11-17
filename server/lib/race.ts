import { puzzleMove } from "./chess.js";
import { cleanName, fail, Handler, json, Row, sql } from "./db.js";
import { freshCode, verified } from "./game.js";
import { PUZZLES_TSV } from "./puzzles-data.js";
import { randomId } from "./token.js";

/**
 * Puzzle rush and puzzle battles, checked by the server. The server picks the
 * puzzles and keeps the solutions: the app is sent each position and the
 * opponent's replies one at a time, and every move it plays is checked here.
 * Scores therefore can't be made up, and the rush leaderboard counts only these runs.
 */
interface Puzzle { id: string; fen: string; moves: string[]; rating: number }
const ALL: Puzzle[] = PUZZLES_TSV.split("\n").map((l) => {
  const [id, fen, moves, rating] = l.split("\t");
  return { id, fen, moves: moves.split(" "), rating: Number(rating) };
});
const BY_ID = new Map(ALL.map((p) => [p.id, p]));

/** About 120 puzzles from easy to hard, a little harder each time. */
function pick(count = 120): string[] {
  const used = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const target = 600 + i * 18;
    const pool = ALL.filter((p) => !used.has(p.id) && p.moves.length <= 8 && Math.abs(p.rating - target) <= 120);
    const p = pool[Math.floor(Math.random() * pool.length)];
    if (!p) continue;
    used.add(p.id);
    out.push(p.id);
  }
  return out;
}

const GRACE = 1500; // a move sent just as the clock ends still counts

/**
 * Storm: one clock, no strikes. A miss costs ten seconds; a run of solves earns
 * time at 5, 12, 20 and 30 in a row, then every 10 more.
 */
const STORM_PENALTY = 10_000;
export function stormBonus(combo: number): number {
  if (combo === 5) return 3000;
  if (combo === 12) return 5000;
  if (combo === 20) return 7000;
  if (combo >= 30 && combo % 10 === 0) return 10_000;
  return 0;
}

const out = (r: Row) => r.kind !== "storm" && r.strikes >= 3;

function runStatus(r: Row, now = Date.now()) {
  if (!r.started_at) return "waiting";
  if (now < Number(r.started_at)) return "countdown";
  if (out(r) || now > Number(r.ends_at) || r.idx >= r.puzzles.length) return "finished";
  return "running";
}

/** What the player may see: the current position and setup move, never the solution. */
function runView(r: Row) {
  const now = Date.now();
  const p = BY_ID.get(r.puzzles[r.idx]);
  // Moves already played in this puzzle: the setup move, then the solver's and the replies so far.
  const played = p ? p.moves.slice(0, r.step) : [];
  return {
    id: r.id, kind: r.kind, status: runStatus(r, now), score: r.score, strikes: r.strikes, index: r.idx, combo: r.combo ?? 0,
    startedAt: r.started_at ? Number(r.started_at) : null, endsAt: r.ends_at ? Number(r.ends_at) : null, now,
    puzzle: p ? { id: p.id, fen: p.fen, played, rating: p.rating } : null,
  };
}

async function newRun(kind: "rush" | "battle" | "storm", guest: string, name: string, minutes: number, puzzles: string[], start: number | null, race?: string) {
  const id = randomId(), key = randomId(18);
  await sql`insert into runs (id, key, kind, race_id, guest, name, minutes, puzzles, started_at, ends_at)
    values (${id}, ${key}, ${kind}, ${race ?? null}, ${guest}, ${name}, ${minutes}, ${JSON.stringify(puzzles)}, ${start}, ${start ? start + minutes * 60_000 : null})`;
  return { id, key };
}

function raceView(r: Row, a: Row, b: Row | undefined) {
  const side = (run: Row | undefined, name: string | null) => ({ name, score: run?.score ?? 0, strikes: run?.strikes ?? 0, done: run ? runStatus(run) === "finished" : false });
  const now = Date.now();
  const started = r.started_at ? Number(r.started_at) : null;
  const ends = started ? started + r.minutes * 60_000 : null;
  const sa = side(a, r.a_name), sb = side(b, r.b_name);
  const status = !started ? "waiting" : now < started ? "countdown" : now > ends! || (sa.done && sb.done) ? "finished" : "running";
  return { id: r.id, code: r.code, minutes: r.minutes, startedAt: started, endsAt: ends, now, status, a: sa, b: sb };
}

async function loadRace(id: string) {
  const r = (await sql`select * from races where id = ${id}`)[0];
  if (!r) return undefined;
  const runs = await sql`select * from runs where id in (${r.a_run}, ${r.b_run ?? ""})`;
  return { r, a: runs.find((x) => x.id === r.a_run)!, b: runs.find((x) => x.id === r.b_run) };
}

export const raceRoutes: Record<string, Handler> = {
  /** Starts a timed rush right away. */
  "POST race/rush": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const minutes = Number(b.minutes) === 5 ? 5 : 3;
    const run = await newRun("rush", p.id, cleanName(b.name), minutes, pick(), Date.now());
    return json({ ...run, run: runView((await sql`select * from runs where id = ${run.id}`)[0]) });
  },

  /** Starts a three-minute storm right away. */
  "POST race/storm": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const run = await newRun("storm", p.id, cleanName(b.name), 3, pick(150), Date.now());
    return json({ ...run, run: runView((await sql`select * from runs where id = ${run.id}`)[0]) });
  },

  /** Opens a battle; it starts five seconds after someone joins. */
  "POST race/battle": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const minutes = Math.min(10, Math.max(1, Math.round(Number(b.minutes) || 3)));
    const puzzles = pick(), name = cleanName(b.name), id = randomId(), code = await freshCode();
    const run = await newRun("battle", p.id, name, minutes, puzzles, null, id);
    await sql`insert into races (id, code, public, minutes, puzzles, a_run, a_name) values (${id}, ${code}, ${b.public !== false}, ${minutes}, ${JSON.stringify(puzzles)}, ${run.id}, ${name})`;
    return json({ race: id, code, run: run.id, key: run.key });
  },

  "POST race/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim();
    const r = (await sql`select * from races where code = ${code.toUpperCase()} or id = ${code}`)[0];
    if (!r) return fail("No battle has that code.", 404);
    const host = (await sql`select guest from runs where id = ${r.a_run}`)[0];
    if (host?.guest === p.id) return fail("You can't battle yourself.", 409);
    if (r.b_run) return fail("Someone else is already in that battle.", 409);
    const start = Date.now() + 5000;
    const run = await newRun("battle", p.id, cleanName(b.name), r.minutes, r.puzzles, start, r.id);
    const taken = await sql`update races set b_run = ${run.id}, b_name = ${cleanName(b.name)}, started_at = ${start} where id = ${r.id} and b_run is null returning id`;
    if (!taken.length) {
      await sql`delete from runs where id = ${run.id}`;
      return fail("Someone else is already in that battle.", 409);
    }
    await sql`update runs set started_at = ${start}, ends_at = ${start + r.minutes * 60_000} where id = ${r.a_run}`;
    return json({ race: r.id, code: r.code, run: run.id, key: run.key });
  },

  "GET race": async (_r, u) => {
    const x = await loadRace(u.searchParams.get("id") ?? "");
    return x ? json(raceView(x.r, x.a, x.b)) : fail("No such battle.", 404);
  },

  "POST race/cancel": async (_r, _u, b) => {
    const run = (await sql`select * from runs where id = ${String(b.run ?? "")} and key = ${String(b.key ?? "")}`)[0];
    if (run?.race_id) await sql`delete from races where id = ${run.race_id} and b_run is null`;
    return json({ ok: true });
  },

  "GET race/run": async (_r, u) => {
    const r = (await sql`select * from runs where id = ${u.searchParams.get("id") ?? ""} and key = ${u.searchParams.get("key") ?? ""}`)[0];
    return r ? json(runView(r)) : fail("No such run.", 404);
  },

  /** Plays the solver's move: correct (with the reply), solved, or wrong (with the answer). */
  "POST race/move": async (_r, _u, b) => {
    const r = (await sql`select * from runs where id = ${String(b.id ?? "")} and key = ${String(b.key ?? "")}`)[0];
    if (!r) return fail("No such run.", 404);
    const now = Date.now();
    const live = r.started_at && now >= Number(r.started_at) && now <= Number(r.ends_at) + GRACE && !out(r) && r.idx < r.puzzles.length;
    if (!live || Number(b.index) !== r.idx) return json({ result: "stale", run: runView(r) });
    const p = BY_ID.get(r.puzzles[r.idx]);
    if (!p) return json({ result: "stale", run: runView(r) });
    const outcome = puzzleMove(p.fen, p.moves, r.step, String(b.uci ?? ""));
    let next: Row[];
    let reply: string | undefined;
    if (outcome === "correct") {
      reply = p.moves[r.step + 1];
      next = await sql`update runs set step = step + 2 where id = ${r.id} and idx = ${r.idx} and step = ${r.step} returning *`;
    } else if (outcome === "solved") {
      const bonus = r.kind === "storm" ? stormBonus((r.combo ?? 0) + 1) : 0;
      next = await sql`update runs set score = score + 1, idx = idx + 1, step = 1, combo = combo + 1, ends_at = ends_at + ${bonus}::bigint
        where id = ${r.id} and idx = ${r.idx} and step = ${r.step} returning *`;
    } else {
      const penalty = r.kind === "storm" ? STORM_PENALTY : 0;
      next = await sql`update runs set strikes = strikes + 1, idx = idx + 1, step = 1, combo = 0, ends_at = ends_at - ${penalty}::bigint
        where id = ${r.id} and idx = ${r.idx} and step = ${r.step} returning *`;
    }
    if (!next.length) return json({ result: "stale", run: runView((await sql`select * from runs where id = ${r.id}`)[0]) });
    return json({ result: outcome, reply, answer: outcome === "wrong" ? p.moves[r.step] : undefined, run: runView(next[0]) });
  },

  /** Best checked rush per guest (or storm, with ?kind=storm). */
  "GET rush": async (_r, u) => {
    const storm = u.searchParams.get("kind") === "storm";
    const minutes = storm ? 3 : Number(u.searchParams.get("minutes")) === 5 ? 5 : 3;
    const kind = storm ? "storm" : "rush";
    const rows = await sql`
      with best as (select distinct on (guest) guest, name, score, created_at from runs
        where kind = ${kind} and minutes = ${minutes} and (ends_at < ${Date.now()} or (kind <> 'storm' and strikes >= 3))
        order by guest, score desc, created_at)
      select * from best where score > 0 order by score desc, created_at limit 25`;
    return json({ scores: rows.map((r) => ({ guest: r.guest, name: r.name, score: r.score })) });
  },
};

/** Open battles for the lobby. */
export async function openRaces() {
  const rows = await sql`select id, code, a_name, minutes from races where b_run is null and public and created_at > now() - interval '15 minutes' order by created_at desc limit 20`;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.a_name, minutes: r.minutes }));
}
