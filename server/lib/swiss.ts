import { Result, variantOf } from "./chess.js";
import { Color, cleanName, fail, Handler, json, Row, sql, timeOf } from "./db.js";
import { current, onFinish, onResult, pairedGame, toMove, verified } from "./game.js";
import { categoryOf, ratingIn } from "./ratings.js";
import { randomId } from "./token.js";

/**
 * Swiss tournaments: a fixed number of rounds, everyone plays every round.
 * Each round pairs players with the same score who haven't met, gives a bye
 * (a point) to one player when the count is odd, and balances colours.
 * Points are kept doubled (a win 2, a draw 1) so they stay whole numbers.
 * Rounds advance when players' apps ask for the state; nothing runs on a timer.
 */
const BREAK_MS = 8000; // between rounds, to see the result

function swissInfo(s: Row, now = Date.now()) {
  return {
    id: s.id, name: s.name, minutes: s.minutes, increment: s.increment, variant: variantOf(s.variant),
    rounds: s.rounds, round: s.round, status: s.status, startsAt: Number(s.starts_at), now,
    nextRoundAt: s.status === "running" && s.round_done_at ? Number(s.round_done_at) + BREAK_MS : null,
  };
}

let swissMadeFor = 0;
/** A Daily Swiss: 5+3, seven rounds, at 18:00 UTC. */
async function ensureSwiss() {
  const DAY = 86_400_000;
  const day = Math.floor(Date.now() / DAY) * DAY;
  if (swissMadeFor === day) return;
  for (const d of [day, day + DAY]) {
    const t = d + 18 * 3600_000;
    await sql`insert into swiss (id, name, minutes, increment, variant, rounds, starts_at)
      values (${`daily-${new Date(d).toISOString().slice(0, 10)}`}, 'Daily Swiss', 5, 3, 'chess', 7, ${t}) on conflict (id) do nothing`;
  }
  swissMadeFor = day;
}

/** Pairs a round. Called once per round: the round number in the update guards against doubles. */
async function pairRound(s: Row, round: number) {
  const players = await sql`select * from swiss_players where swiss_id = ${s.id} and not withdrawn order by points desc, rating desc nulls last`;
  const blocks = await sql`select guest, blocked from blocks where guest = any(${players.map((p) => p.guest)})`;
  const avoid = new Set(blocks.map((b) => `${b.guest}|${b.blocked}`));
  const apart = (a: Row, b: Row) => a.opponents.includes(b.guest) || avoid.has(`${a.guest}|${b.guest}`) || avoid.has(`${b.guest}|${a.guest}`);
  const pool = [...players];
  if (pool.length % 2) {
    // The bye goes to the lowest-placed player who hasn't had one.
    const i = [...pool].reverse().findIndex((p) => p.byes === 0);
    const [bye] = pool.splice(i < 0 ? pool.length - 1 : pool.length - 1 - i, 1);
    await sql`update swiss_players set points = points + 2, byes = byes + 1, seat_game = null where swiss_id = ${s.id} and guest = ${bye.guest}`;
  }
  const pairs: [Row, Row][] = [];
  while (pool.length) {
    const a = pool.shift()!;
    let j = pool.findIndex((b) => !apart(a, b));
    if (j < 0) j = 0; // everyone left has met: allow a repeat rather than leave someone out
    pairs.push([a, pool.splice(j, 1)[0]]);
  }
  for (const [a, b] of pairs) {
    const aWhite = a.whites < b.whites || (a.whites === b.whites && Math.random() < 0.5);
    const white = aWhite ? a : b, black = aWhite ? b : a;
    const g = await pairedGame({ minutes: Number(s.minutes), increment: s.increment, variant: variantOf(s.variant), swiss: s.id, round },
      { guest: white.guest, name: white.name, profileRating: white.rating }, { guest: black.guest, name: black.name, profileRating: black.rating });
    await sql`update swiss_players set seat_game = ${g.id}, seat_key = ${g.wk}, seat_color = 'white', whites = whites + 1, opponents = array_append(opponents, ${black.guest}) where swiss_id = ${s.id} and guest = ${white.guest}`;
    await sql`update swiss_players set seat_game = ${g.id}, seat_key = ${g.bk}, seat_color = 'black', opponents = array_append(opponents, ${white.guest}) where swiss_id = ${s.id} and guest = ${black.guest}`;
  }
}

