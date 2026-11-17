import { Result, variantOf } from "./chess.js";
import { Color, cleanName, fail, Handler, json, Row, sql, timeOf } from "./db.js";
import { current, onFinish, pairedGame, verified } from "./game.js";
import { categoryOf, ratingIn } from "./ratings.js";
import { randomId } from "./token.js";
import { teamIdOf } from "./teams.js";

/**
 * Arenas: play as many games as you can before the end. The server pairs
 * waiting players (no instant rematches, never two players who blocked each
 * other), scores 2 for a win and 1 for a draw, doubled on a streak of two or
 * more wins, plus 1 for a berserk win of at least seven moves each.
 */

function arenaInfo(a: Row, now: number) {
  const starts = Number(a.starts_at), ends = Number(a.ends_at);
  return {
    id: a.id, name: a.name, minutes: a.minutes, increment: a.increment, variant: variantOf(a.variant),
    startsAt: starts, endsAt: ends, status: now < starts ? "upcoming" : now < ends ? "running" : "finished",
    /** Team battles: how many of each team's best players count. */
    teamLeaders: a.team_leaders ?? null,
  };
}

/** A team battle's table: each team scores the points of its best `leaders` players. */
async function teamStandings(a: Row) {
  if (!a.team_leaders) return null;
  const teams = await sql`select t.id, t.name from arena_teams x join teams t on t.id = x.team_id where x.arena_id = ${a.id}`;
  const players = await sql`select team_id, name, score from arena_players where arena_id = ${a.id} and team_id is not null order by score desc`;
  return teams.map((t) => {
    const mine = players.filter((p) => p.team_id === t.id);
    const top = mine.slice(0, a.team_leaders);
    return { id: t.id, name: t.name, score: top.reduce((s, p) => s + p.score, 0), players: mine.length, leaders: top.map((p) => p.name) };
  }).sort((x, y) => y.score - x.score);
}

let arenasMadeFor = 0;
/** Two arenas every hour: Blitz 3+2 on the hour for 45 minutes, Bullet 1+0 at half past for 25. */
async function ensureArenas() {
  const HOUR = 3600_000;
  const hour = Math.floor(Date.now() / HOUR) * HOUR;
  if (arenasMadeFor === hour) return;
  for (const t of [hour, hour + HOUR]) {
    const stamp = new Date(t).toISOString().slice(0, 13);
    await sql`insert into arenas (id, name, minutes, increment, variant, starts_at, ends_at) values
      (${`blitz-${stamp}`}, 'Hourly Blitz', 3, 2, 'chess', ${t}, ${t + 45 * 60_000}),
      (${`bullet-${stamp}`}, 'Hourly Bullet', 1, 0, 'chess', ${t + 30 * 60_000}, ${t + 55 * 60_000})
      on conflict (id) do nothing`;
  }
  arenasMadeFor = hour;
}

onFinish(async (g, result) => {
  if (!g.arena_id || result === "aborted") return;
  for (const c of ["white", "black"] as Color[]) {
    const won = result !== "1/2-1/2" && (result === "1-0") === (c === "white");
    const points = result === "1/2-1/2" ? 1 : won ? 2 : 0;
    // Berserk: a win after giving up half your clock is worth one more, if the game was a real one.
    const bonus = won && g[`${c}_berserk`] && g.ply >= 14 ? 1 : 0;
    await sql`update arena_players set
        score = score + case when streak >= 2 then ${points * 2}::int else ${points}::int end + ${bonus}::int,
        streak = case when ${won}::boolean then streak + 1 else 0 end,
        games = games + 1
      where arena_id = ${g.arena_id} and guest = ${g[`${c}_guest`]}`;
  }
});

