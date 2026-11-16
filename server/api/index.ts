import { neon } from "@neondatabase/serverless";
import { canMate, replay, Result } from "../lib/chess.js";
import { elo, open, Profile, randomId, seal } from "../lib/token.js";

/**
 * Castle Online: guest play with no accounts. Players' moves travel peer to
 * peer, and each move is also sent here. This server checks every move, keeps
 * the clocks, decides results, stores the games, serves spectators, relays
 * WebRTC signalling and re-seals ratings after rated games.
 */

const sql = neon(process.env.DATABASE_URL!);
type Color = "white" | "black";
type Row = Record<string, any>;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
const fail = (message: string, status = 400) => json({ error: message }, status);
const other = (c: Color): Color => (c === "white" ? "black" : "white");
const cleanName = (n: unknown) => (typeof n === "string" ? n.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 24) : "") || "Guest";

const NEW_RATING = 1500;
const fresh = (id: string): Profile => ({ id, rating: NEW_RATING, games: 0, wins: 0, losses: 0, draws: 0, peak: NEW_RATING, v: 0 });

/** A token that decrypts and is the guest's latest. */
async function verified(token: unknown): Promise<Profile | undefined> {
  const p = open(token);
  if (!p) return undefined;
  const rows = await sql`select version from guests where id = ${p.id}`;
  return rows.length && rows[0].version === p.v ? p : undefined;
}

const toMove = (g: Row): Color => (g.ply % 2 === 0 ? "white" : "black");
/** Clocks start once White has moved. */
function clocks(g: Row, now = Date.now()): Record<Color, number> {
  const c = { white: Number(g.white_ms), black: Number(g.black_ms) };
  if (g.status === "playing" && g.ply >= 1 && g.last_move_at) c[toMove(g)] -= now - Number(g.last_move_at);
  return c;
}

/** Ends a game once. Ratings move for rated games of two moves or more. */
async function finish(g: Row, result: Result | "aborted", reason: string): Promise<Row> {
  const now = Date.now();
  const c = clocks(g, now);
  let whiteNew: number | null = null, blackNew: number | null = null;
  if (g.rated && result !== "aborted" && g.ply >= 2 && g.white_rating != null && g.black_rating != null) {
    const score = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
    whiteNew = elo(g.white_rating, g.black_rating, score, 99);
    blackNew = elo(g.black_rating, g.white_rating, 1 - score, 99);
  }
  const rows = await sql`
    update games set status = 'finished', result = ${result}, reason = ${reason},
      white_ms = ${Math.max(0, c.white)}, black_ms = ${Math.max(0, c.black)}, last_move_at = ${now},
      white_new = ${whiteNew}, black_new = ${blackNew}, draw_offer = null, updated_at = now()
    where id = ${g.id} and status = 'playing' returning *`;
  return rows[0] ?? (await load(g.id))!;
}

async function load(id: unknown): Promise<Row | undefined> {
  if (typeof id !== "string") return undefined;
  const rows = await sql`select * from games where id = ${id}`;
  return rows[0];
}

/** Loads a game and settles a flag that nobody has claimed yet (an abandoned game). */
async function current(id: unknown): Promise<Row | undefined> {
  let g = await load(id);
  if (g?.status === "playing") {
    const c = clocks(g);
    const mover = toMove(g);
    if (g.ply >= 1 && c[mover] <= 0) {
      const moves = g.moves ? g.moves.split(" ") : [];
      g = await finish(g, canMate(moves, other(mover)) ? (mover === "white" ? "0-1" : "1-0") : "1/2-1/2", "time");
    } else if (g.ply < 2 && Date.now() - new Date(g.updated_at).getTime() > 60_000) {
      // Nobody made a first move within a minute.
      g = await finish(g, "aborted", "no first move");
    }
  }
  return g;
}

function seatOf(g: Row, key: unknown): Color | undefined {
  if (typeof key !== "string" || !key) return undefined;
  return g.white_key === key ? "white" : g.black_key === key ? "black" : undefined;
}

/** What anyone may see of a game. */
function view(g: Row) {
  const c = clocks(g);
  return {
    id: g.id, code: g.code, status: g.status, rated: g.rated, public: g.public,
    minutes: g.minutes, increment: g.increment,
    white: { name: g.white_name, rating: g.white_rating, after: g.white_new, guest: g.white_guest },
    black: { name: g.black_name, rating: g.black_rating, after: g.black_new, guest: g.black_guest },
    moves: g.moves ? g.moves.split(" ") : [], ply: g.ply,
    clocks: { white: Math.max(0, c.white), black: Math.max(0, c.black) },
    running: g.status === "playing" && g.ply >= 1,
    drawOffer: g.draw_offer, result: g.result, reason: g.reason, rematch: g.rematch_id,
    now: Date.now(),
  };
}

