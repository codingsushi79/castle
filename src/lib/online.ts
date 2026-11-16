import { create } from "zustand";
import { Color, GameTree, moveFromUci, START_FEN, tryPosition } from "./chess";
import { Sound } from "./sound";
import { load, save } from "./storage";

/**
 * Castle Online: games between guests with no accounts. Moves travel directly
 * between the two players over a WebRTC data channel, and are also sent to
 * Castle's server, which checks them, keeps the clocks, stores the game and lets
 * others watch. When no direct connection can be made, moves go through the
 * server alone.
 *
 * The rating is kept on this computer as a token that only the server can read
 * or write, so it can't be edited or rolled back.
 */
export const ONLINE_API = "https://castle-online.vercel.app/api";

export interface Profile { id: string; rating: number; games: number; wins: number; losses: number; draws: number; peak: number }
export interface Side { name: string | null; rating: number | null; after: number | null; guest: string | null }
export interface GameView {
  id: string; code: string; status: "waiting" | "playing" | "finished"; rated: boolean; public: boolean;
  minutes: number; increment: number; white: Side; black: Side;
  moves: string[]; ply: number; clocks: Record<Color, number>; running: boolean;
  drawOffer: Color | null; result: string | null; reason: string | null; rematch: string | null; now: number;
}
export interface Seek { id: string; code: string; name: string; rating: number; color: string; minutes: number; increment: number; rated: boolean }
export interface Seat { id: string; code: string; color: Color; key: string }
export interface Leader { guest: string; name: string; rating: number; games: number }
export interface ChatLine { from: Color | "system"; text: string }

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${ONLINE_API}/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? `The server answered ${r.status}.`), { status: r.status });
  return data as T;
}