/** Moves a tournament along: starts it, notices a finished round, pairs the next or ends it. */
async function advance(s: Row): Promise<Row> {
  const now = Date.now();
  if (s.status === "upcoming" && now >= Number(s.starts_at)) {
    const count = (await sql`select count(*)::int as n from swiss_players where swiss_id = ${s.id} and not withdrawn`)[0].n;
    if (count < 2) return (await sql`update swiss set status = 'finished' where id = ${s.id} returning *`)[0];
    const started = await sql`update swiss set status = 'running', round = 1, round_started_at = ${now}, round_done_at = null where id = ${s.id} and status = 'upcoming' returning *`;
    if (started.length) { await pairRound(started[0], 1); return started[0]; }
    return (await sql`select * from swiss where id = ${s.id}`)[0];
  }
  if (s.status !== "running") return s;
  if (!s.round_done_at) {
    // Settle flags and no-shows, then see whether every game of the round is over.
    const open = await sql`select id from games where swiss_id = ${s.id} and swiss_round = ${s.round} and status <> 'finished'`;
    for (const g of open) await current(g.id);
    const still = await sql`select 1 from games where swiss_id = ${s.id} and swiss_round = ${s.round} and status <> 'finished' limit 1`;
    if (still.length) return s;
    const done = await sql`update swiss set round_done_at = ${now} where id = ${s.id} and round = ${s.round} and round_done_at is null returning *`;
    s = done[0] ?? (await sql`select * from swiss where id = ${s.id}`)[0];
  }
  if (s.round_done_at && now - Number(s.round_done_at) >= BREAK_MS) {
    if (s.round >= s.rounds) return (await sql`update swiss set status = 'finished' where id = ${s.id} and status = 'running' returning *`)[0] ?? s;
    const next = await sql`update swiss set round = round + 1, round_started_at = ${now}, round_done_at = null where id = ${s.id} and round = ${s.round} returning *`;
    if (next.length) { await pairRound(next[0], next[0].round); return next[0]; }
    return (await sql`select * from swiss where id = ${s.id}`)[0];
  }
  return s;
}

/** In a Swiss, a game nobody started is lost by the player who didn't move. */
onResult((g, result, reason) => {
  if (!g.swiss_id || result !== "aborted") return { result, reason };
  return { result: toMove(g) === "white" ? "0-1" : "1-0", reason: "forfeit" };
});

onFinish(async (g, result) => {
  if (!g.swiss_id || result === "aborted") return;
  for (const c of ["white", "black"] as Color[]) {
    const points = result === "1/2-1/2" ? 1 : (result === "1-0") === (c === "white") ? 2 : 0;
    await sql`update swiss_players set points = points + ${points}::int where swiss_id = ${g.swiss_id} and guest = ${g[`${c}_guest`]}`;
  }
});

async function standings(id: string) {
  const players = await sql`select guest, name, rating, points, byes, opponents, withdrawn, seat_game from swiss_players where swiss_id = ${id}`;
  const points = new Map(players.map((p) => [p.guest, p.points]));
  return players.map((p) => ({
    guest: p.guest, name: p.name, rating: p.rating, points: p.points / 2, byes: p.byes, withdrawn: p.withdrawn, games: p.opponents.length,
    // Buchholz: the sum of the opponents' scores, the usual Swiss tiebreak.
    buchholz: p.opponents.reduce((t: number, o: string) => t + (points.get(o) ?? 0), 0) / 2,
  })).sort((a, b) => b.points - a.points || b.buchholz - a.buchholz || (b.rating ?? 0) - (a.rating ?? 0));
}

