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
 * another. So each instance looks for changes to everything its own sockets
 * watch, in one query every 400 ms, and only while someone is connected.
 *
 * App → server: {t:"watch", games:[ids]}, {t:"rooms", rooms:[ids]}, {t:"hello", token}
 * Server → app: {t:"game", game}, {t:"room", room, lines}, {t:"inbox"}
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
  timer ??= setInterval(tick, 400);
  ensureSchema(sql).catch(() => {});
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
      send(ws, { t: "pong" });
    }
  });
  ws.on("close", () => {
    subs.delete(ws);
    if (!subs.size) { clearInterval(timer); timer = undefined; sent.clear(); }
  });
});

export default server;