const randomName = () => `Guest${Math.floor(1000 + Math.random() * 9000)}`;
const ICE: RTCConfiguration = { iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"] }] };

interface State {
  name: string;
  profile?: Profile;
  ready: boolean;
  error?: string;
  open: Seek[];
  live: GameView[];
  recent: GameView[];
  leaders: Leader[];
  history: GameView[];
  /** The game on screen: one being played (with a seat) or watched (without). */
  game?: GameView;
  seat?: Seat;
  /** When `game` arrived, by this computer's clock, for counting clocks down. */
  receivedAt: number;
  link: "none" | "connecting" | "direct" | "relay";
  chat: ChatLine[];
  setName: (name: string) => void;
  start: () => Promise<void>;
  refreshLobby: () => Promise<void>;
  create: (o: { minutes: number; increment: number; color: string; rated: boolean; public: boolean }) => Promise<void>;
  join: (code: string) => Promise<void>;
  watch: (id: string) => void;
  leave: () => void;
  move: (uci: string) => void;
  act: (action: "resign" | "abort" | "draw" | "decline" | "rematch") => Promise<void>;
  say: (text: string) => void;
  toTree: (g?: GameView) => GameTree;
}

let poll: ReturnType<typeof setInterval> | undefined;
let signalPoll: ReturnType<typeof setInterval> | undefined;
let peer: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let signalAfter = 0;
let pendingIce: RTCIceCandidateInit[] = [];
const claimed = new Set<string>(load<string[]>("onlineClaimed", []));

export const useOnline = create<State>((set, get) => {
  const token = () => load<string>("onlineToken", "");

  /** Takes a server view unless it is behind moves this side already knows. */
  const accept = (v: GameView) => {
    const g = get().game;
    if (g && g.id === v.id && v.status === "playing" && v.ply < g.ply) {
      if (v.drawOffer !== g.drawOffer) set({ game: { ...g, drawOffer: v.drawOffer } });
      return;
    }
    const before = g && g.id === v.id ? g : undefined;
    if (before && v.ply > before.ply) Sound.move();
    if (before && before.status !== "finished" && v.status === "finished") {
      Sound.end();
      set({ chat: [...get().chat, { from: "system", text: `Game over: ${v.result === "aborted" ? "aborted" : `${v.result}, ${v.reason}`}.` }] });
    }
    if (before && v.drawOffer && v.drawOffer !== before.drawOffer && v.drawOffer !== get().seat?.color) {
      set({ chat: [...get().chat, { from: "system", text: `${v.drawOffer === "white" ? "White" : "Black"} offers a draw.` }] });
    }
    set({ game: v, receivedAt: Date.now() });
    if (v.status === "finished") claim(v);
  };

  /** After a rated game, trades the rating token for one with the new rating. */
  const claim = async (v: GameView) => {
    const seat = get().seat;
    if (!seat || seat.id !== v.id || !v.rated || claimed.has(v.id)) return;
    claimed.add(v.id);
    save("onlineClaimed", [...claimed].slice(-200));
    try {
      const r = await api<{ token: string; profile: Profile }>("claim", { token: token(), id: v.id });
      save("onlineToken", r.token);
      set({ profile: r.profile });
    } catch (e: any) {
      claimed.delete(v.id);
      set({ error: e.message });
    }
  };

  const fetchGame = async () => {
    const g = get().game;
    if (!g) return;
    try {
      accept(await api<GameView>(`game?id=${encodeURIComponent(g.id)}`));
    } catch { /* try again on the next tick */ }
  };

  const schedule = () => {
    clearInterval(poll);
    const fast = get().link !== "direct" || get().game?.status === "waiting";
    poll = setInterval(() => {
      fetchGame();
      const g = get().game;
      if (g?.status === "finished" && g.rematch && get().seat) clearInterval(poll);
    }, fast ? 1000 : 3000);
  };

  const closePeer = () => {
    clearInterval(signalPoll);
    channel?.close();
    peer?.close();
    channel = peer = undefined;
    pendingIce = [];
    signalAfter = 0;
  };

  const signal = (body: unknown) => {
    const s = get().seat;
    if (s) api("signal", { id: s.id, key: s.key, body }).catch(() => {});
  };

  const onPeerMessage = (raw: string) => {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    const g = get().game, seat = get().seat;
    if (!g || !seat) return;
    if (m.t === "move" && typeof m.uci === "string" && m.ply === g.ply && g.status === "playing") {
      // Check it here too: the server will refuse an illegal move anyway.
      const tree = get().toTree(g);
      if (!tree.play(m.uci)) return;
      const mover: Color = g.ply % 2 === 0 ? "white" : "black";
      if (mover === seat.color) return;
      const clocks = { ...shownClocks(g, get().receivedAt) };
      if (g.ply >= 1) clocks[mover] += g.increment * 1000;
      Sound.move();
      set({ game: { ...g, moves: [...g.moves, m.uci], ply: g.ply + 1, clocks, running: true, drawOffer: g.drawOffer === mover ? g.drawOffer : null }, receivedAt: Date.now() });
    } else if (m.t === "chat" && typeof m.text === "string") {
      const from: Color = seat.color === "white" ? "black" : "white";
      set({ chat: [...get().chat, { from, text: m.text.slice(0, 300) }].slice(-200) });
    } else if (m.t === "sync") {
      fetchGame();
    }
  };

  const wireChannel = (dc: RTCDataChannel) => {
    channel = dc;
    dc.onopen = () => { set({ link: "direct" }); schedule(); };
    dc.onclose = () => { if (channel === dc) { set({ link: "relay" }); schedule(); } };
    dc.onmessage = (e) => onPeerMessage(String(e.data));
  };

  /** White offers, Black answers; both trickle ICE candidates through the server. */
  const connectPeer = async () => {
    const seat = get().seat;
    if (!seat || typeof RTCPeerConnection === "undefined") return set({ link: "relay" });
    closePeer();
    set({ link: "connecting" });
    const pc = new RTCPeerConnection(ICE);
    peer = pc;
    pc.onicecandidate = (e) => e.candidate && signal({ ice: e.candidate.toJSON() });
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") { set({ link: "relay" }); schedule(); }
    };
    pc.ondatachannel = (e) => wireChannel(e.channel);
    if (seat.color === "white") {
      wireChannel(pc.createDataChannel("castle", { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      signal({ sdp: pc.localDescription });
    }
    signalPoll = setInterval(async () => {
      const s = get().seat;
      if (!s || peer !== pc) return;
      const r = await api<{ signals: { id: number; body: any }[] }>(`signal?id=${encodeURIComponent(s.id)}&key=${encodeURIComponent(s.key)}&after=${signalAfter}`).catch(() => undefined);
      for (const { id, body } of r?.signals ?? []) {
        signalAfter = Math.max(signalAfter, id);
        try {
          if (body.sdp) {
            await pc.setRemoteDescription(body.sdp);
            for (const c of pendingIce.splice(0)) await pc.addIceCandidate(c);
            if (body.sdp.type === "offer") {
              await pc.setLocalDescription(await pc.createAnswer());
              signal({ sdp: pc.localDescription });
            }
          } else if (body.ice) {
            if (pc.remoteDescription) await pc.addIceCandidate(body.ice);
            else pendingIce.push(body.ice);
          }
        } catch { /* a stale signal from an earlier attempt */ }
      }
      if (get().link === "direct") clearInterval(signalPoll);
    }, 1200);
    // No direct line within 15 seconds: play through the server.
    setTimeout(() => { if (peer === pc && get().link === "connecting") { set({ link: "relay" }); schedule(); } }, 15000);
  };

  const sit = (seat: Seat) => {
    closePeer();
    save("onlineSeat", seat);
    set({ seat, game: undefined, chat: [], link: "connecting" });
    api<GameView>(`game?id=${encodeURIComponent(seat.id)}`).then((v) => {
      set({ game: v, receivedAt: Date.now() });
      schedule();
    }).catch((e) => set({ error: e.message }));
    connectPeer();
  };

  return {
    name: load("onlineName", "") || randomName(),
    ready: false,
    open: [], live: [], recent: [], leaders: [], history: [],
    receivedAt: Date.now(),
    link: "none",
    chat: [],
    setName: (name) => { save("onlineName", name); set({ name }); },
    start: async () => {
      if (!load("onlineName", "")) save("onlineName", get().name);
      try {
        let t = token();
        let profile: Profile | undefined;
        if (t) {
          profile = await api<{ profile: Profile }>("me", { token: t }).then((r) => r.profile).catch((e) => {
            if (e.status === 401) return undefined;
            throw e;
          });
        }
        if (!profile) {
          if (t) set({ error: "Your saved rating could not be verified, so a new guest rating was started." });
          const r = await api<{ token: string; profile: Profile }>("guest", {});
          save("onlineToken", (t = r.token));
          profile = r.profile;
        }
        set({ profile, ready: true });
        // Back into a game that was going when Castle closed.
        const seat = load<Seat | null>("onlineSeat", null);
        if (seat && !get().seat) {
          const v = await api<GameView>(`game?id=${encodeURIComponent(seat.id)}`).catch(() => undefined);
          if (v && v.status !== "finished") sit(seat);
          else if (v) { set({ seat, game: v, receivedAt: Date.now() }); claim(v); }
        }
      } catch (e: any) {
        set({ error: `Castle Online is not reachable: ${e.message}`, ready: false });
      }
    },
    refreshLobby: async () => {
      try {
        const [lobby, board, mine] = await Promise.all([
          api<{ open: Seek[]; live: GameView[]; recent: GameView[] }>("lobby"),
          api<{ players: Leader[] }>("leaderboard"),
          get().profile ? api<{ games: GameView[] }>(`history?guest=${encodeURIComponent(get().profile!.id)}`) : Promise.resolve({ games: [] }),
        ]);
        set({ open: lobby.open.filter((s) => !(get().seat?.id === s.id)), live: lobby.live, recent: lobby.recent, leaders: board.players, history: mine.games, error: undefined });
      } catch (e: any) {
        set({ error: e.message });
      }
    },
    create: async (o) => {
      const seat = await api<Seat>("games", { token: token(), name: get().name, ...o });
      sit(seat);
    },
    join: async (code) => {
      const seat = await api<Seat>("join", { token: token(), name: get().name, code });
      sit(seat);
    },
    watch: (id) => {
      closePeer();
      set({ seat: undefined, game: undefined, link: "none", chat: [] });
      api<GameView>(`game?id=${encodeURIComponent(id)}`).then((v) => { set({ game: v, receivedAt: Date.now() }); schedule(); }).catch((e) => set({ error: e.message }));
    },
    leave: () => {
      clearInterval(poll);
      closePeer();
      save("onlineSeat", null);
      set({ seat: undefined, game: undefined, link: "none", chat: [] });
      get().refreshLobby();
    },
    move: (uci) => {
      const g = get().game, seat = get().seat;
      if (!g || !seat || g.status !== "playing") return;
      const mover: Color = g.ply % 2 === 0 ? "white" : "black";
      if (mover !== seat.color) return;
      const ply = g.ply;
      const clocks = { ...shownClocks(g, get().receivedAt) };
      if (ply >= 1) clocks[mover] += g.increment * 1000;
      Sound.move();
      set({ game: { ...g, moves: [...g.moves, uci], ply: ply + 1, clocks, running: true, drawOffer: g.drawOffer === mover ? g.drawOffer : null }, receivedAt: Date.now() });
      if (channel?.readyState === "open") channel.send(JSON.stringify({ t: "move", uci, ply }));
      api<GameView>("move", { id: seat.id, key: seat.key, uci, ply }).then(accept).catch((e) => { set({ error: e.message }); fetchGame(); });
    },
    act: async (action) => {
      const seat = get().seat;
      if (!seat) return;
      try {
        const r = await api<GameView & { rematchSeat?: Seat }>("action", { id: seat.id, key: seat.key, action, token: token(), name: get().name });
        if (action === "rematch" && r.rematchSeat) return sit(r.rematchSeat);
        accept(r);
        if (channel?.readyState === "open") channel.send(JSON.stringify({ t: "sync" }));
      } catch (e: any) {
        set({ error: e.message });
      }
    },
    say: (text) => {
      const seat = get().seat;
      const t = text.trim().slice(0, 300);
      if (!t || !seat || channel?.readyState !== "open") return;
      channel.send(JSON.stringify({ t: "chat", text: t }));
      set({ chat: [...get().chat, { from: seat.color, text: t }].slice(-200) });
    },
    toTree: (g = get().game) => {
      const tree = new GameTree(START_FEN);
      if (!g) return tree;
      tree.headers.set("Event", g.rated ? "Castle Online rated game" : "Castle Online casual game");
      tree.headers.set("Site", "Castle Online");
      tree.headers.set("White", g.white.name ?? "?");
      tree.headers.set("Black", g.black.name ?? "?");
      if (g.white.rating) tree.headers.set("WhiteElo", String(g.white.rating));
      if (g.black.rating) tree.headers.set("BlackElo", String(g.black.rating));
      tree.headers.set("TimeControl", `${Math.round(g.minutes * 60)}+${g.increment}`);
      if (g.result && g.result !== "aborted") tree.headers.set("Result", g.result);
      for (const uci of g.moves) {
        const pos = tryPosition(tree.fen);
        if (!pos || !moveFromUci(pos, uci) || !tree.play(uci)) break;
      }
      return tree;
    },
  };
});

/** Each side's time left right now, counting down the side to move. */
export function shownClocks(g: GameView, receivedAt: number): Record<Color, number> {
  const c = { ...g.clocks };
  if (g.status === "playing" && g.running) {
    const mover: Color = g.ply % 2 === 0 ? "white" : "black";
    c[mover] = Math.max(0, c[mover] - (Date.now() - receivedAt));
  }
  return c;
}
