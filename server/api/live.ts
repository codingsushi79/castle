import { Client, neonConfig } from "@neondatabase/serverless";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import "../lib/arena.js"; // finishing a game here (a flag) must still score arenas
import { sql } from "../lib/db.js";
import { settle, verified, view } from "../lib/game.js";
import { ensureSchema } from "../lib/schema.js";
import "../lib/swiss.js"; // and Swiss tournaments

/**
 * Live updates over a WebSocket, so moves, chat and challenges arrive at once
 * instead of on the app's next poll.
 *
 * A socket may land on any server instance, and the player who moves may be on
 * another. Every change is announced with Postgres NOTIFY (db.ts ping()), and
 * each instance LISTENs on a direct database connection and pushes what its
 * sockets watch at once. If it can't listen, it looks for changes itself, in
 * one query every 400 ms; while listening, that check runs every 3 s as a safety net.
 *
 * App → server: {t:"watch", games:[ids]}, {t:"rooms", rooms:[ids]}, {t:"hello", token}
 * Server → app: {t:"game", game}, {t:"room", room, lines}, {t:"inbox"},
 *   {t:"say", id}: a relayed chat line waits for a player of that game (only
 *   the seat can read it, with its key, so the nudge carries no text).
 * Vercel ends a function after a few minutes; the app reconnects.
 */
interface Sub { games: Set<string>; rooms: Set<string>; guest?: string }
const subs = new Map<WebSocket, Sub>();
const sent = new Map<string, string>(); // game id → signature of the view last pushed
let chatAfter = -1;
let inboxSince = Date.now();
let ticks = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let busy = false;
/** Whether this instance hears NOTIFY (push) or only checks (poll). */
let listening = false;
const dirty = { games: new Set<string>(), guests: new Set<string>(), rooms: false };
let flushTimer: ReturnType<typeof setTimeout> | undefined;

neonConfig.webSocketConstructor = WebSocket;

/** LISTENs for changes on a direct (unpooled) connection: pooled connections can't LISTEN. */
async function listen() {
  if (listening) return;
  const url = process.env.DATABASE_URL_UNPOOLED ?? (process.env.DATABASE_URL ?? "").replace("-pooler.", ".");
  const client = new Client(url);
  client.on("notification", (msg: { payload?: string }) => {
    try { onEvent(JSON.parse(msg.payload ?? "{}")); } catch { /* not ours */ }
  });
  client.on("error", () => {
    listening = false;
    restartTimer();
    client.end().catch(() => {});
    if (subs.size) setTimeout(() => listen().catch(() => {}), 5000);
  });
  await client.connect();
  await client.query("LISTEN castle");
  listening = true;
  restartTimer();
}

function onEvent(e: { t?: string; id?: string; guest?: string; room?: string }) {
  if (e.t === "study" && e.id) {
    // A study changed: everyone looking at it reloads it.
    for (const [ws, s] of subs) if (s.rooms.has(`study:${e.id}`)) send(ws, { t: "study", id: e.id });
    return;
  }
  if (e.t === "say" && e.id) {
    for (const [ws, s] of subs) if (s.games.has(e.id)) send(ws, { t: "say", id: e.id });
    return;
  }
  if (e.t === "game" && e.id) dirty.games.add(e.id);
  else if (e.t === "inbox" && e.guest) dirty.guests.add(e.guest);
  else if (e.t === "room") dirty.rooms = true;
  else return;
  flushTimer ??= setTimeout(flush, 15);
}

/** Pushes what the notifications said changed. */
async function flush() {
  flushTimer = undefined;
  const games = [...dirty.games], guests = new Set(dirty.guests), rooms = dirty.rooms;
  dirty.games.clear(); dirty.guests.clear(); dirty.rooms = false;
  try {
    const watched = new Set([...subs.values()].flatMap((s) => [...s.games]));
    const ids = games.filter((id) => watched.has(id));
    if (ids.length || games.length) {
      const rows = await sql`select * from games where id = any(${games})`;
      for (const g of rows) {
        // A correspondence move is news for both players' inboxes, wherever they are in the app.
        if (g.days) { if (g.white_guest) guests.add(g.white_guest); if (g.black_guest) guests.add(g.black_guest); }
        if (!watched.has(g.id)) continue;
        sent.set(g.id, signature(g));
        const msg = { t: "game", game: view(g) };
        for (const [ws, s] of subs) if (s.games.has(g.id)) send(ws, msg);
      }
    }
    for (const [ws, s] of subs) if (s.guest && guests.has(s.guest)) send(ws, { t: "inbox" });
    if (rooms) await pushRooms();
  } catch (e) {
    console.error(e);
  }
}

function restartTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = setInterval(tick, listening ? 3000 : 400);
}

