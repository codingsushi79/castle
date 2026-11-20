import { variantOf } from "./chess.js";
import { cleanName, cleanText, daysOf, fail, Handler, json, other, ping, sql, timeOf } from "./db.js";
import { blocked, createGame, GameOptions, load, remember, seatOf, takeSeat, toMove, verified } from "./game.js";
import { MUTE_AFTER_REPORTS } from "./moderation.js";
import { alert } from "./push.js";
import { randomId, seal } from "./token.js";

export const REACTIONS = ["👏", "🔥", "😮", "😂", "♟️", "💀"];
const TRANSFER_MINUTES = 15;
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // nothing that reads as another letter

async function lichessUser(lichessToken: unknown): Promise<string | undefined> {
  if (typeof lichessToken !== "string" || !lichessToken) return undefined;
  const r = await fetch("https://lichess.org/api/account", { headers: { authorization: `Bearer ${lichessToken}` } }).catch(() => undefined);
  if (!r?.ok) return undefined;
  const a = await r.json().catch(() => undefined);
  return typeof a?.id === "string" ? a.id : undefined;
}

/** Issues a fresh token from the server's copy of a profile, which retires every older token. */
async function reissue(guest: string) {
  const row = (await sql`select version, profile from guests where id = ${guest}`)[0];
  if (!row?.profile) return undefined;
  const next = { ...row.profile, id: guest, v: row.version + 1 };
  const bumped = await sql`update guests set version = ${next.v}, profile = ${JSON.stringify(next)} where id = ${guest} and version = ${row.version} returning id`;
  return bumped.length ? { token: seal(next), profile: next } : undefined;
}

/** Room ids: a game, or the chat of an arena or Swiss tournament. */
async function roomExists(id: string) {
  if (id.startsWith("arena:")) return (await sql`select 1 from arenas where id = ${id.slice(6)}`).length > 0;
  if (id.startsWith("swiss:")) return (await sql`select 1 from swiss where id = ${id.slice(6)}`).length > 0;
  if (id.startsWith("team:")) {
    const [, team, code] = id.split(":");
    return (await sql`select 1 from teams where id = ${team ?? ""} and code = ${code ?? ""}`).length > 0;
  }
  if (id.startsWith("study:")) return (await sql`select 1 from studies where id = ${id.slice(6)}`).length > 0;
  return !!(await load(id));
}