async function createGame(p: Profile, name: string, o: { minutes: number; increment: number; color: string; rated: boolean; public: boolean }, swapFrom?: Row) {
  const id = randomId(), key = randomId(18);
  const color: Color = o.color === "white" || o.color === "black" ? o.color : Math.random() < 0.5 ? "white" : "black";
  let code = "";
  for (let i = 0; i < 5 && !code; i++) {
    const c = randomId(4).replace(/[-_]/g, "x").slice(0, 6).toUpperCase();
    if (!(await sql`select 1 from games where code = ${c}`).length) code = c;
  }
  const ms = Math.round(o.minutes * 60_000);
  const seat = color === "white"
    ? { white_guest: p.id, white_name: name, white_key: key, white_rating: p.rating }
    : { black_guest: p.id, black_name: name, black_key: key, black_rating: p.rating };
  await sql`
    insert into games (id, code, public, rated, minutes, increment, creator_color, white_guest, white_name, white_key, white_rating,
      black_guest, black_name, black_key, black_rating, white_ms, black_ms)
    values (${id}, ${code}, ${o.public}, ${o.rated}, ${o.minutes}, ${o.increment}, ${o.color},
      ${seat.white_guest ?? null}, ${seat.white_name ?? null}, ${seat.white_key ?? null}, ${seat.white_rating ?? null},
      ${seat.black_guest ?? null}, ${seat.black_name ?? null}, ${seat.black_key ?? null}, ${seat.black_rating ?? null}, ${ms}, ${ms})`;
  if (swapFrom) await sql`update games set rematch_id = ${id}, updated_at = now() where id = ${swapFrom.id}`;
  return { id, code, color, key };
}