export const swissRoutes: Record<string, Handler> = {
  "GET swisses": async () => {
    await ensureSwiss();
    const now = Date.now();
    const rows = await sql`select s.*, (select count(*)::int from swiss_players p where p.swiss_id = s.id and not p.withdrawn) as players
      from swiss s where (status <> 'finished' and starts_at < ${now + 26 * 3600_000}) or (status = 'finished' and starts_at > ${now - 6 * 3600_000})
      order by starts_at limit 30`;
    return json({ swisses: rows.map((s) => ({ ...swissInfo(s, now), players: s.players })) });
  },

  "GET swiss": async (_r, u) => {
    let s = (await sql`select * from swiss where id = ${u.searchParams.get("id") ?? ""}`)[0];
    if (!s) return fail("No such tournament.", 404);
    s = await advance(s);
    const pairings = s.round ? await sql`select id, white_name, black_name, status, result from games where swiss_id = ${s.id} and swiss_round = ${s.round}` : [];
    return json({
      swiss: swissInfo(s), standings: await standings(s.id),
      pairings: pairings.map((g) => ({ id: g.id, white: g.white_name, black: g.black_name, status: g.status, result: g.result })),
    });
  },

  "POST swiss/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const title = String(b.title ?? "").replace(/[^\p{L}\p{N} _.,!'-]/gu, "").trim().slice(0, 40);
    const { minutes, increment } = timeOf(b);
    const rounds = Math.min(11, Math.max(3, Math.round(Number(b.rounds) || 5)));
    const startsIn = Math.min(24 * 60, Math.max(1, Math.round(Number(b.startsIn) || 10)));
    const id = randomId();
    await sql`insert into swiss (id, name, minutes, increment, variant, rounds, starts_at, created_by)
      values (${id}, ${title && cleanName(title) !== "Guest" ? title : `${cleanName(b.name)}'s Swiss`}, ${minutes}, ${increment}, ${variantOf(b.variant)}, ${rounds}, ${Date.now() + startsIn * 60_000}, ${p.id})`;
    return json({ id });
  },

  /** Joining is open until the last round starts; latecomers start on zero points. */
  "POST swiss/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const s = (await sql`select * from swiss where id = ${String(b.id ?? "")}`)[0];
    if (!s || s.status === "finished" || (s.status === "running" && s.round >= s.rounds)) return fail("That tournament can't be joined any more.", 409);
    const rating = ratingIn(p, categoryOf(variantOf(s.variant), s.minutes, s.increment));
    await sql`insert into swiss_players (swiss_id, guest, name, rating) values (${s.id}, ${p.id}, ${cleanName(b.name)}, ${rating})
      on conflict (swiss_id, guest) do update set withdrawn = false, name = excluded.name`;
    return json({ ok: true });
  },

  "POST swiss/withdraw": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`update swiss_players set withdrawn = true where swiss_id = ${String(b.id ?? "")} and guest = ${p.id}`;
    return json({ ok: true });
  },

  /** A player's seat in the current round, if they have one. Also moves the tournament along. */
  "POST swiss/pair": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    let s = (await sql`select * from swiss where id = ${String(b.id ?? "")}`)[0];
    if (!s) return fail("No such tournament.", 404);
    s = await advance(s);
    const me = (await sql`select * from swiss_players where swiss_id = ${s.id} and guest = ${p.id}`)[0];
    if (!me) return fail("Join the tournament first.", 409);
    if (s.status !== "running" || me.withdrawn) return json({ status: me.withdrawn ? "withdrawn" : s.status });
    if (!me.seat_game) return json({ status: "bye" });
    const g = (await sql`select id, code, status, swiss_round from games where id = ${me.seat_game}`)[0];
    if (!g || g.swiss_round !== s.round) return json({ status: "bye" });
    return json({ status: g.status === "finished" ? "between" : "seated", seat: { id: g.id, code: g.code, color: me.seat_color, key: me.seat_key } });
  },
};