export const socialRoutes: Record<string, Handler> = {
  /** Challenges a friend: a private game, waiting for them to accept. */
  "POST challenge": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const to = String(b.to ?? "");
    if (!to || to === p.id) return fail("Choose someone to challenge.");
    if (await blocked(p.id, to)) return fail("This player isn't taking challenges from you.", 403);
    const name = cleanName(b.name);
    const o: GameOptions = { ...timeOf(b), days: daysOf(b), color: String(b.color ?? "random"), rated: b.rated !== false, public: false, variant: variantOf(b.variant) };
    const seat = await createGame(p, name, o);
    const id = randomId();
    await sql`insert into challenges (id, from_guest, from_name, from_rating, to_guest, game_id, code, minutes, increment, rated, variant)
      values (${id}, ${p.id}, ${name}, ${p.rating}, ${to}, ${seat.id}, ${seat.code}, ${o.minutes}, ${o.increment}, ${o.rated}, ${o.variant})`;
    await ping({ t: "inbox", guest: to });
    await alert(to, "Challenge", `${name} challenges you to ${o.days ? `a correspondence game (${o.days} days per move)` : `${o.minutes}+${o.increment}`}${o.variant !== "chess" ? `, ${o.variant}` : ""}.`, "/play/");
    return json({ ...seat, challenge: id });
  },

  /**
   * Marks the guest online and returns challenges for them, what became of
   * theirs, and their correspondence games (with keys, so any computer can play them).
   */
  "POST inbox": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`update guests set last_seen = now(), name = ${cleanName(b.name)} where id = ${p.id}`;
    const [incoming, outgoing, games] = await Promise.all([
      sql`select c.*, g.days from challenges c join games g on g.id = c.game_id
          where c.to_guest = ${p.id} and c.status = 'open' and g.status = 'waiting' and c.created_at > now() - interval '1 day'
          order by c.created_at desc limit 10`,
      sql`select id, to_guest, status, game_id from challenges where from_guest = ${p.id} and created_at > now() - interval '1 day'`,
      sql`select * from games where days is not null and status = 'playing' and (white_guest = ${p.id} or black_guest = ${p.id}) order by updated_at desc limit 50`,
    ]);
    return json({
      incoming: incoming.map((c) => ({ id: c.id, from: c.from_guest, name: c.from_name, rating: c.from_rating, minutes: c.minutes, increment: c.increment, days: c.days ?? null, rated: c.rated, variant: c.variant })),
      outgoing: outgoing.map((c) => ({ id: c.id, to: c.to_guest, status: c.status, game: c.game_id })),
      correspondence: games.map((g) => {
        const color = g.white_guest === p.id ? "white" : "black";
        const opp = color === "white" ? "black" : "white";
        return {
          id: g.id, code: g.code, color, key: g[`${color}_key`], myTurn: toMove(g) === color, days: g.days, ply: g.ply,
          opponent: g[`${opp}_name`], variant: variantOf(g.variant),
          deadline: g.ply >= 1 && g.last_move_at ? Number(g.last_move_at) + Number(g[`${toMove(g)}_ms`]) : null,
        };
      }),
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
      await ping({ t: "inbox", guest: c.from_guest }, { t: "game", id: c.game_id });
      return json({ ok: true });
    }
    const g = await load(c.game_id);
    const seat = g && g.status === "waiting" ? await takeSeat(g, p, cleanName(b.name)) : undefined;
    await sql`update challenges set status = ${seat ? "accepted" : "expired"} where id = ${c.id}`;
    await ping({ t: "inbox", guest: c.from_guest });
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

  /* ── Rooms: spectator chat and reactions for a game, an arena or a Swiss ── */

  "POST chat": async (_r, _u, b) => {
    const room = String(b.id ?? "");
    if (!(await roomExists(room))) return fail("No such game.", 404);
    const kind = b.kind === "react" ? "react" : "text";
    const text = kind === "react"
      ? (REACTIONS.includes(b.text) ? (b.text as string) : "")
      : cleanText(String(b.text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200));
    if (!text) return fail("Nothing to send.");
    const p = b.token ? await verified(b.token) : undefined;
    if (p && kind === "text") {
      const reports = await sql`select count(distinct reporter)::int as n from reports where reported = ${p.id} and created_at > now() - interval '1 day'`;
      if (reports[0].n >= MUTE_AFTER_REPORTS) return fail("Several players reported you, so your chat is off for a day.", 403);
    }
    const name = cleanName(b.name);
    const recent = await sql`select count(*)::int as n from chat where game_id = ${room} and name = ${name} and created_at > now() - interval '10 seconds'`;
    if (recent[0].n >= 6) return fail("Slow down a little.", 429);
    await sql`insert into chat (game_id, name, kind, text, guest) values (${room}, ${name}, ${kind}, ${text}, ${p?.id ?? null})`;
    await ping({ t: "room", room });
    return json({ ok: true });
  },

  "GET chat": async (_r, u) => {
    const id = u.searchParams.get("id") ?? "";
    const after = Number(u.searchParams.get("after") ?? 0) || 0;
    const rows = await sql`select id, name, kind, text, guest, created_at from chat where game_id = ${id} and id > ${after} order by id limit 100`;
    return json({ lines: rows.map((r) => ({ id: Number(r.id), name: r.name, kind: r.kind, text: r.text, guest: r.guest ?? null, at: new Date(r.created_at).getTime() })) });
  },

  /*
   * ── Players' chat when the game is relayed ──
   * Chat between the two players goes straight between their apps when they're
   * connected directly. When they aren't (a firewall, a browser that can't), it
   * comes through here instead, with the same filter, rate limit and report mute
   * as room chat. Lines wait in the game's private signals for the other seat,
   * which reads them with its seat key (GET signal); the live socket nudges it.
   */
  "POST say": async (_r, _u, b) => {
    const g = await load(b.id);
    const seat = g && seatOf(g, b.key);
    if (!g || !seat) return fail("You are not playing this game.", 403);
    const text = cleanText(String(b.text ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 300));
    if (!text) return fail("Nothing to send.");
    const p = b.token ? await verified(b.token) : undefined;
    if (p) {
      const reports = await sql`select count(distinct reporter)::int as n from reports where reported = ${p.id} and created_at > now() - interval '1 day'`;
      if (reports[0].n >= MUTE_AFTER_REPORTS) return fail("Several players reported you, so your chat is off for a day.", 403);
    }
    const to = other(seat);
    const recent = await sql`select count(*)::int as n from signals where game_id = ${g.id} and to_color = ${to} and body->>'t' = 'chat' and created_at > now() - interval '10 seconds'`;
    if (recent[0].n >= 6) return fail("Slow down a little.", 429);
    await sql`insert into signals (game_id, to_color, body) values (${g.id}, ${to}, ${JSON.stringify({ t: "chat", text })})`;
    await ping({ t: "say", id: g.id });
    return json({ ok: true, text });
  },

  /* ── Blocks and reports ── */

  "POST block": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const guest = String(b.guest ?? "");
    if (!guest || guest === p.id) return fail("Choose someone to block.");
    if (b.block === false) await sql`delete from blocks where guest = ${p.id} and blocked = ${guest}`;
    else await sql`insert into blocks (guest, blocked) values (${p.id}, ${guest}) on conflict do nothing`;
    return json({ ok: true });
  },

  "POST blocks": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const rows = await sql`select blocked from blocks where guest = ${p.id}`;
    return json({ blocked: rows.map((r) => r.blocked) });
  },

  /** One report per player per day counts; three different reporters mute a guest's chat for a day. */
  "POST report": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const guest = String(b.guest ?? "");
    const reason = ["chat", "cheating", "name", "stalling", "other"].includes(b.reason) ? b.reason : "other";
    if (!guest || guest === p.id) return fail("Choose someone to report.");
    const again = await sql`select 1 from reports where reporter = ${p.id} and reported = ${guest} and created_at > now() - interval '1 day'`;
    if (!again.length) await sql`insert into reports (reporter, reported, game_id, reason) values (${p.id}, ${guest}, ${b.game ? String(b.game) : null}, ${reason})`;
    return json({ ok: true });
  },

  /* ── Moving a rating to another computer ── */

  /** A short code, good for 15 minutes, that brings this rating to another computer. */
  "POST transfer/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await remember(p);
    await sql`delete from transfers where guest = ${p.id} or created_at < now() - interval '1 day'`;
    let code = "";
    for (let i = 0; i < 8; i++) code += codeChars[Math.floor(Math.random() * codeChars.length)];
    await sql`insert into transfers (code, guest) values (${code}, ${p.id})`;
    return json({ code, minutes: TRANSFER_MINUTES });
  },

  /** Brings a rating here. The other computer's copy stops working. */
  "POST transfer/claim": async (_r, _u, b) => {
    const code = String(b.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const t = (await sql`delete from transfers where code = ${code} and created_at > now() - make_interval(mins => ${TRANSFER_MINUTES}) returning guest`)[0];
    if (!t) return fail("That code is wrong or has expired.", 404);
    const r = await reissue(t.guest);
    return r ? json(r) : fail("That rating could not be moved. Try a new code.", 409);
  },

  /** Links this rating to a Lichess account, so it can be recovered by signing in to Lichess. */
  "POST lichess/link": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const user = await lichessUser(b.lichessToken);
    if (!user) return fail("Lichess did not recognise that sign-in.", 401);
    await remember(p);
    const taken = await sql`select id from guests where lichess = ${user} and id <> ${p.id}`;
    if (taken.length) return fail(`Lichess account ${user} is already linked to another Castle rating.`, 409);
    await sql`update guests set lichess = ${user} where id = ${p.id}`;
    return json({ lichess: user });
  },

  "POST lichess/unlink": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`update guests set lichess = null where id = ${p.id}`;
    return json({ ok: true });
  },

  /** Restores the rating linked to this Lichess account on this computer. */
  "POST lichess/recover": async (_r, _u, b) => {
    const user = await lichessUser(b.lichessToken);
    if (!user) return fail("Lichess did not recognise that sign-in.", 401);
    const g = (await sql`select id from guests where lichess = ${user}`)[0];
    if (!g) return fail(`No Castle rating is linked to ${user}.`, 404);
    const r = await reissue(g.id);
    return r ? json({ ...r, lichess: user }) : fail("That rating could not be restored.", 409);
  },
};
