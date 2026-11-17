import { canMate, replay, Result, variantOf } from "../lib/chess.js";
import { cleanName, Color, daysOf, fail, Handler, json, other, ping, Row, sql, timeOf, CORS } from "../lib/db.js";
import {
  ABANDON_MS, blocked, clocks, createGame, current, finish, fresh, load, markSeen, movesOf, remember, seatOf, startMs, takeSeat,
  toMove, variantFields, verified, view,
} from "../lib/game.js";
import { arenaRoutes } from "../lib/arena.js";
import { legacyRoutes, openBattles } from "../lib/legacy.js";
import { openRaces, raceRoutes } from "../lib/race.js";
import { ratingIn } from "../lib/ratings.js";
import { ensureSchema } from "../lib/schema.js";
import { findShared, pgnResponse, sharePage } from "../lib/share.js";
import { socialRoutes } from "../lib/social.js";
import { swissRoutes } from "../lib/swiss.js";
import { teamRoutes } from "../lib/teams.js";
import { extraRoutes } from "../lib/extras.js";
import { banOf, modRoutes } from "../lib/mod.js";
import { open, Profile, randomId, seal } from "../lib/token.js";

/**
 * Castle Online: guest play with no accounts. Players' moves travel peer to
 * peer, and each move is also sent here. This server checks every move, keeps
 * the clocks, decides results, stores the games, serves spectators, relays
 * WebRTC signalling and re-seals ratings after rated games. The modules in
 * lib/ add friends and challenges, rooms, moderation, arenas, Swiss
 * tournaments and checked puzzle races; api/live.ts pushes updates over a WebSocket.
 */

