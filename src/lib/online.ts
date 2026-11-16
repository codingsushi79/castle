import type { Rules } from "chessops/types";
import { parseSquare } from "chessops/util";
import { create } from "zustand";
import { Color, GameTree, moveFromUci, START_FEN, tryPosition, uciOf, variantName } from "./chess";
import { notify } from "./notify";
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

/** "chess960" is standard rules from a shuffled start; the rest are chessops rules. */
export type OnlineVariant = "chess" | "chess960" | Exclude<Rules, "chess">;
export const ONLINE_VARIANTS: { value: OnlineVariant; label: string }[] = [
  { value: "chess", label: "Standard" }, { value: "chess960", label: "Chess960" }, { value: "crazyhouse", label: "Crazyhouse" },
  { value: "atomic", label: "Atomic" }, { value: "kingofthehill", label: "King of the Hill" }, { value: "3check", label: "Three-check" },
  { value: "antichess", label: "Antichess" }, { value: "horde", label: "Horde" }, { value: "racingkings", label: "Racing Kings" },
];
export const variantLabel = (v?: OnlineVariant | null) => ONLINE_VARIANTS.find((x) => x.value === v)?.label ?? "Standard";
export const rulesOfVariant = (v?: OnlineVariant | null): Rules => (!v || v === "chess960" ? "chess" : v);

export interface Profile { id: string; rating: number; games: number; wins: number; losses: number; draws: number; peak: number }
export interface Side { name: string | null; rating: number | null; after: number | null; guest: string | null }
export interface GameView {
  id: string; code: string; status: "waiting" | "playing" | "finished"; rated: boolean; public: boolean;
  minutes: number; increment: number; white: Side; black: Side;
  variant?: OnlineVariant; fen?: string | null; arena?: string | null;
  /** Milliseconds since each player was last heard from (while playing). */
  away?: Record<Color, number | null>;
  moves: string[]; ply: number; clocks: Record<Color, number>; running: boolean;
  drawOffer: Color | null; result: string | null; reason: string | null; rematch: string | null; now: number;
}
export interface Seek { id: string; code: string; name: string; rating: number; color: string; minutes: number; increment: number; rated: boolean; variant?: OnlineVariant }
export interface Seat { id: string; code: string; color: Color; key: string }
export interface Leader { guest: string; name: string; rating: number; games: number }
export interface ChatLine { from: Color | "system"; text: string }
export interface QueueSpec { minutes: number; increment: number; rated: boolean; variant: OnlineVariant }
export interface Friend { id: string; name: string }
export interface Challenge { id: string; from: string; name: string; rating: number | null; minutes: number; increment: number; rated: boolean; variant: OnlineVariant }
export interface RoomLine { id: number; name: string; kind: "text" | "react"; text: string; at: number }
export interface OpenBattle { id: string; code: string; name: string; minutes: number }
export interface ArenaInfo {
  id: string; name: string; minutes: number; increment: number; variant: OnlineVariant;
  startsAt: number; endsAt: number; status: "upcoming" | "running" | "finished";
  players?: number; leader?: string | null; top?: number;
}
export interface ArenaPlayer { guest: string; name: string; rating: number | null; score: number; streak: number; games: number; playing: boolean; active: boolean }

export const REACTIONS = ["👏", "🔥", "😮", "😂", "♟️", "💀"];
/** How long a silent opponent is given before the game can be claimed (the server's rule). */
export const ABANDON_MS = 30_000;
export const ARENA_BREAK_MS = 6_000;

export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${ONLINE_API}/${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // WebKit says only "Load failed" for any network error; say something useful instead.
    throw Object.assign(new Error("Could not reach Castle Online. Check your internet connection and try again."), { status: 0 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error ?? (r.status === 404 ? "Castle Online is down for maintenance. Try again in a few minutes." : `The server answered ${r.status}.`)), { status: r.status });
  return data as T;
}

/** The saved rating token, for other parts of Castle that talk to the server. */
export const onlineToken = () => load<string>("onlineToken", "");

