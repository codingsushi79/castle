import { neon } from "@neondatabase/serverless";
import { canMate, replay, Result, startFen, Variant, variantOf } from "../lib/chess.js";
import { ensureSchema } from "../lib/schema.js";
import { elo, open, Profile, randomId, seal } from "../lib/token.js";

/**
 * Castle Online: guest play with no accounts. Players' moves travel peer to
 * peer, and each move is also sent here. This server checks every move, keeps
 * the clocks, decides results, stores the games, serves spectators, relays
 * WebRTC signalling and re-seals ratings after rated games. It also carries
 * challenges between friends, spectator chat, puzzle rush scores, puzzle
 * battles and arena tournaments.
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
/** A player not heard from for this long has left: the opponent may claim the game. */
const ABANDON_MS = 30_000;
const REACTIONS = ["👏", "🔥", "😮", "😂", "♟️", "💀"];
const variantFields = (g: Row) => [variantOf(g.variant), g.initial_fen as string | null] as const;
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
  if (rows[0]?.arena_id && result !== "aborted") await scoreArena(rows[0], result);
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
      g = await finish(g, canMate(moves, other(mover), ...variantFields(g)) ? (mover === "white" ? "0-1" : "1-0") : "1/2-1/2", "time");
    } else if (g.ply < 2 && Date.now() - new Date(g.updated_at).getTime() > 60_000) {
      // Nobody made a first move within a minute.
      g = await finish(g, "aborted", "no first move");
    }
  }
  return g;
}

/** Notes that a player is still there (at most every few seconds). */
async function markSeen(g: Row, seat: Color) {
  const now = Date.now();
  if (Number(g[`${seat}_seen`] ?? 0) > now - 3000) return;
  g[`${seat}_seen`] = now;
  if (seat === "white") await sql`update games set white_seen = ${now} where id = ${g.id}`;
  else await sql`update games set black_seen = ${now} where id = ${g.id}`;
}

function seatOf(g: Row, key: unknown): Color | undefined {
  if (typeof key !== "string" || !key) return undefined;
  return g.white_key === key ? "white" : g.black_key === key ? "black" : undefined;
}

/** What anyone may see of a game. */
function view(g: Row) {
  const c = clocks(g);
  const now = Date.now();
  const away = (s: Color) => (g.status === "playing" && g[`${s}_seen`] ? Math.max(0, now - Number(g[`${s}_seen`])) : null);
  return {
    id: g.id, code: g.code, status: g.status, rated: g.rated, public: g.public,
    minutes: g.minutes, increment: g.increment, variant: variantOf(g.variant), fen: g.initial_fen ?? null,
    arena: g.arena_id ?? null, away: { white: away("white"), black: away("black") },
    white: { name: g.white_name, rating: g.white_rating, after: g.white_new, guest: g.white_guest },
    black: { name: g.black_name, rating: g.black_rating, after: g.black_new, guest: g.black_guest },
    moves: g.moves ? g.moves.split(" ") : [], ply: g.ply,
    clocks: { white: Math.max(0, c.white), black: Math.max(0, c.black) },
    running: g.status === "playing" && g.ply >= 1,
    drawOffer: g.draw_offer, result: g.result, reason: g.reason, rematch: g.rematch_id,
    now,
  };
}

interface GameOptions { minutes: number; increment: number; color: string; rated: boolean; public: boolean; variant: Variant }

async function freshCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const c = randomId(4).replace(/[-_]/g, "x").slice(0, 6).toUpperCase();
    if (!(await sql`select 1 from games where code = ${c}`).length && !(await sql`select 1 from battles where code = ${c}`).length) return c;
  }
  return randomId(6).toUpperCase();
}