const core: Record<string, Handler> = {
  /** A new guest, with a fresh rating. */
  "POST guest": async () => {
    const id = randomId();
    const p = fresh(id);
    await sql`insert into guests (id, profile) values (${id}, ${JSON.stringify(p)})`;
    return json({ token: seal(p), profile: p });
  },

  /** Checks a stored token and returns what it holds. A token replaced elsewhere is reported as moved. */
  "POST me": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) {
      const claimed = open(b.token);
      const row = claimed && (await sql`select version from guests where id = ${claimed.id}`)[0];
      return row ? fail("This rating was moved to another computer or restored there.", 401, "moved") : fail("That rating token is not valid.", 401);
    }
    await remember(p);
    const link = (await sql`select lichess from guests where id = ${p.id}`)[0];
    const ban = await banOf(p.id);
    return json({ profile: p, lichess: link?.lichess ?? null, banned: ban ? { until: ban.until, reason: ban.reason } : null });
  },

  "POST games": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    return json(await createGame(p, cleanName(b.name), { ...timeOf(b), days: daysOf(b), color: String(b.color ?? "random"), rated: b.rated !== false, public: b.public !== false, variant: variantOf(b.variant) }));
  },

  "POST join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim().toUpperCase();
    const g = (await sql`select * from games where code = ${code} or id = ${String(b.code ?? "")}`)[0];
    if (!g) return fail("No game has that code.", 404);
    if (g.status !== "waiting") return fail("That game has already started.", 409);
    if (g.white_guest === p.id || g.black_guest === p.id) return fail("You can't play yourself.", 409);
    if (await blocked(g.white_guest ?? g.black_guest, p.id)) return fail("You can't join this game.", 403);
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
    const moves = movesOf(g);
    const uci = String(b.uci ?? "");
    const r = replay([...moves, uci], ...variantFields(g));
    if (!r.ok) return fail("That move is not legal.", 422);
    const now = Date.now();
    const c = clocks(g, now);
    const ms = { white: Number(g.white_ms), black: Number(g.black_ms) };
    // Correspondence: each move refills the mover's days. Otherwise the increment, unless berserk.
    if (g.days) ms[seat] = startMs({ minutes: Number(g.minutes), days: g.days });
    else if (g.ply >= 1) ms[seat] = c[seat] + (g[`${seat}_berserk`] ? 0 : g.increment * 1000);
    const rows = await sql`
      update games set moves = ${[...moves, uci].join(" ")}, ply = ply + 1, white_ms = ${ms.white}, black_ms = ${ms.black},
        last_move_at = ${now}, draw_offer = case when draw_offer = ${seat} then draw_offer else null end, takeback_offer = null, updated_at = now()
      where id = ${g.id} and ply = ${g.ply} and status = 'playing' returning *`;
    if (!rows.length) return json(view((await load(g.id))!));
    g = rows[0];
    await ping({ t: "game", id: g.id });
    if (r.ended) g = await finish(g, r.ended.result, r.ended.reason);
    return json(view(g));
  },

  /** Resign, abort, offer/accept/decline a draw, claim an abandoned game, berserk, or start a rematch. */
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
      case "berserk": {
        // Arenas only: before your first move, halve your clock and give up the increment for a bonus point.
        const before = seat === "white" ? g.ply === 0 : g.ply <= 1;
        if (!g.arena_id || g.status !== "playing" || !before || g[`${seat}_berserk`]) break;
        const half = Math.round(Number(g[`${seat}_ms`]) / 2);
        g = seat === "white"
          ? (await sql`update games set white_berserk = true, white_ms = ${half}, updated_at = now() where id = ${g.id} and not white_berserk returning *`)[0] ?? g
          : (await sql`update games set black_berserk = true, black_ms = ${half}, updated_at = now() where id = ${g.id} and not black_berserk returning *`)[0] ?? g;
        break;
      }
      case "claim":
      case "claim-draw": {
        // The opponent has gone: take the win (a draw if you could not have won), or call it a draw.
        if (g.status !== "playing" || g.ply < 2 || g.days) break;
        const seen = Number(g[`${other(seat)}_seen`] ?? 0);
        if (!seen || Date.now() - seen < ABANDON_MS) return fail("Your opponent is still connected.", 409);
        g = b.action === "claim-draw" ? await finish(g, "1/2-1/2", "opponent left")
          : await finish(g, canMate(movesOf(g), seat, ...variantFields(g)) ? (seat === "white" ? "1-0" : "0-1") : "1/2-1/2", "abandonment");
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
      case "takeback": {
        // Casual games only. Asking again after the opponent asked accepts their request.
        if (g.status !== "playing" || g.rated || g.arena_id || g.swiss_id) return fail("Takebacks are for casual games.", 409);
        if (g.takeback_offer === other(seat)) {
          // Undo the asker's last move, and this player's reply to it if there was one.
          const asker = other(seat);
          const count = toMove(g) === asker ? 2 : 1;
          if (g.ply < count) break;
          const c = clocks(g);
          const kept = movesOf(g).slice(0, g.ply - count);
          g = (await sql`update games set moves = ${kept.join(" ")}, ply = ${kept.length}, rev = rev + 1, takeback_offer = null, draw_offer = null,
              white_ms = ${Math.max(0, c.white)}, black_ms = ${Math.max(0, c.black)}, last_move_at = ${Date.now()}, updated_at = now()
            where id = ${g.id} and ply = ${g.ply} and status = 'playing' returning *`)[0] ?? g;
        } else if (g.ply >= (seat === "white" ? 1 : 2)) {
          g = (await sql`update games set takeback_offer = ${seat}, updated_at = now() where id = ${g.id} returning *`)[0];
        }
        break;
      }
      case "takeback-decline":
        if (g.takeback_offer === other(seat)) g = (await sql`update games set takeback_offer = null, updated_at = now() where id = ${g.id} returning *`)[0];
        break;
      case "rematch": {
        if (g.status !== "finished" || g.arena_id || g.swiss_id) break;
        if (g.rematch_id) return json({ ...view(g), rematchSeat: await rematchSeat(g, seat, b) });
        const p = await verified(b.token);
        if (!p) return fail("Your rating token is not valid.", 401);
        const made = await createGame(p, cleanName(b.name), { minutes: g.minutes, increment: g.increment, days: g.days, color: other(seat), rated: g.rated, public: false, variant: variantOf(g.variant) }, g);
        return json({ ...view((await load(g.id))!), rematchSeat: made });
      }
    }
    await ping({ t: "game", id: g.id });
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
    const category: string = g.category ?? "blitz";
    const before = g[`${seat}_rating`] ?? ratingIn(p, category);
    const prev = p.ratings?.[category];
    const overall = Math.max(100, p.rating + (after - before));
    const next: Profile = {
      ...p, v: p.v + 1, games: p.games + 1,
      rating: overall, peak: Math.max(p.peak, overall),
      ratings: { ...(p.ratings ?? {}), [category]: { r: after, g: (prev?.g ?? 0) + 1, p: Math.max(prev?.p ?? after, after) } },
      wins: p.wins + (score === 1 ? 1 : 0), losses: p.losses + (score === 0 ? 1 : 0), draws: p.draws + (score === 0.5 ? 1 : 0),
    };
    const bumped = await sql`update guests set version = ${next.v}, profile = ${JSON.stringify(next)} where id = ${p.id} and version = ${p.v} returning id`;
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

  /** Open seeks to accept, games to watch, games just finished, and open puzzle battles. */
  "GET lobby": async () => {
    const [open, live, recent, battles, races] = await Promise.all([
      // Correspondence seeks wait three days; live ones fifteen minutes.
      sql`select * from games where status = 'waiting' and public
        and (created_at > now() - interval '15 minutes' or (days is not null and created_at > now() - interval '3 days'))
        order by created_at desc limit 40`,
      sql`select * from games where status = 'playing' and (updated_at > now() - interval '10 minutes' or days is not null) order by updated_at desc limit 30`,
      sql`select * from games where status = 'finished' and result <> 'aborted' order by updated_at desc limit 20`,
      openBattles(),
      openRaces(),
    ]);
    const seek = (g: Row) => {
      const c: Color = g.white_key ? "white" : "black";
      return {
        id: g.id, code: g.code, guest: g[`${c}_guest`], name: g[`${c}_name`], rating: g[`${c}_rating`], color: g.creator_color,
        minutes: g.minutes, increment: g.increment, days: g.days ?? null, rated: g.rated, variant: variantOf(g.variant), category: g.category ?? null,
      };
    };
    return json({ open: open.map(seek), live: live.map(view), recent: recent.map(view), battles, races });
  },

  /** Best current ratings in a category (or across all, as Castle 2.3.0 asks), from each guest's latest rated game. */
  "GET leaderboard": async (_r, u) => {
    const category = u.searchParams.get("category");
    const rows = await sql`
      with seats as (
        select white_guest as guest, white_name as name, white_new as rating, updated_at, category from games where white_new is not null
        union all
        select black_guest, black_name, black_new, updated_at, category from games where black_new is not null
      ), filtered as (select * from seats where ${category}::text is null or category = ${category}),
      latest as (select distinct on (guest) guest, name, rating, updated_at from filtered order by guest, updated_at desc),
      counts as (select guest, count(*)::int as games from filtered group by guest)
      select latest.*, counts.games from latest join counts using (guest)
      where latest.updated_at > now() - interval '60 days'
      order by rating desc limit 25`;
    return json({ category, players: rows.map((r) => ({ guest: r.guest, name: r.name, rating: r.rating, games: r.games })) });
  },

  /** A guest's own finished games, newest first. */
  "GET history": async (_r, u) => {
    const guest = u.searchParams.get("guest") ?? "";
    const rows = await sql`select * from games where (white_guest = ${guest} or black_guest = ${guest}) and status = 'finished' order by updated_at desc limit 50`;
    return json({ games: rows.map(view) });
  },

  /** Castle TV: the live game between the highest-rated players. */
  "GET tv": async (_r, u) => {
    const skip = u.searchParams.get("skip") ?? "";
    const category = u.searchParams.get("category");
    const rows = await sql`select * from games where status = 'playing' and days is null and ply >= 2 and id <> ${skip}
      and (${category}::text is null or category = ${category})
      and updated_at > now() - interval '3 minutes' order by coalesce(white_rating, 1500) + coalesce(black_rating, 1500) desc limit 1`;
    return rows.length ? json(view(rows[0])) : json({ none: true });
  },

  /** The share page for a game (/g/<code>) and its PGN (/g/<code>.pgn). */
  "GET g": async (_r, u) => {
    const raw = u.searchParams.get("id") ?? "";
    const pgn = raw.endsWith(".pgn");
    const g = await findShared(pgn ? raw.slice(0, -4) : raw);
    if (!g) return new Response("No such game.", { status: 404, headers: { "content-type": "text/plain", ...CORS } });
    return pgn ? pgnResponse(g) : sharePage(g);
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

const routes: Record<string, Handler> = {
  ...core, ...socialRoutes, ...arenaRoutes, ...swissRoutes, ...raceRoutes, ...legacyRoutes, ...teamRoutes, ...extraRoutes, ...modRoutes,
};

/** Things a banned player can't do: start or join games, challenge, chat, enter tournaments or races. */
const BANNED_FROM = new Set([
  "POST games", "POST join", "POST challenge", "POST answer", "POST chat", "POST arena/join", "POST arena/pair", "POST arena/create",
  "POST swiss/join", "POST swiss/pair", "POST swiss/create", "POST race/rush", "POST race/storm", "POST race/battle", "POST race/join",
  "POST team/create", "POST team/join", "POST battle", "POST battle/join", "POST rush",
]);

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const path = (url.searchParams.get("r") ?? url.pathname.replace(/^\/api\/?/, "")).replace(/\/$/, "");
  const route = routes[`${req.method} ${path}`];
  if (!route) return fail("Not found.", 404);
  let body: any = {};
  if (req.method === "POST") body = await req.json().catch(() => ({}));
  try {
    await ensureSchema(sql);
    if (BANNED_FROM.has(`${req.method} ${path}`) && body?.token) {
      const who = open(body.token);
      const ban = who && (await banOf(who.id));
      if (ban) return fail(`Your Castle Online account is suspended until ${new Date(ban.until).toUTCString()}${ban.reason ? `: ${ban.reason}` : "."}`, 403, "banned");
    }
    return await route(req, url, body ?? {});
  } catch (e) {
    console.error(e);
    return fail("Server error.", 500);
  }
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