const routes: Record<string, (req: Request, url: URL, body: any) => Promise<Response>> = {
  /** A new guest, with a fresh rating. */
  "POST guest": async () => {
    const id = randomId();
    await sql`insert into guests (id) values (${id})`;
    const p = fresh(id);
    return json({ token: seal(p), profile: p });
  },

  /** Checks a stored token and returns what it holds. */
  "POST me": async (_r, _u, b) => {
    const p = await verified(b.token);
    return p ? json({ profile: p }) : fail("That rating token is not valid.", 401);
  },

  "POST games": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const minutes = Math.min(180, Math.max(0.5, Number(b.minutes) || 5));
    const increment = Math.min(60, Math.max(0, Math.round(Number(b.increment) || 0)));
    return json(await createGame(p, cleanName(b.name), { minutes, increment, color: String(b.color ?? "random"), rated: b.rated !== false, public: b.public !== false }));
  },

  "POST join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim().toUpperCase();
    const g = (await sql`select * from games where code = ${code} or id = ${String(b.code ?? "")}`)[0];
    if (!g) return fail("No game has that code.", 404);
    if (g.status !== "waiting") return fail("That game has already started.", 409);
    if (g.white_guest === p.id || g.black_guest === p.id) return fail("You can't play yourself.", 409);
    const color: Color = g.white_key ? "black" : "white";
    const key = randomId(18), name = cleanName(b.name);
    const rows = color === "white"
      ? await sql`update games set white_guest = ${p.id}, white_name = ${name}, white_key = ${key}, white_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`
      : await sql`update games set black_guest = ${p.id}, black_name = ${name}, black_key = ${key}, black_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`;
    if (!rows.length) return fail("Someone else took that seat.", 409);
    return json({ id: g.id, code: g.code, color, key });
  },

  "GET game": async (_r, u) => {
    const g = await current(u.searchParams.get("id"));
    return g ? json(view(g)) : fail("No such game.", 404);
  },

  "POST move": async (_r, _u, b) => {
    let g = await current(b.id);
    if (!g) return fail("No such game.", 404);
    const seat = seatOf(g, b.key);
    if (!seat) return fail("You are not playing this game.", 403);
    if (g.status !== "playing") return json(view(g));
    if (Number(b.ply) !== g.ply) return json(view(g)); // Already applied (sent twice: peer and server).
    if (toMove(g) !== seat) return fail("It is not your move.", 409);
    const moves: string[] = g.moves ? g.moves.split(" ") : [];
    const uci = String(b.uci ?? "");
    const r = replay([...moves, uci]);
    if (!r.ok) return fail("That move is not legal.", 422);
    const now = Date.now();
    const c = clocks(g, now);
    const inc = g.increment * 1000;
    const ms = { white: Number(g.white_ms), black: Number(g.black_ms) };
    if (g.ply >= 1) ms[seat] = c[seat] + inc;
    const rows = await sql`
      update games set moves = ${[...moves, uci].join(" ")}, ply = ply + 1, white_ms = ${ms.white}, black_ms = ${ms.black},
        last_move_at = ${now}, draw_offer = case when draw_offer = ${seat} then draw_offer else null end, updated_at = now()
      where id = ${g.id} and ply = ${g.ply} and status = 'playing' returning *`;
    if (!rows.length) return json(view((await load(g.id))!));
    g = rows[0];
    if (r.ended) g = await finish(g, r.ended.result, r.ended.reason);
    return json(view(g));
  },

  /** Resign, abort, offer/accept/decline a draw, claim a flag, or start a rematch. */
  "POST action": async (_r, _u, b) => {
    let g = await current(b.id);
    if (!g) return fail("No such game.", 404);
    const seat = seatOf(g, b.key);
    if (!seat) return fail("You are not playing this game.", 403);
    const win: Result = seat === "white" ? "0-1" : "1-0";
    switch (b.action) {
      case "resign":
        if (g.status === "playing") g = g.ply < 2 ? await finish(g, "aborted", "aborted") : await finish(g, win, "resignation");
        else if (g.status === "waiting") await sql`update games set status = 'finished', result = 'aborted', reason = 'cancelled' where id = ${g.id} and status = 'waiting'`;
        break;
      case "abort":
        if (g.status === "playing" && g.ply < 2) g = await finish(g, "aborted", "aborted");
        break;
      case "cancel": {
        // Only withdraws a game nobody has joined; a game that just started is left alone.
        const rows = await sql`update games set status = 'finished', result = 'aborted', reason = 'cancelled', updated_at = now() where id = ${g.id} and status = 'waiting' returning *`;
        g = rows[0] ?? (await load(g.id))!;
        break;
      }
      case "draw":
        if (g.status === "playing" && g.ply >= 2) {
          if (g.draw_offer === other(seat)) g = await finish(g, "1/2-1/2", "agreement");
          else g = (await sql`update games set draw_offer = ${seat}, updated_at = now() where id = ${g.id} returning *`)[0];
        }
        break;
      case "decline":
        if (g.draw_offer === other(seat)) g = (await sql`update games set draw_offer = null, updated_at = now() where id = ${g.id} returning *`)[0];
        break;
      case "rematch": {
        if (g.status !== "finished") break;
        if (g.rematch_id) return json({ ...view(g), rematchSeat: await rematchSeat(g, seat, b) });
        const p = await verified(b.token);
        if (!p) return fail("Your rating token is not valid.", 401);
        const made = await createGame(p, cleanName(b.name), { minutes: g.minutes, increment: g.increment, color: other(seat), rated: g.rated, public: false }, g);
        return json({ ...view((await load(g.id))!), rematchSeat: made });
      }
    }
    return json(view((await load(g.id))!));
  },

  /** After a rated game, each player trades their token for one with the new rating. */
  "POST claim": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const g = await current(b.id);
    if (!g || g.status !== "finished") return fail("That game is not over.", 409);
    const seat: Color | undefined = g.white_guest === p.id ? "white" : g.black_guest === p.id ? "black" : undefined;
    if (!seat) return fail("You did not play in that game.", 403);
    const after = g[`${seat}_new`];
    if (after == null) return json({ token: b.token, profile: p, unchanged: true });
    const claimed = seat === "white"
      ? await sql`update games set white_claimed = true where id = ${g.id} and not white_claimed returning id`
      : await sql`update games set black_claimed = true where id = ${g.id} and not black_claimed returning id`;
    if (!claimed.length) return json({ token: b.token, profile: p, unchanged: true });
    const score = g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (seat === "white") ? 1 : 0;
    const next: Profile = {
      ...p, rating: after, games: p.games + 1, v: p.v + 1, peak: Math.max(p.peak, after),
      wins: p.wins + (score === 1 ? 1 : 0), losses: p.losses + (score === 0 ? 1 : 0), draws: p.draws + (score === 0.5 ? 1 : 0),
    };
    const bumped = await sql`update guests set version = ${next.v} where id = ${p.id} and version = ${p.v} returning id`;
    if (!bumped.length) return fail("Your rating changed somewhere else; reload it.", 409);
    return json({ token: seal(next), profile: next });
  },

  "POST signal": async (_r, _u, b) => {
    const g = await load(b.id);
    const seat = g && seatOf(g, b.key);
    if (!g || !seat) return fail("You are not playing this game.", 403);
    if (JSON.stringify(b.body ?? null).length > 20_000) return fail("Too large.", 413);
    await sql`insert into signals (game_id, to_color, body) values (${g.id}, ${other(seat)}, ${JSON.stringify(b.body)})`;
    return json({ ok: true });
  },

  "GET signal": async (_r, u) => {
    const g = await load(u.searchParams.get("id"));
    const seat = g && seatOf(g, u.searchParams.get("key"));
    if (!g || !seat) return fail("You are not playing this game.", 403);
    const after = Number(u.searchParams.get("after") ?? 0) || 0;
    const rows = await sql`select id, body from signals where game_id = ${g.id} and to_color = ${seat} and id > ${after} order by id limit 50`;
    return json({ signals: rows.map((r) => ({ id: Number(r.id), body: r.body })) });
  },

  /** Open seeks to accept, games to watch, and games just finished. */
  "GET lobby": async () => {
    const [open, live, recent] = await Promise.all([
      sql`select * from games where status = 'waiting' and public and created_at > now() - interval '15 minutes' order by created_at desc limit 30`,
      sql`select * from games where status = 'playing' and updated_at > now() - interval '10 minutes' order by updated_at desc limit 30`,
      sql`select * from games where status = 'finished' and result <> 'aborted' order by updated_at desc limit 20`,
    ]);
    const seek = (g: Row) => {
      const c: Color = g.white_key ? "white" : "black";
      return { id: g.id, code: g.code, name: g[`${c}_name`], rating: g[`${c}_rating`], color: g.creator_color, minutes: g.minutes, increment: g.increment, rated: g.rated };
    };
    return json({ open: open.map(seek), live: live.map(view), recent: recent.map(view) });
  },

  /** Best current ratings, from each guest's latest rated game. */
  "GET leaderboard": async () => {
    const rows = await sql`
      with seats as (
        select white_guest as guest, white_name as name, white_new as rating, updated_at from games where white_new is not null
        union all
        select black_guest, black_name, black_new, updated_at from games where black_new is not null
      ), latest as (
        select distinct on (guest) guest, name, rating, updated_at from seats order by guest, updated_at desc
      ), counts as (select guest, count(*)::int as games from seats group by guest)
      select latest.*, counts.games from latest join counts using (guest)
      where latest.updated_at > now() - interval '60 days'
      order by rating desc limit 25`;
    return json({ players: rows.map((r) => ({ guest: r.guest, name: r.name, rating: r.rating, games: r.games })) });
  },

  /** A guest's own games, newest first. */
  "GET history": async (_r, u) => {
    const guest = u.searchParams.get("guest") ?? "";
    const rows = await sql`select * from games where (white_guest = ${guest} or black_guest = ${guest}) and status = 'finished' order by updated_at desc limit 50`;
    return json({ games: rows.map(view) });
  },
};