async function createGame(p: Profile, name: string, o: GameOptions, swapFrom?: Row) {
  const id = randomId(), key = randomId(18);
  const color: Color = o.color === "white" || o.color === "black" ? o.color : Math.random() < 0.5 ? "white" : "black";
  const code = await freshCode();
  const fen = o.variant === "chess" ? null : startFen(o.variant);
  const ms = Math.round(o.minutes * 60_000);
  const seat = color === "white"
    ? { white_guest: p.id, white_name: name, white_key: key, white_rating: p.rating }
    : { black_guest: p.id, black_name: name, black_key: key, black_rating: p.rating };
  await sql`
    insert into games (id, code, public, rated, minutes, increment, creator_color, variant, initial_fen, white_guest, white_name, white_key, white_rating,
      black_guest, black_name, black_key, black_rating, white_ms, black_ms)
    values (${id}, ${code}, ${o.public}, ${o.rated}, ${o.minutes}, ${o.increment}, ${o.color}, ${o.variant}, ${fen},
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
    return json(await createGame(p, cleanName(b.name), { ...timeOf(b), color: String(b.color ?? "random"), rated: b.rated !== false, public: b.public !== false, variant: variantOf(b.variant) }));
  },

  "POST join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim().toUpperCase();
    const g = (await sql`select * from games where code = ${code} or id = ${String(b.code ?? "")}`)[0];
    if (!g) return fail("No game has that code.", 404);
    if (g.status !== "waiting") return fail("That game has already started.", 409);
    if (g.white_guest === p.id || g.black_guest === p.id) return fail("You can't play yourself.", 409);
    const seat = await takeSeat(g, p, cleanName(b.name));
    return seat ? json(seat) : fail("Someone else took that seat.", 409);
  },

  "GET game": async (_r, u) => {
    const g = await current(u.searchParams.get("id"));
    if (!g) return fail("No such game.", 404);
    const seat = seatOf(g, u.searchParams.get("key"));
    if (seat && g.status === "playing") await markSeen(g, seat);
    return json(view(g));
  },

  "POST move": async (_r, _u, b) => {
    let g = await current(b.id);
    if (!g) return fail("No such game.", 404);
    const seat = seatOf(g, b.key);
    if (!seat) return fail("You are not playing this game.", 403);
    if (g.status !== "playing") return json(view(g));
    await markSeen(g, seat);
    if (Number(b.ply) !== g.ply) return json(view(g)); // Already applied (sent twice: peer and server).
    if (toMove(g) !== seat) return fail("It is not your move.", 409);
    const moves: string[] = g.moves ? g.moves.split(" ") : [];
    const uci = String(b.uci ?? "");
    const r = replay([...moves, uci], ...variantFields(g));
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
    if (g.status === "playing") await markSeen(g, seat);
    /** The result if this player resigns. */
    const win: Result = seat === "white" ? "0-1" : "1-0";
    switch (b.action) {
      case "resign":
        if (g.status === "playing") g = g.ply < 2 ? await finish(g, "aborted", "aborted") : await finish(g, win, "resignation");
        else if (g.status === "waiting") await sql`update games set status = 'finished', result = 'aborted', reason = 'cancelled' where id = ${g.id} and status = 'waiting'`;
        break;
      case "abort":
        if (g.status === "playing" && g.ply < 2) g = await finish(g, "aborted", "aborted");
        break;
      case "claim":
      case "claim-draw": {
        // The opponent has gone: take the win (a draw if you could not have won), or call it a draw.
        if (g.status !== "playing" || g.ply < 2) break;
        const seen = Number(g[`${other(seat)}_seen`] ?? 0);
        if (!seen || Date.now() - seen < ABANDON_MS) return fail("Your opponent is still connected.", 409);
        const moves: string[] = g.moves ? g.moves.split(" ") : [];
        g = b.action === "claim-draw" ? await finish(g, "1/2-1/2", "opponent left")
          : await finish(g, canMate(moves, seat, ...variantFields(g)) ? (seat === "white" ? "1-0" : "0-1") : "1/2-1/2", "abandonment");
        break;
      }
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
        const made = await createGame(p, cleanName(b.name), { minutes: g.minutes, increment: g.increment, color: other(seat), rated: g.rated, public: false, variant: variantOf(g.variant) }, g);
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
    const [open, live, recent, battles] = await Promise.all([
      sql`select * from games where status = 'waiting' and public and created_at > now() - interval '15 minutes' order by created_at desc limit 30`,
      sql`select * from games where status = 'playing' and updated_at > now() - interval '10 minutes' order by updated_at desc limit 30`,
      sql`select * from games where status = 'finished' and result <> 'aborted' order by updated_at desc limit 20`,
      sql`select id, code, a_name, minutes from battles where b_guest is null and public and created_at > now() - interval '15 minutes' order by created_at desc limit 20`,
    ]);
    const seek = (g: Row) => {
      const c: Color = g.white_key ? "white" : "black";
      return { id: g.id, code: g.code, name: g[`${c}_name`], rating: g[`${c}_rating`], color: g.creator_color, minutes: g.minutes, increment: g.increment, rated: g.rated, variant: variantOf(g.variant) };
    };
    return json({
      open: open.map(seek), live: live.map(view), recent: recent.map(view),
      battles: battles.map((r) => ({ id: r.id, code: r.code, name: r.a_name, minutes: r.minutes })),
    });
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
  return takeSeat(next, p, cleanName(b.name));
}

/** Seats a guest in the empty chair of a waiting game, which starts it. */
async function takeSeat(g: Row, p: Profile, name: string) {
  const color: Color = g.white_key ? "black" : "white";
  const key = randomId(18);
  const rows = color === "white"
    ? await sql`update games set white_guest = ${p.id}, white_name = ${name}, white_key = ${key}, white_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`
    : await sql`update games set black_guest = ${p.id}, black_name = ${name}, black_key = ${key}, black_rating = ${p.rating}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`;
  return rows.length ? { id: g.id as string, code: g.code as string, color, key } : undefined;
}

function timeOf(b: any) {
  return {
    minutes: Math.min(180, Math.max(0.5, Number(b.minutes) || 5)),
    increment: Math.min(60, Math.max(0, Math.round(Number(b.increment) || 0))),
  };
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = (url.searchParams.get("r") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/\/$/, "");
  const route = routes[`${req.method} ${path}`] ?? extra[`${req.method} ${path}`];
  if (!route) return fail("Not found.", 404);
  let body: any = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  try {
    await ensureSchema(sql);
    return await route(req, url, body ?? {});
  } catch (e) {
    console.error(e);
    return fail("Server error.", 500);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;

/* ───────────────────────── Friends: challenges and presence ───────────────────────── */

const extra: Record<string, (req: Request, url: URL, body: any) => Promise<Response>> = {
  /** Challenges a friend: a private game, waiting for them to accept. */
  "POST challenge": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const to = String(b.to ?? "");
    if (!to || to === p.id) return fail("Choose someone to challenge.");
    const name = cleanName(b.name);
    const o: GameOptions = { ...timeOf(b), color: String(b.color ?? "random"), rated: b.rated !== false, public: false, variant: variantOf(b.variant) };
    const seat = await createGame(p, name, o);
    const id = randomId();
    await sql`insert into challenges (id, from_guest, from_name, from_rating, to_guest, game_id, code, minutes, increment, rated, variant)
      values (${id}, ${p.id}, ${name}, ${p.rating}, ${to}, ${seat.id}, ${seat.code}, ${o.minutes}, ${o.increment}, ${o.rated}, ${o.variant})`;
    return json({ ...seat, challenge: id });
  },

  /** Marks the guest online and returns challenges for them, and what became of theirs. */
  "POST inbox": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`update guests set last_seen = now(), name = ${cleanName(b.name)} where id = ${p.id}`;
    const [incoming, outgoing] = await Promise.all([
      sql`select c.* from challenges c join games g on g.id = c.game_id
          where c.to_guest = ${p.id} and c.status = 'open' and g.status = 'waiting' and c.created_at > now() - interval '10 minutes'
          order by c.created_at desc limit 10`,
      sql`select id, to_guest, status, game_id from challenges where from_guest = ${p.id} and created_at > now() - interval '10 minutes'`,
    ]);
    return json({
      incoming: incoming.map((c) => ({ id: c.id, from: c.from_guest, name: c.from_name, rating: c.from_rating, minutes: c.minutes, increment: c.increment, rated: c.rated, variant: c.variant })),
      outgoing: outgoing.map((c) => ({ id: c.id, to: c.to_guest, status: c.status, game: c.game_id })),
    });
  },

  "POST answer": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const c = (await sql`select * from challenges where id = ${String(b.id ?? "")} and to_guest = ${p.id} and status = 'open'`)[0];
    if (!c) return fail("That challenge is no longer open.", 404);
    if (!b.accept) {
      await sql`update challenges set status = 'declined' where id = ${c.id}`;
      await sql`update games set status = 'finished', result = 'aborted', reason = 'declined', updated_at = now() where id = ${c.game_id} and status = 'waiting'`;
      return json({ ok: true });
    }
    const g = await load(c.game_id);
    const seat = g && g.status === "waiting" ? await takeSeat(g, p, cleanName(b.name)) : undefined;
    await sql`update challenges set status = ${seat ? "accepted" : "expired"} where id = ${c.id}`;
    return seat ? json(seat) : fail("That challenge was withdrawn.", 409);
  },

  /** Which of these guests have had Castle Online open in the last minute. */
  "POST presence": async (_r, _u, b) => {
    const ids = (Array.isArray(b.ids) ? b.ids : []).filter((x: unknown) => typeof x === "string").slice(0, 100);
    if (!ids.length) return json({ players: [] });
    const rows = await sql`select id, name, last_seen from guests where id = any(${ids})`;
    const cutoff = Date.now() - 60_000;
    return json({ players: rows.map((r) => ({ id: r.id, name: r.name, online: !!r.last_seen && new Date(r.last_seen).getTime() > cutoff })) });
  },

  /* ───────────────────────── Spectator chat and reactions ───────────────────────── */

  "POST chat": async (_r, _u, b) => {
    const g = await load(b.id);
    if (!g) return fail("No such game.", 404);
    const kind = b.kind === "react" ? "react" : "text";
    const text = kind === "react"
      ? (REACTIONS.includes(b.text) ? (b.text as string) : "")
      : String(b.text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
    if (!text) return fail("Nothing to send.");
    const name = cleanName(b.name);
    const recent = await sql`select count(*)::int as n from chat where game_id = ${g.id} and name = ${name} and created_at > now() - interval '10 seconds'`;
    if (recent[0].n >= 6) return fail("Slow down a little.", 429);
    await sql`insert into chat (game_id, name, kind, text) values (${g.id}, ${name}, ${kind}, ${text})`;
    return json({ ok: true });
  },

  "GET chat": async (_r, u) => {
    const id = u.searchParams.get("id") ?? "";
    const after = Number(u.searchParams.get("after") ?? 0) || 0;
    const rows = await sql`select id, name, kind, text, created_at from chat where game_id = ${id} and id > ${after} order by id limit 100`;
    return json({ lines: rows.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, text: r.text, at: new Date(r.created_at).getTime() })) });
  },

  /* ───────────────────────── Puzzle rush scores ───────────────────────── */

  "POST rush": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const minutes = [3, 5].includes(Number(b.minutes)) ? Number(b.minutes) : 0;
    const score = Math.round(Number(b.score));
    if (!minutes || !(score >= 0 && score <= 150)) return fail("That score can't be recorded.");
    await sql`insert into rush_scores (guest, name, minutes, score) values (${p.id}, ${cleanName(b.name)}, ${minutes}, ${score})`;
    return json({ ok: true });
  },

  "GET rush": async (_r, u) => {
    const minutes = Number(u.searchParams.get("minutes")) === 5 ? 5 : 3;
    const rows = await sql`
      with best as (select distinct on (guest) guest, name, score, created_at from rush_scores where minutes = ${minutes} order by guest, score desc, created_at)
      select * from best order by score desc, created_at limit 25`;
    return json({ scores: rows.map((r) => ({ guest: r.guest, name: r.name, score: r.score })) });
  },

  /* ───────────────────────── Puzzle battles ───────────────────────── */

  /** Opens a battle. The host brings the puzzles, so both players solve the same ones. */
  "POST battle": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const puzzles = (Array.isArray(b.puzzles) ? b.puzzles : []).slice(0, 150).filter((x: any) =>
      x && typeof x.fen === "string" && x.fen.length < 100 && Array.isArray(x.moves) && x.moves.length >= 2 && x.moves.length <= 20 &&
      x.moves.every((m: unknown) => typeof m === "string" && m.length <= 5)).map((x: any) => ({ id: String(x.id ?? "").slice(0, 12), fen: x.fen, moves: x.moves, rating: Number(x.rating) || 0 }));
    if (puzzles.length < 10) return fail("A battle needs at least 10 puzzles.");
    const minutes = Math.min(10, Math.max(1, Math.round(Number(b.minutes) || 3)));
    const id = randomId(), key = randomId(18), code = await freshCode();
    await sql`insert into battles (id, code, public, minutes, puzzles, a_guest, a_name, a_key)
      values (${id}, ${code}, ${b.public !== false}, ${minutes}, ${JSON.stringify(puzzles)}, ${p.id}, ${cleanName(b.name)}, ${key})`;
    return json({ id, code, key, side: "a" });
  },

  "POST battle/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim();
    const row = (await sql`select * from battles where code = ${code.toUpperCase()} or id = ${code}`)[0];
    if (!row) return fail("No battle has that code.", 404);
    if (row.a_guest === p.id) return fail("You can't battle yourself.", 409);
    const key = randomId(18);
    const rows = await sql`update battles set b_guest = ${p.id}, b_name = ${cleanName(b.name)}, b_key = ${key}, started_at = ${Date.now() + 5000}
      where id = ${row.id} and b_guest is null returning id`;
    return rows.length ? json({ id: row.id, code: row.code, key, side: "b" }) : fail("Someone else is already in that battle.", 409);
  },

  "GET battle": async (_r, u) => {
    const row = (await sql`select * from battles where id = ${u.searchParams.get("id") ?? ""}`)[0];
    return row ? json(battleView(row)) : fail("No such battle.", 404);
  },

  /** Each player reports their running score; scores only ever go up. */
  "POST battle/progress": async (_r, _u, b) => {
    const row = (await sql`select * from battles where id = ${String(b.id ?? "")}`)[0];
    if (!row) return fail("No such battle.", 404);
    const side = row.a_key === b.key ? "a" : row.b_key && row.b_key === b.key ? "b" : undefined;
    if (!side) return fail("You are not in this battle.", 403);
    const v = battleView(row);
    if (v.status !== "running") return json(v);
    const score = Math.min(150, Math.max(0, Math.round(Number(b.score) || 0)));
    const strikes = Math.min(3, Math.max(0, Math.round(Number(b.strikes) || 0)));
    const next = side === "a"
      ? await sql`update battles set a_score = greatest(a_score, ${score}), a_strikes = greatest(a_strikes, ${strikes}) where id = ${row.id} returning *`
      : await sql`update battles set b_score = greatest(b_score, ${score}), b_strikes = greatest(b_strikes, ${strikes}) where id = ${row.id} returning *`;
    return json(battleView(next[0]));
  },

  "POST battle/cancel": async (_r, _u, b) => {
    await sql`delete from battles where id = ${String(b.id ?? "")} and a_key = ${String(b.key ?? "")} and b_guest is null`;
    return json({ ok: true });
  },

  /* ───────────────────────── Arena tournaments ───────────────────────── */

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
    return json({ now, arenas: rows.map((a) => ({ ...arenaInfo(a, now), players: by.get(a.id)?.players ?? 0, leader: by.get(a.id)?.leader ?? null, top: by.get(a.id)?.top ?? 0 })) });
  },

  "GET arena": async (_r, u) => {
    const a = (await sql`select * from arenas where id = ${u.searchParams.get("id") ?? ""}`)[0];
    if (!a) return fail("No such arena.", 404);
    const now = Date.now();
    const players = await sql`select guest, name, rating, score, streak, games, waiting_since, seat_game, last_poll from arena_players where arena_id = ${a.id} order by score desc, games limit 100`;
    return json({
      now, arena: arenaInfo(a, now),
      players: players.map((r) => ({
        guest: r.guest, name: r.name, rating: r.rating, score: r.score, streak: r.streak, games: r.games,
        playing: !!r.seat_game, active: !!r.last_poll && Number(r.last_poll) > now - 15_000,
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
    await sql`insert into arenas (id, name, minutes, increment, variant, starts_at, ends_at, created_by)
      values (${id}, ${title}, ${minutes}, ${increment}, ${variantOf(b.variant)}, ${start}, ${start + duration * 60_000}, ${p.id})`;
    return json({ id });
  },

  "POST arena/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const a = (await sql`select * from arenas where id = ${String(b.id ?? "")}`)[0];
    const now = Date.now();
    if (!a || a.ends_at <= now) return fail("That arena is over.", 409);
    await sql`insert into arena_players (arena_id, guest, name, rating, waiting_since, last_poll)
      values (${a.id}, ${p.id}, ${cleanName(b.name)}, ${p.rating}, ${now}, ${now})
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

    const others = await sql`select * from arena_players where arena_id = ${a.id} and guest <> ${p.id}
      and waiting_since is not null and seat_game is null and last_poll > ${now - 8000} order by waiting_since limit 30`;
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
    const id = randomId(), code = await freshCode(), wk = randomId(18), bk = randomId(18);
    const variant = variantOf(a.variant), fen = variant === "chess" ? null : startFen(variant);
    const ms = Math.round(Number(a.minutes) * 60_000);
    await sql`insert into games (id, code, status, public, rated, minutes, increment, creator_color, variant, initial_fen, arena_id,
        white_guest, white_name, white_key, white_rating, black_guest, black_name, black_key, black_rating, white_ms, black_ms)
      values (${id}, ${code}, 'playing', true, true, ${a.minutes}, ${a.increment}, 'random', ${variant}, ${fen}, ${a.id},
        ${white.guest}, ${white.name}, ${wk}, ${white.rating}, ${black.guest}, ${black.name}, ${bk}, ${black.rating}, ${ms}, ${ms})`;
    await sql`update arena_players set seat_game = ${id}, seat_key = ${wk}, seat_color = 'white', last_opponent = ${black.guest} where arena_id = ${a.id} and guest = ${white.guest}`;
    await sql`update arena_players set seat_game = ${id}, seat_key = ${bk}, seat_color = 'black', last_opponent = ${white.guest} where arena_id = ${a.id} and guest = ${black.guest}`;
    return json({ status: "seated", seat: { id, code, color: meWhite ? "white" : "black", key: meWhite ? wk : bk } });
  },
};