const signature = (g: Record<string, any>) => [g.updated_at, g.ply, g.status, g.draw_offer, g.white_berserk, g.black_berserk].join("|");
const send = (ws: WebSocket, msg: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

async function pushGames() {
  const ids = [...new Set([...subs.values()].flatMap((s) => [...s.games]))];
  if (!ids.length) return;
  const rows = await sql`select * from games where id = any(${ids})`;
  for (let g of rows) {
    if (g.status === "playing") g = await settle(g); // a flag or a no-show ends the game for everyone watching
    const sig = signature(g);
    if (sent.get(g.id) === sig) continue;
    sent.set(g.id, sig);
    const msg = { t: "game", game: view(g) };
    for (const [ws, s] of subs) if (s.games.has(g.id)) send(ws, msg);
  }
}

async function pushRooms() {
  const rooms = [...new Set([...subs.values()].flatMap((s) => [...s.rooms]))];
  if (chatAfter < 0) chatAfter = Number((await sql`select coalesce(max(id), 0) as m from chat`)[0].m);
  if (!rooms.length) return;
  const rows = await sql`select id, game_id, name, kind, text, guest, created_at from chat where game_id = any(${rooms}) and id > ${chatAfter} order by id limit 200`;
  if (!rows.length) return;
  chatAfter = Number(rows[rows.length - 1].id);
  const by = new Map<string, any[]>();
  for (const r of rows) by.set(r.game_id, [...(by.get(r.game_id) ?? []), { id: Number(r.id), name: r.name, kind: r.kind, text: r.text, guest: r.guest ?? null, at: new Date(r.created_at).getTime() }]);
  for (const [ws, s] of subs) for (const room of s.rooms) if (by.has(room)) send(ws, { t: "room", room, lines: by.get(room) });
}

/** Nudges a guest to refresh their inbox: a new challenge, or a move in a correspondence game. */
async function pushInbox() {
  const guests = [...new Set([...subs.values()].map((s) => s.guest).filter(Boolean))] as string[];
  const since = inboxSince;
  inboxSince = Date.now();
  if (!guests.length) return;
  // New challenges for them, and moves (or endings) in their correspondence games and the games their challenges made.
  const rows = await sql`
    select to_guest as guest from challenges where to_guest = any(${guests}) and created_at > to_timestamp(${since / 1000})
    union select c.from_guest from challenges c join games g on g.id = c.game_id
      where c.from_guest = any(${guests}) and g.updated_at > to_timestamp(${since / 1000})
    union select white_guest from games where days is not null and updated_at > to_timestamp(${since / 1000}) and white_guest = any(${guests})
    union select black_guest from games where days is not null and updated_at > to_timestamp(${since / 1000}) and black_guest = any(${guests})`;
  const nudge = new Set(rows.map((r) => r.guest));
  for (const [ws, s] of subs) if (s.guest && nudge.has(s.guest)) send(ws, { t: "inbox" });
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await pushGames();
    await pushRooms();
    if (ticks++ % 4 === 0) await pushInbox();
  } catch (e) {
    console.error(e);
  } finally {
    busy = false;
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(426, { "content-type": "text/plain" });
  res.end("Castle Online live updates: connect with a WebSocket.");
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on("connection", (ws) => {
  const sub: Sub = { games: new Set(), rooms: new Set() };
  subs.set(ws, sub);
  timer ??= setInterval(tick, listening ? 3000 : 400);
  // Start reading chat from here, before any line can arrive.
  if (chatAfter < 0) sql`select coalesce(max(id), 0) as m from chat`.then((r) => { if (chatAfter < 0) chatAfter = Number(r[0].m); }).catch(() => {});
  ensureSchema(sql).catch(() => {});
  listen().catch(() => { listening = false; });
  ws.on("message", async (raw) => {
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.t === "watch" && Array.isArray(m.games)) {
      sub.games = new Set(m.games.filter((x: unknown) => typeof x === "string").slice(0, 20));
      // Send the current state of anything new straight away.
      if (sub.games.size) {
        const rows = await sql`select * from games where id = any(${[...sub.games]})`.catch(() => []);
        for (const g of rows) send(ws, { t: "game", game: view(g) });
      }
    } else if (m.t === "rooms" && Array.isArray(m.rooms)) {
      sub.rooms = new Set(m.rooms.filter((x: unknown) => typeof x === "string").slice(0, 10));
    } else if (m.t === "hello") {
      const p = await verified(m.token).catch(() => undefined);
      sub.guest = p?.id;
    } else if (m.t === "ping") {
      send(ws, { t: "pong", mode: listening ? "push" : "poll" });
    }
  });
  ws.on("close", () => {
    subs.delete(ws);
    if (!subs.size) { clearInterval(timer); timer = undefined; sent.clear(); }
  });
});

export default server;