async function rematchSeat(g: Row, seat: Color, b: any) {
  // The other player asked first: join their new game.
  const next = await load(g.rematch_id);
  if (!next) return undefined;
  if (next.status !== "waiting") {
    const mine = next.white_guest === g[`${seat}_guest`] ? "white" : next.black_guest === g[`${seat}_guest`] ? "black" : undefined;
    return mine ? { id: next.id, code: next.code, color: mine, key: next[`${mine}_key`] } : undefined;
  }
  const p = await verified(b.token);
  if (!p || p.id === (next.white_guest ?? next.black_guest)) return undefined;
  const color: Color = next.white_key ? "black" : "white";
  const key = randomId(18), name = cleanName(b.name);
  const rows = color === "white"
    ? await sql`update games set white_guest = ${p.id}, white_name = ${name}, white_key = ${key}, white_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${next.id} and status = 'waiting' returning id`
    : await sql`update games set black_guest = ${p.id}, black_name = ${name}, black_key = ${key}, black_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${next.id} and status = 'waiting' returning id`;
  return rows.length ? { id: next.id, code: next.code, color, key } : undefined;
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = (url.searchParams.get("r") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/\/$/, "");
  const route = routes[`${req.method} ${path}`];
  if (!route) return fail("Not found.", 404);
  let body: any = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  try {
    return await route(req, url, body ?? {});
  } catch (e) {
    console.error(e);
    return fail("Server error.", 500);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