function battleView(r: Row) {
  const now = Date.now();
  const started = r.started_at ? Number(r.started_at) : null;
  const ends = started ? started + r.minutes * 60_000 : null;
  const out = r.a_strikes >= 3 && r.b_strikes >= 3;
  const status = !started ? "waiting" : now < started ? "countdown" : now >= ends! || out ? "finished" : "running";
  const side = (s: "a" | "b") => ({ name: r[`${s}_name`], guest: r[`${s}_guest`], score: r[`${s}_score`], strikes: r[`${s}_strikes`] });
  return { id: r.id, code: r.code, minutes: r.minutes, puzzles: r.puzzles, startedAt: started, endsAt: ends, now, status, a: side("a"), b: side("b") };
}

function arenaInfo(a: Row, now: number) {
  const starts = Number(a.starts_at), ends = Number(a.ends_at);
  return {
    id: a.id, name: a.name, minutes: a.minutes, increment: a.increment, variant: variantOf(a.variant),
    startsAt: starts, endsAt: ends, status: now < starts ? "upcoming" : now < ends ? "running" : "finished",
  };
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

/** Arena points: 2 for a win, 1 for a draw, doubled while on a streak of two or more wins. */
async function scoreArena(g: Row, result: Result) {
  for (const c of ["white", "black"] as Color[]) {
    const won = (result === "1-0") === (c === "white") && result !== "1/2-1/2";
    const points = result === "1/2-1/2" ? 1 : won ? 2 : 0;
    await sql`update arena_players set
        score = score + case when streak >= 2 then ${points * 2}::int else ${points}::int end,
        streak = case when ${won}::boolean then streak + 1 else 0 end,
        games = games + 1
      where arena_id = ${g.arena_id} and guest = ${g[`${c}_guest`]}`;
  }
}
