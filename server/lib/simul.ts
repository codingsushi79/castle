import { variantOf } from "./chess.js";
import { cleanName, fail, Handler, json, ping, Row, sql, timeOf } from "./db.js";
import { blocked, pairedGame, verified, view } from "./game.js";
import { categoryOf, ratingIn } from "./ratings.js";
import { randomId } from "./token.js";

/**
 * Simultaneous exhibitions: one host plays several opponents at once. Players
 * sign up while the simul is open; the host starts it, and a casual game begins
 * with each of them, every game on its own clock. The host moves from board to board.
 */
function info(s: Row, players: Row[]) {
  return {
    id: s.id, name: s.name, host: s.host, hostName: s.host_name, hostRating: s.host_rating, minutes: s.minutes, increment: s.increment,
    variant: variantOf(s.variant), hostColor: s.host_color, seats: s.seats, status: s.status,
    players: players.map((p) => ({ guest: p.guest, name: p.name, rating: p.rating, game: p.game_id ?? null })),
  };
}

/** Marks a running simul finished once all its games are. */
async function settle(s: Row) {
  if (s.status !== "running") return s;
  const open = await sql`select 1 from games where simul_id = ${s.id} and status <> 'finished' limit 1`;
  if (open.length) return s;
  return (await sql`update simuls set status = 'finished' where id = ${s.id} returning *`)[0] ?? s;
}

export const simulRoutes: Record<string, Handler> = {
  "GET simuls": async () => {
    const rows = await sql`select * from simuls where (status = 'open' and created_at > now() - interval '3 hours') or (status = 'running' and created_at > now() - interval '12 hours')
      order by created_at desc limit 20`;
    const players = rows.length ? await sql`select * from simul_players where simul_id = any(${rows.map((r) => r.id)})` : [];
    return json({ simuls: rows.map((s) => info(s, players.filter((p) => p.simul_id === s.id))) });
  },

  "GET simul": async (_r, u) => {
    let s = (await sql`select * from simuls where id = ${u.searchParams.get("id") ?? ""}`)[0];
    if (!s) return fail("No such simul.", 404);
    s = await settle(s);
    const players = await sql`select * from simul_players where simul_id = ${s.id} order by name`;
    const games = s.status === "open" ? [] : await sql`select * from games where simul_id = ${s.id}`;
    return json({ simul: info(s, players), games: games.map(view) });
  },

  "POST simul/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const { minutes, increment } = timeOf(b);
    const variant = variantOf(b.variant);
    const seats = Math.min(20, Math.max(2, Math.round(Number(b.seats) || 6)));
    const color = ["white", "black", "random"].includes(b.color) ? b.color : "white";
    const title = String(b.title ?? "").replace(/[^\p{L}\p{N} _.,!'-]/gu, "").trim().slice(0, 40);
    const name = cleanName(b.name);
    const id = randomId();
    await sql`insert into simuls (id, name, host, host_name, host_rating, minutes, increment, variant, host_color, seats)
      values (${id}, ${title && cleanName(title) !== "Guest" ? title : `${name}'s simul`}, ${p.id}, ${name}, ${ratingIn(p, categoryOf(variant, minutes, increment))},
        ${minutes}, ${increment}, ${variant}, ${color}, ${seats})`;
    return json({ id });
  },

  "POST simul/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const s = (await sql`select * from simuls where id = ${String(b.id ?? "")}`)[0];
    if (!s || s.status !== "open") return fail("That simul has started or ended.", 409);
    if (s.host === p.id) return fail("You're the host.", 409);
    if (await blocked(s.host, p.id)) return fail("You can't join this simul.", 403);
    const count = (await sql`select count(*)::int as n from simul_players where simul_id = ${s.id}`)[0].n;
    if (count >= s.seats) return fail("The simul is full.", 409);
    await sql`insert into simul_players (simul_id, guest, name, rating) values (${s.id}, ${p.id}, ${cleanName(b.name)}, ${ratingIn(p, categoryOf(variantOf(s.variant), s.minutes, s.increment))})
      on conflict (simul_id, guest) do update set name = excluded.name`;
    return json({ ok: true });
  },

  "POST simul/leave": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const s = (await sql`select * from simuls where id = ${String(b.id ?? "")}`)[0];
    if (s?.host === p.id && s.status === "open") await sql`update simuls set status = 'finished' where id = ${s.id}`;
    else await sql`delete from simul_players where simul_id = ${String(b.id ?? "")} and guest = ${p.id} and game_id is null`;
    return json({ ok: true });
  },

  /** The host starts it: a game with every player who signed up. */
  "POST simul/start": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const s = (await sql`update simuls set status = 'running' where id = ${String(b.id ?? "")} and host = ${p.id} and status = 'open'
      and exists (select 1 from simul_players where simul_id = ${String(b.id ?? "")}) returning *`)[0];
    if (!s) return fail("Only the host can start an open simul with players in it.", 409);
    const players = await sql`select * from simul_players where simul_id = ${s.id}`;
    for (const pl of players) {
      const hostWhite = s.host_color === "white" || (s.host_color === "random" && Math.random() < 0.5);
      const host = { guest: s.host, name: s.host_name, profileRating: s.host_rating }, guest = { guest: pl.guest, name: pl.name, profileRating: pl.rating };
      const g = await pairedGame({ minutes: Number(s.minutes), increment: s.increment, variant: variantOf(s.variant), simul: s.id, rated: false },
        hostWhite ? host : guest, hostWhite ? guest : host);
      await sql`update simul_players set game_id = ${g.id} where simul_id = ${s.id} and guest = ${pl.guest}`;
      await ping({ t: "inbox", guest: pl.guest });
    }
    return json({ ok: true });
  },

  /** A player's seat (or, for the host, every seat) in a running simul. */
  "POST simul/seats": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const games = await sql`select * from games where simul_id = ${String(b.id ?? "")} and (white_guest = ${p.id} or black_guest = ${p.id})`;
    return json({
      seats: games.map((g) => {
        const color = g.white_guest === p.id ? "white" : "black";
        return { id: g.id, code: g.code, color, key: g[`${color}_key`] };
      }),
    });
  },
};