const sameSpec = (s: Seek, q: QueueSpec) => s.minutes === q.minutes && s.increment === q.increment && s.rated === q.rated && (s.variant ?? "chess") === q.variant;
/** Quick pairing starts within 150 points and widens by 50 every five seconds; after a minute, anyone. */
export const ratingWindow = (waitedMs: number) => (waitedMs >= 60_000 ? Infinity : 150 + 50 * Math.floor(waitedMs / 5000));

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
  battles: OpenBattle[];
  /** The game on screen: one being played (with a seat) or watched (without). */
  game?: GameView;
  seat?: Seat;
  /** When `game` arrived, by this computer's clock, for counting clocks down. */
  receivedAt: number;
  link: "none" | "connecting" | "direct" | "relay";
  /** The server has not answered for a while. */
  offline: boolean;
  /** When the game on screen ended, by this computer's clock. */
  endedAt?: number;
  chat: ChatLine[];
  /** The spectators' room for the game on screen, reactions included. */
  room: RoomLine[];
  /** Set while looking for an opponent with quick pairing. */
  queue?: QueueSpec;
  queuedAt?: number;
  premove?: [string, string];
  confirmMoves: boolean;
  autoReview: boolean;
  friends: Friend[];
  presence: Record<string, boolean>;
  incoming: Challenge[];
  /** A challenge this player sent and is waiting on. */
  challenging?: { id: string; name: string; game: string };
  arenas: ArenaInfo[];
  arena?: { info: ArenaInfo; players: ArenaPlayer[]; status: string; paused: boolean };
  setName: (name: string) => void;
  start: () => Promise<void>;
  /** Signs in quietly at launch (when this computer has played online before) so challenges arrive. */
  startBackground: () => void;
  refreshLobby: () => Promise<void>;
  create: (o: { minutes: number; increment: number; color: string; rated: boolean; public: boolean; variant: OnlineVariant }) => Promise<void>;
  join: (code: string) => Promise<void>;
  /** Joins someone waiting for the same game, or waits in the queue for one. */
  quickPair: (q: QueueSpec) => Promise<void>;
  leaveQueue: () => Promise<void>;
  watch: (id: string) => void;
  leave: () => void;
  move: (uci: string) => void;
  setPremove: (p?: [string, string]) => void;
  act: (action: "resign" | "abort" | "cancel" | "draw" | "decline" | "rematch" | "claim" | "claim-draw") => Promise<void>;
  say: (text: string) => void;
  sayToRoom: (text: string, kind?: "text" | "react") => Promise<void>;
  setOption: (o: Partial<Pick<State, "confirmMoves" | "autoReview">>) => void;
  addFriend: (f: Friend) => void;
  removeFriend: (id: string) => void;
  challenge: (friend: Friend, o: { minutes: number; increment: number; rated: boolean; variant: OnlineVariant; color: string }) => Promise<void>;
  answer: (c: Challenge, accept: boolean) => Promise<void>;
  refreshArenas: () => Promise<void>;
  joinArena: (id: string) => Promise<void>;
  pauseArena: () => Promise<void>;
  leaveArena: () => void;
  createArena: (o: { title: string; minutes: number; increment: number; variant: OnlineVariant; startsIn: number; duration: number }) => Promise<void>;
  toTree: (g?: GameView) => GameTree;
}

let poll: ReturnType<typeof setInterval> | undefined;
let queueTimer: ReturnType<typeof setInterval> | undefined;
let signalPoll: ReturnType<typeof setInterval> | undefined;
let roomPoll: ReturnType<typeof setInterval> | undefined;
let inboxPoll: ReturnType<typeof setInterval> | undefined;
let arenaPoll: ReturnType<typeof setInterval> | undefined;
let peer: RTCPeerConnection | undefined;
let channel: RTCDataChannel | undefined;
let signalAfter = 0;
let roomAfter = 0;
let roomGame = "";
let misses = 0;
let pendingIce: RTCIceCandidateInit[] = [];
const claimed = new Set<string>(load<string[]>("onlineClaimed", []));
const announced = new Set<string>();