export const arenaRoutes: Record<string, Handler> = {
  "GET arenas": async () => {
    await ensureArenas();
    const now = Date.now();
    const rows = await sql`select * from arenas where ends_at > ${now - 3 * 3600_000} and starts_at < ${now + 2 * 3600_000} order by starts_at`;
    const ids = rows.map((a) => a.id);
    const stats = ids.length ? await sql`
      select arena_id, count(*)::int as players,
        (array_agg(name order by score desc, games))[1] as leader, max(score) as top
      from arena_players where arena_id = any(${ids}) group by arena_id` : [];
    const by = new Map(stats.map((s) => [s.arena_id, s]));
    return json({ now, arenas: rows.filter((a) => !a.team_leaders || a.ends_at > now).map((a) => ({ ...arenaInfo(a, now), players: by.get(a.id)?.players ?? 0, leader: by.get(a.id)?.leader ?? null, top: by.get(a.id)?.top ?? 0 })) });
  },

  "GET arena": async (_r, u) => {
    const a = (await sql`select * from arenas where id = ${u.searchParams.get("id") ?? ""}`)[0];
    if (!a) return fail("No such arena.", 404);
    const now = Date.now();
    const players = await sql`select guest, name, rating, score, streak, games, waiting_since, seat_game, last_poll, team_id from arena_players where arena_id = ${a.id} order by score desc, games limit 100`;
    return json({
      now, arena: arenaInfo(a, now), teams: await teamStandings(a),
      players: players.map((r) => ({
        guest: r.guest, name: r.name, rating: r.rating, score: r.score, streak: r.streak, games: r.games,
        playing: !!r.seat_game, active: !!r.last_poll && Number(r.last_poll) > now - 15_000, team: r.team_id ?? null,
      })),
    });
  },

  "POST arena/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const title = String(b.title ?? "").replace(/[^\p{L}\p{N} _.,!'-]/gu, "").trim().slice(0, 40) || `${cleanName(b.name)}'s arena`;
    const { minutes, increment } = timeOf(b);
    const startsIn = Math.min(120, Math.max(0, Math.round(Number(b.startsIn) || 0)));
    const duration = Math.min(180, Math.max(10, Math.round(Number(b.duration) || 30)));
    const id = randomId(), start = Date.now() + startsIn * 60_000;
    // A team battle names two to ten teams by their codes.
    const codes = (Array.isArray(b.teams) ? b.teams : []).map((c: unknown) => String(c).toUpperCase().trim()).filter(Boolean).slice(0, 10);
    const teams = codes.length ? await sql`select id from teams where code = any(${codes})` : [];
    if (codes.length && teams.length < 2) return fail("A team battle needs at least two teams (check the codes).");
    const leaders = teams.length ? Math.min(10, Math.max(1, Math.round(Number(b.leaders) || 5))) : null;
    await sql`insert into arenas (id, name, minutes, increment, variant, starts_at, ends_at, created_by, team_leaders)
      values (${id}, ${cleanName(title) === "Guest" ? `${cleanName(b.name)}'s arena` : title}, ${minutes}, ${increment}, ${variantOf(b.variant)}, ${start}, ${start + duration * 60_000}, ${p.id}, ${leaders})`;
    for (const t of teams) await sql`insert into arena_teams (arena_id, team_id) values (${id}, ${t.id})`;
    return json({ id });
  },

  "POST arena/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const a = (await sql`select * from arenas where id = ${String(b.id ?? "")}`)[0];
    const now = Date.now();
    if (!a || a.ends_at <= now) return fail("That arena is over.", 409);
    const rating = ratingIn(p, categoryOf(variantOf(a.variant), a.minutes, a.increment));
    let team: string | null = null;
    if (a.team_leaders) {
      team = (await teamIdOf(p.id)) ?? null;
      const allowed = team && (await sql`select 1 from arena_teams where arena_id = ${a.id} and team_id = ${team}`).length;
      if (!allowed) return fail("Only members of the teams in this battle can join it.", 403);
    }
    await sql`insert into arena_players (arena_id, guest, name, rating, waiting_since, last_poll, team_id)
      values (${a.id}, ${p.id}, ${cleanName(b.name)}, ${rating}, ${now}, ${now}, ${team})
      on conflict (arena_id, guest) do update set name = excluded.name, rating = excluded.rating, last_poll = excluded.last_poll, paused = false,
        waiting_since = case when arena_players.seat_game is null then coalesce(arena_players.waiting_since, excluded.waiting_since) else arena_players.waiting_since end`;
    return json({ ok: true });
  },

  /** Stops pairing a player (they keep their points and can come back). */
  "POST arena/leave": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`update arena_players set waiting_since = null, paused = true where arena_id = ${String(b.id ?? "")} and guest = ${p.id}`;
    return json({ ok: true });
  },

  /**
   * Called every couple of seconds by each player in an arena. Returns their
   * seat once they have a game; otherwise pairs them with someone waiting.
   */
  "POST arena/pair": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const a = (await sql`select * from arenas where id = ${String(b.id ?? "")}`)[0];
    if (!a) return fail("No such arena.", 404);
    const now = Date.now();
    let me = (await sql`update arena_players set last_poll = ${now} where arena_id = ${a.id} and guest = ${p.id} returning *`)[0];
    if (!me) return fail("Join the arena first.", 409);
    if (me.seat_game) {
      const g = await current(me.seat_game);
      if (g && g.status !== "finished") return json({ status: "seated", seat: { id: g.id, code: g.code, color: me.seat_color, key: me.seat_key } });
      // That game is over: straight back into the queue while the arena lasts.
      me = (await sql`update arena_players set seat_game = null, seat_key = null, seat_color = null,
        waiting_since = case when paused then null else ${now < Number(a.ends_at) ? now : null}::bigint end where arena_id = ${a.id} and guest = ${p.id} returning *`)[0];
    }
    if (now < Number(a.starts_at)) return json({ status: "upcoming" });
    if (now >= Number(a.ends_at)) return json({ status: "finished" });
    if (me.waiting_since == null) return json({ status: "paused" });

    const blocks = await sql`select blocked as g from blocks where guest = ${p.id} union select guest from blocks where blocked = ${p.id}`;
    const avoid = new Set(blocks.map((r) => r.g));
    const others = (await sql`select * from arena_players where arena_id = ${a.id} and guest <> ${p.id}
      and waiting_since is not null and seat_game is null and last_poll > ${now - 8000} order by waiting_since limit 30`)
      .filter((o) => !avoid.has(o.guest) && !(a.team_leaders && o.team_id === me.team_id)); // team battles pair across teams
    if (!others.length) return json({ status: "waiting" });
    // Avoid an immediate rematch when there is a choice, then pair by rating.
    const rank = (o: Row) => (o.last_opponent === p.id || me.last_opponent === o.guest ? 10_000 : 0) + Math.abs((o.rating ?? 1500) - (me.rating ?? 1500));
    const them = others.sort((x, y) => rank(x) - rank(y))[0];
    const claimed = await sql`update arena_players set waiting_since = null where arena_id = ${a.id} and guest in (${p.id}, ${them.guest})
      and waiting_since is not null and seat_game is null returning guest`;
    if (claimed.length < 2) {
      if (claimed.length) await sql`update arena_players set waiting_since = ${now} where arena_id = ${a.id} and guest = ${claimed[0].guest}`;
      return json({ status: "waiting" });
    }
    const meWhite = Math.random() < 0.5;
    const white = meWhite ? me : them, black = meWhite ? them : me;
    const g = await pairedGame({ minutes: Number(a.minutes), increment: a.increment, variant: variantOf(a.variant), arena: a.id },
      { guest: white.guest, name: white.name, profileRating: white.rating }, { guest: black.guest, name: black.name, profileRating: black.rating });
    await sql`update arena_players set seat_game = ${g.id}, seat_key = ${g.wk}, seat_color = 'white', last_opponent = ${black.guest} where arena_id = ${a.id} and guest = ${white.guest}`;
    await sql`update arena_players set seat_game = ${g.id}, seat_key = ${g.bk}, seat_color = 'black', last_opponent = ${white.guest} where arena_id = ${a.id} and guest = ${black.guest}`;
    return json({ status: "seated", seat: { id: g.id, code: g.code, color: meWhite ? "white" : "black", key: meWhite ? g.wk : g.bk } });
  },
};