export const useOnline = create<State>((set, get) => {
  const token = onlineToken;
  const myTurn = (g: GameView, seat?: Seat) => !!seat && g.status === "playing" && (g.ply % 2 === 0 ? "white" : "black") === seat.color;

  /** Plays a queued premove as soon as it is this side's turn, if it is still legal. */
  const tryPremove = () => {
    const { premove, game: g, seat } = get();
    if (!premove || !g || !myTurn(g, seat)) return;
    set({ premove: undefined });
    const tree = get().toTree(g);
    const pos = tryPosition(tree.fen, tree.rules);
    if (!pos) return;
    const [from, to] = premove;
    const sq = parseSquare(from);
    const piece = sq === undefined ? undefined : pos.board.get(sq);
    const lastRank = to[1] === (pos.turn === "white" ? "8" : "1");
    const m = moveFromUci(pos, from + to + (piece?.role === "pawn" && lastRank ? "q" : ""));
    if (m) get().move(uciOf(pos, m, tree.chess960));
  };

  /** Takes a server view unless it is behind moves this side already knows. */
  const accept = (v: GameView) => {
    const g = get().game;
    if (g && g.id === v.id && v.status === "playing" && v.ply < g.ply) {
      if (v.drawOffer !== g.drawOffer || v.away) set({ game: { ...g, drawOffer: v.drawOffer, away: v.away } });
      return;
    }
    const before = g && g.id === v.id ? g : undefined;
    if (before && v.ply > before.ply) Sound.move();
    if (before && before.status !== "finished" && v.status === "finished") {
      Sound.end();
      set({ endedAt: Date.now() });
      set({ chat: [...get().chat, { from: "system", text: `Game over: ${v.result === "aborted" ? "aborted" : `${v.result}, ${v.reason}`}.` }] });
    }
    if (before && v.drawOffer && v.drawOffer !== before.drawOffer && v.drawOffer !== get().seat?.color) {
      set({ chat: [...get().chat, { from: "system", text: `${v.drawOffer === "white" ? "White" : "Black"} offers a draw.` }] });
    }
    if (before?.status === "waiting" && v.status === "playing" && get().seat) {
      Sound.end();
      notify("Your game has started", `${v.white.name} vs ${v.black.name}`);
      if (get().challenging?.game === v.id) set({ challenging: undefined });
    }
    set({ game: v, receivedAt: Date.now() });
    if (v.status === "finished") claim(v);
    tryPremove();
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
    const g = get().game, seat = get().seat;
    if (!g) return;
    const key = seat?.id === g.id ? `&key=${encodeURIComponent(seat.key)}` : "";
    try {
      accept(await api<GameView>(`game?id=${encodeURIComponent(g.id)}${key}`));
      misses = 0;
      if (get().offline) set({ offline: false });
    } catch {
      if (++misses >= 3 && !get().offline) set({ offline: true });
    }
  };

  const schedule = () => {
    clearInterval(poll);
    // Even over a direct link the server hears from us every few seconds, so it knows we are still here.
    const fast = get().link !== "direct" || get().game?.status === "waiting";
    poll = setInterval(() => {
      fetchGame();
      const g = get().game;
      if (g?.status === "finished" && g.rematch && get().seat) clearInterval(poll);
    }, fast ? 1000 : 3000);
    watchRoom();
  };

  /** The spectators' room: chat lines and reactions for the game on screen. */
  const watchRoom = () => {
    const g = get().game;
    if (!g || (roomPoll && roomGame === g.id)) return;
    roomGame = g.id;
    clearInterval(roomPoll);
    roomAfter = 0;
    set({ room: [] });
    const tick = async () => {
      const id = get().game?.id;
      if (!id) return clearInterval(roomPoll);
      const r = await api<{ lines: RoomLine[] }>(`chat?id=${encodeURIComponent(id)}&after=${roomAfter}`).catch(() => undefined);
      if (!r?.lines.length || get().game?.id !== id) return;
      roomAfter = r.lines[r.lines.length - 1].id;
      set({ room: [...get().room, ...r.lines].slice(-200) });
    };
    tick();
    roomPoll = setInterval(tick, 2500);
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
      tryPremove();
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
    set({ seat, game: undefined, chat: [], room: [], link: "connecting", premove: undefined });
    api<GameView>(`game?id=${encodeURIComponent(seat.id)}&key=${encodeURIComponent(seat.key)}`).then((v) => {
      set({ game: v, receivedAt: Date.now() });
      schedule();
    }).catch((e) => set({ error: e.message }));
    connectPeer();
  };

  /** Tries each waiting player in turn; true once seated. */
  const joinAny = async (seeks: Seek[]) => {
    for (const s of seeks) {
      try {
        const seat = await api<Seat>("join", { token: token(), name: get().name, code: s.code });
        sit(seat);
        return true;
      } catch { /* taken, or our own seek from another window */ }
    }
    return false;
  };

  const near = (s: Seek, waited: number) => !get().profile || Math.abs(s.rating - get().profile!.rating) <= ratingWindow(waited);

  /**
   * While our seek waits, watch the lobby. If two players queue at once, each
   * sees the other's seek; the one whose game id sorts later steps across.
   * The rating window widens the longer we wait.
   */
  const watchQueue = () => {
    clearInterval(queueTimer);
    queueTimer = setInterval(async () => {
      const q = get().queue, seat = get().seat, g = get().game;
      if (!q || !seat) return clearInterval(queueTimer);
      if (g && g.id === seat.id && g.status !== "waiting") {
        set({ queue: undefined });
        return clearInterval(queueTimer);
      }
      const waited = Date.now() - (get().queuedAt ?? Date.now());
      const lobby = await api<{ open: Seek[] }>("lobby").catch(() => undefined);
      const earlier = lobby?.open.filter((s) => s.id !== seat.id && s.id < seat.id && sameSpec(s, q) && near(s, waited)) ?? [];
      if (!earlier.length) return;
      const mine = await api<GameView>("action", { id: seat.id, key: seat.key, action: "cancel" }).catch(() => undefined);
      if (!mine || mine.status !== "finished") return; // Someone joined us meanwhile.
      if (await joinAny(earlier)) { set({ queue: undefined }); return clearInterval(queueTimer); }
      // Missed them: wait again with a fresh seek.
      const again = await api<Seat>("games", { token: token(), name: get().name, ...q, color: "random", public: true }).catch(() => undefined);
      if (again) sit(again);
      else { set({ queue: undefined, error: "Could not stay in the queue. Try again." }); clearInterval(queueTimer); }
    }, 2500);
  };

  /** Challenges, and friends' presence, every few seconds while Castle is open. */
  const watchInbox = () => {
    clearInterval(inboxPoll);
    let ticks = 0;
    const tick = async () => {
      if (!get().ready) return;
      const r = await api<{ incoming: Challenge[]; outgoing: { id: string; status: string; game: string }[] }>("inbox", { token: token(), name: get().name }).catch(() => undefined);
      if (r) {
        for (const c of r.incoming) {
          if (announced.has(c.id)) continue;
          announced.add(c.id);
          Sound.end();
          notify("Challenge", `${c.name} challenges you: ${tc(c.minutes, c.increment)} ${variantLabel(c.variant)}${c.rated ? ", rated" : ""}.`, true);
        }
        set({ incoming: r.incoming });
        const mine = get().challenging;
        const outcome = mine && r.outgoing.find((o) => o.id === mine.id);
        if (mine && outcome?.status === "declined") {
          set({ challenging: undefined });
          if (get().game?.id === mine.game) get().leave();
          set({ error: `${mine.name} declined your challenge.` });
        }
      }
      if (ticks++ % 3 === 0 && get().friends.length) {
        const p = await api<{ players: { id: string; name: string | null; online: boolean }[] }>("presence", { ids: get().friends.map((f) => f.id) }).catch(() => undefined);
        if (p) set({ presence: Object.fromEntries(p.players.map((x) => [x.id, x.online])) });
      }
    };
    tick();
    inboxPoll = setInterval(tick, 5000);
  };

  /** In an arena: ask for a pairing every two seconds while not in a game, and keep the standings fresh. */
  const watchArena = () => {
    clearInterval(arenaPoll);
    let ticks = 0;
    const tick = async () => {
      const a = get().arena;
      if (!a) return clearInterval(arenaPoll);
      const g = get().game, seat = get().seat;
      // Give the player a few seconds with the result before the next pairing.
      const busy = g && seat && g.id === seat.id && (g.status !== "finished" || Date.now() - (get().endedAt ?? 0) < ARENA_BREAK_MS);
      if (!busy && !a.paused) {
        const r = await api<{ status: string; seat?: Seat }>("arena/pair", { token: token(), id: a.info.id }).catch(() => undefined);
        if (r && get().arena?.info.id === a.info.id) {
          set({ arena: { ...get().arena!, status: r.status } });
          if (r.seat && r.seat.id !== get().seat?.id) {
            Sound.end();
            notify("Arena game", "Your next arena game has started.");
            sit(r.seat);
          }
        }
      }
      if (ticks++ % 3 === 0) {
        const s = await api<{ arena: ArenaInfo; players: ArenaPlayer[] }>(`arena?id=${encodeURIComponent(a.info.id)}`).catch(() => undefined);
        if (s && get().arena?.info.id === a.info.id) set({ arena: { ...get().arena!, info: s.arena, players: s.players } });
      }
    };
    tick();
    arenaPoll = setInterval(tick, 2000);
  };

  return {
    name: load("onlineName", "") || randomName(),
    ready: false,
    open: [], live: [], recent: [], leaders: [], history: [], battles: [],
    receivedAt: Date.now(),
    link: "none",
    offline: false,
    chat: [],
    room: [],
    confirmMoves: load("onlineConfirmMoves", false),
    autoReview: load("onlineAutoReview", true),
    friends: load<Friend[]>("onlineFriends", []),
    presence: {},
    incoming: [],
    arenas: [],
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
        set({ profile, ready: true, error: undefined });
        watchInbox();
        const arena = load<string | null>("onlineArena", null);
        if (arena && !get().arena) get().joinArena(arena).catch(() => save("onlineArena", null));
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
    startBackground: () => {
      if (token() && !get().ready) get().start().then(() => { if (get().error?.startsWith("Castle Online is not reachable")) set({ error: undefined }); });
    },
    refreshLobby: async () => {
      try {
        const [lobby, board, mine] = await Promise.all([
          api<{ open: Seek[]; live: GameView[]; recent: GameView[]; battles?: OpenBattle[] }>("lobby"),
          api<{ players: Leader[] }>("leaderboard"),
          get().profile ? api<{ games: GameView[] }>(`history?guest=${encodeURIComponent(get().profile!.id)}`) : Promise.resolve({ games: [] }),
        ]);
        // Clears only a connection error: other messages stay until dismissed.
        const error = get().error;
        set({ open: lobby.open.filter((s) => !(get().seat?.id === s.id)), live: lobby.live, recent: lobby.recent, battles: lobby.battles ?? [], leaders: board.players, history: mine.games, error: error && /reach|maintenance|server answered/i.test(error) ? undefined : error });
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
    quickPair: async (q) => {
      set({ error: undefined });
      const lobby = await api<{ open: Seek[] }>("lobby");
      if (await joinAny(lobby.open.filter((s) => sameSpec(s, q) && near(s, 0)))) return;
      const seat = await api<Seat>("games", { token: token(), name: get().name, ...q, color: "random", public: true });
      set({ queue: q, queuedAt: Date.now() });
      sit(seat);
      watchQueue();
    },
    leaveQueue: async () => {
      clearInterval(queueTimer);
      const seat = get().seat;
      set({ queue: undefined });
      if (seat && get().game?.status === "waiting") {
        const v = await api<GameView>("action", { id: seat.id, key: seat.key, action: "cancel" }).catch(() => undefined);
        if (v && v.status !== "finished") return accept(v); // Matched just as we left: play it.
      }
      get().leave();
    },
    watch: (id) => {
      closePeer();
      set({ seat: undefined, game: undefined, link: "none", chat: [], room: [] });
      api<GameView>(`game?id=${encodeURIComponent(id)}`).then((v) => { set({ game: v, receivedAt: Date.now() }); schedule(); }).catch((e) => set({ error: e.message }));
    },
    leave: () => {
      clearInterval(poll);
      clearInterval(queueTimer);
      clearInterval(roomPoll);
      roomPoll = undefined;
      closePeer();
      save("onlineSeat", null);
      set({ seat: undefined, game: undefined, link: "none", chat: [], room: [], queue: undefined, premove: undefined, offline: false });
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
    setPremove: (premove) => set({ premove }),
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
    sayToRoom: async (text, kind = "text") => {
      const g = get().game;
      const t = text.trim();
      if (!g || !t) return;
      try {
        await api("chat", { id: g.id, name: get().name, text: t, kind });
      } catch (e: any) {
        set({ error: e.message });
      }
    },
    setOption: (o) => {
      if (o.confirmMoves !== undefined) save("onlineConfirmMoves", o.confirmMoves);
      if (o.autoReview !== undefined) save("onlineAutoReview", o.autoReview);
      set(o);
    },
    addFriend: (f) => {
      if (f.id === get().profile?.id || get().friends.some((x) => x.id === f.id)) return;
      const friends = [...get().friends, f];
      save("onlineFriends", friends);
      set({ friends });
      api<{ players: { id: string; online: boolean }[] }>("presence", { ids: [f.id] }).then((p) => set({ presence: { ...get().presence, ...Object.fromEntries(p.players.map((x) => [x.id, x.online])) } })).catch(() => {});
    },
    removeFriend: (id) => {
      const friends = get().friends.filter((f) => f.id !== id);
      save("onlineFriends", friends);
      set({ friends });
    },
    challenge: async (friend, o) => {
      const r = await api<Seat & { challenge: string }>("challenge", { token: token(), name: get().name, to: friend.id, ...o });
      set({ challenging: { id: r.challenge, name: friend.name, game: r.id } });
      sit(r);
    },
    answer: async (c, accept) => {
      set({ incoming: get().incoming.filter((x) => x.id !== c.id) });
      try {
        const r = await api<Seat & { ok?: boolean }>("answer", { token: token(), name: get().name, id: c.id, accept });
        if (accept && r.key) {
          if (get().game && get().seat && get().game!.status !== "finished") return set({ error: "Finish your current game first." });
          sit(r);
        }
      } catch (e: any) {
        set({ error: e.message });
      }
    },
    refreshArenas: async () => {
      const r = await api<{ arenas: ArenaInfo[] }>("arenas").catch(() => undefined);
      if (r) set({ arenas: r.arenas });
    },
    joinArena: async (id) => {
      await api("arena/join", { token: token(), name: get().name, id });
      const info = get().arenas.find((a) => a.id === id) ?? (await api<{ arena: ArenaInfo }>(`arena?id=${encodeURIComponent(id)}`)).arena;
      set({ arena: { info, players: get().arena?.info.id === id ? get().arena!.players : [], status: "waiting", paused: false } });
      save("onlineArena", id);
      watchArena();
    },
    pauseArena: async () => {
      const a = get().arena;
      if (!a) return;
      if (a.paused) return get().joinArena(a.info.id);
      set({ arena: { ...a, paused: true, status: "paused" } });
      await api("arena/leave", { token: token(), id: a.info.id }).catch(() => {});
    },
    leaveArena: () => {
      const a = get().arena;
      clearInterval(arenaPoll);
      save("onlineArena", null);
      set({ arena: undefined });
      if (a) api("arena/leave", { token: token(), id: a.info.id }).catch(() => {});
    },
    createArena: async (o) => {
      const r = await api<{ id: string }>("arena/create", { token: token(), name: get().name, ...o });
      await get().refreshArenas();
      await get().joinArena(r.id);
    },
    toTree: (g = get().game) => {
      if (!g) return new GameTree(START_FEN);
      const rules = rulesOfVariant(g.variant);
      const tree = new GameTree(g.fen ?? (rules === "chess" ? START_FEN : GameTree.variantStart(rules).fen), rules, g.variant === "chess960");
      tree.headers.set("Event", g.arena ? "Castle Online arena game" : g.rated ? "Castle Online rated game" : "Castle Online casual game");
      tree.headers.set("Site", "Castle Online");
      tree.headers.set("White", g.white.name ?? "?");
      tree.headers.set("Black", g.black.name ?? "?");
      if (g.white.rating) tree.headers.set("WhiteElo", String(g.white.rating));
      if (g.black.rating) tree.headers.set("BlackElo", String(g.black.rating));
      tree.headers.set("TimeControl", `${Math.round(g.minutes * 60)}+${g.increment}`);
      if (g.variant && g.variant !== "chess") tree.headers.set("Variant", variantName(rules, g.variant === "chess960"));
      if (g.result && g.result !== "aborted") tree.headers.set("Result", g.result);
      for (const uci of g.moves) {
        const pos = tryPosition(tree.fen, rules);
        if (!pos || !moveFromUci(pos, uci) || !tree.play(uci)) break;
      }
      return tree;
    },
  };
});

export const tc = (minutes: number, increment: number) => `${minutes < 1 ? minutes.toFixed(1) : minutes}+${increment}`;

/** Each side's time left right now, counting down the side to move. */
export function shownClocks(g: GameView, receivedAt: number): Record<Color, number> {
  const c = { ...g.clocks };
  if (g.status === "playing" && g.running) {
    const mover: Color = g.ply % 2 === 0 ? "white" : "black";
    c[mover] = Math.max(0, c[mover] - (Date.now() - receivedAt));
  }
  return c;
}
