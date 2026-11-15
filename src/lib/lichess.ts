import type { Move } from "chessops/types";
import { create } from "zustand";
import { Color, GameTree, moveFromUci, Score, START_FEN, uciOf } from "./chess";
import { db, ExplorerMove } from "./db";
import { notify } from "./notify";
import { logActivity } from "./activity";
import { Sound } from "./sound";
import { call, load, save } from "./storage";

let token: string | undefined;
let tokenLoaded = false;

export async function lichessToken(): Promise<string | undefined> {
  if (!tokenLoaded) {
    token = (await call<string | null>("secret_get", { key: "lichessToken" }).catch(() => null)) ?? undefined;
    tokenLoaded = true;
  }
  return token;
}

export class HttpError extends Error {
  constructor(public status: number) {
    super(status === 401 ? "Not authorised. Check your Lichess token." : status === 404 ? "Not found." : status === 429 ? "Too many requests. Try again in a minute." : `The server answered with status ${status}.`);
  }
}

export async function api(url: string, init: { method?: string; auth?: boolean; form?: Record<string, string>; accept?: string; signal?: AbortSignal } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.auth !== false) {
    const t = await lichessToken();
    if (t && /lichess\.(org|ovh)/.test(url)) headers.Authorization = `Bearer ${t}`;
  }
  if (init.accept) headers.Accept = init.accept;
  const body = init.form ? new URLSearchParams(init.form) : undefined;
  const r = await fetch(url, { method: init.method ?? "GET", headers, body, signal: init.signal });
  if (!r.ok) throw new HttpError(r.status);
  return r;
}

export const getJson = <T = any>(url: string, init?: Parameters<typeof api>[1]) => api(url, init).then((r) => r.json() as Promise<T>);

/** Reads a newline-delimited JSON stream until it ends or the signal aborts. */
export async function ndjson(url: string, onLine: (obj: any) => void, init: Parameters<typeof api>[1] = {}): Promise<void> {
  const r = await api(url, { ...init, accept: "application/x-ndjson" });
  const reader = r.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
}

// MARK: Explorer, tablebase, cloud evaluation

const memo = new Map<string, unknown>();
async function cachedJson<T>(url: string, auth = true): Promise<T> {
  if (memo.has(url)) return memo.get(url) as T;
  const v = await getJson<T>(url, { auth });
  if (memo.size > 800) memo.clear();
  memo.set(url, v);
  return v;
}

export type ExplorerSource = "library" | "lichess" | "masters";

export async function explorer(source: ExplorerSource, fen: string, player?: string, color?: string): Promise<ExplorerMove[]> {
  if (source === "library") return db.explorer(fen, player, color);
  const q = new URLSearchParams({ fen, topGames: "0", recentGames: "0", moves: "14" });
  if (source === "lichess") {
    q.set("speeds", "blitz,rapid,classical");
    q.set("ratings", "1600,1800,2000,2200,2500");
  }
  const data = await cachedJson<any>(`https://explorer.lichess.ovh/${source}?${q}`);
  return (data.moves ?? []).map((m: any) => ({ san: m.san, white: m.white, draws: m.draws, black: m.black, rating: m.averageRating }));
}

/** What one Lichess player has played from a position. */
export async function playerExplorer(player: string, color: Color, fen: string): Promise<ExplorerMove[]> {
  const q = new URLSearchParams({ player, color, fen, recentGames: "0", moves: "14" });
  let last: any;
  await ndjson(`https://explorer.lichess.ovh/player?${q}`, (o) => (last = o));
  return (last?.moves ?? []).map((m: any) => ({ san: m.san, white: m.white, draws: m.draws, black: m.black, rating: m.averageOpponentRating }));
}

export interface TablebaseMove {
  san: string;
  uci: string;
  verdict: string;
  dtz?: number;
  dtm?: number;
}
export interface Tablebase {
  verdict: string;
  dtz?: number;
  dtm?: number;
  moves: TablebaseMove[];
}

const flip: Record<string, string> = { win: "loss", loss: "win", "cursed-win": "blessed-loss", "blessed-loss": "cursed-win", "maybe-win": "maybe-loss", "maybe-loss": "maybe-win" };
export const verdictText = (v: string) =>
  ({ win: "Win", loss: "Loss", draw: "Draw", "cursed-win": "Win, but drawn by the 50-move rule", "blessed-loss": "Loss, saved by the 50-move rule", "maybe-win": "Probably a win", "maybe-loss": "Probably a loss" })[v] ?? "Unknown";

/** Perfect-play results for positions with seven pieces or fewer. */
export async function tablebase(fen: string, variant = "standard"): Promise<Tablebase> {
  const data = await cachedJson<any>(`https://tablebase.lichess.ovh/${variant}?fen=${encodeURIComponent(fen)}`, false);
  return {
    verdict: data.category ?? "unknown",
    dtz: data.dtz ?? undefined,
    dtm: data.dtm ?? undefined,
    moves: (data.moves ?? []).map((m: any) => ({ san: m.san, uci: m.uci, verdict: flip[m.category] ?? m.category, dtz: m.dtz == null ? undefined : -m.dtz, dtm: m.dtm == null ? undefined : -m.dtm })),
  };
}

export interface CloudEval {
  depth: number;
  knodes: number;
  pvs: { score: Score; moves: string[] }[];
}

/** Lichess's stored deep evaluation of a position, when it has one. */
export async function cloudEval(fen: string, multiPv = 3): Promise<CloudEval | undefined> {
  try {
    const data = await cachedJson<any>(`https://lichess.org/api/cloud-eval?fen=${encodeURIComponent(fen)}&multiPv=${multiPv}`, false);
    return { depth: data.depth, knodes: data.knodes, pvs: data.pvs.map((p: any) => ({ score: p.mate !== undefined ? { mate: p.mate } : { cp: p.cp }, moves: String(p.moves).split(" ") })) };
  } catch {
    return undefined;
  }
}

// MARK: Studies

/** The study id from a link such as https://lichess.org/study/AbCdEfGh/IjKlMnOp, or the bare id. */
export const studyIdOf = (text: string) => text.trim().match(/study\/([A-Za-z0-9]{8})/)?.[1] ?? (/^[A-Za-z0-9]{8}$/.test(text.trim()) ? text.trim() : undefined);

/** Every chapter of a study, as PGN. Private studies need a token with study:read. */
export async function studyPgn(idOrUrl: string): Promise<string> {
  const id = studyIdOf(idOrUrl);
  if (!id) throw new Error("That is not a Lichess study link.");
  return api(`https://lichess.org/api/study/${id}.pgn?comments=true&variations=true&clocks=true&orientation=true`, { accept: "application/x-chess-pgn" }).then((r) => r.text());
}

export async function myStudies(username: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  await ndjson(`https://lichess.org/api/study/by/${username}`, (o) => out.push({ id: o.id, name: o.name }));
  return out;
}

/** Adds a game as new chapters of an existing study. Needs study:write. */
export async function addToStudy(studyId: string, pgn: string, name: string) {
  await api(`https://lichess.org/api/study/${studyId}/import-pgn`, { method: "POST", form: { pgn, name } });
}

// MARK: Tournaments

export interface Arena {
  id: string;
  name: string;
  speed: string;
  variant: string;
  minutes: number;
  increment: number;
  rated: boolean;
  starts: number;
  finishes: number;
  players: number;
  status: "created" | "started" | "finished";
}

const arenaOf = (t: any, status: Arena["status"]): Arena => ({
  id: t.id, name: t.fullName ?? t.name, speed: t.perf?.name ?? t.speed ?? "", variant: t.variant?.name ?? t.variant?.key ?? "Standard",
  minutes: (t.clock?.limit ?? 0) / 60, increment: t.clock?.increment ?? 0, rated: !!t.rated, starts: t.startsAt, finishes: t.finishesAt,
  players: t.nbPlayers ?? 0, status,
});

export async function arenas(): Promise<Arena[]> {
  const d = await getJson("https://lichess.org/api/tournament", { auth: false });
  return [...(d.started ?? []).map((t: any) => arenaOf(t, "started")), ...(d.created ?? []).map((t: any) => arenaOf(t, "created"))];
}

export interface ArenaStanding {
  rank: number;
  name: string;
  rating: number;
  score: number;
  fire: boolean;
}

export async function arenaStandings(id: string): Promise<{ arena: Arena; standings: ArenaStanding[]; me?: { rank: number; score: number } }> {
  const d = await getJson(`https://lichess.org/api/tournament/${id}`);
  return {
    arena: arenaOf(d, d.isFinished ? "finished" : d.isStarted ? "started" : "created"),
    standings: (d.standing?.players ?? []).map((p: any) => ({ rank: p.rank, name: p.name, rating: p.rating, score: p.score, fire: !!p.sheet?.fire })),
    me: d.me ? { rank: d.me.rank, score: d.me.score ?? 0 } : undefined,
  };
}

export const joinArena = (id: string) => api(`https://lichess.org/api/tournament/${id}/join`, { method: "POST" });
export const withdrawArena = (id: string) => api(`https://lichess.org/api/tournament/${id}/withdraw`, { method: "POST" });

export interface Challenge {
  id: string;
  from: string;
  to: string;
  speed: string;
  variant: string;
  rated: boolean;
  timeControl: string;
  color: string;
}

const challengeOf = (c: any): Challenge => ({
  id: c.id, from: c.challenger?.name ?? c.challenger?.id ?? "?", to: c.destUser?.name ?? c.destUser?.id ?? "open",
  speed: c.speed ?? "", variant: c.variant?.name ?? "Standard", rated: !!c.rated, color: c.color ?? "random",
  timeControl: c.timeControl?.type === "clock" ? `${c.timeControl.limit / 60}+${c.timeControl.increment}` : c.timeControl?.type === "correspondence" ? `${c.timeControl.daysPerTurn} days` : "unlimited",
});

// MARK: Playing

interface PlayState {
  state: "signedOut" | "connecting" | "online";
  username: string;
  userId: string;
  ratings: { name: string; rating: number; games: number }[];
  error?: string;
  seeking: boolean;
  gameId?: string;
  tree: GameTree;
  myColor: Color;
  names: Record<Color, string>;
  clocks: Record<Color, number>;
  hasClock: boolean;
  correspondence: boolean;
  playing: boolean;
  result?: string;
  premove?: [string, string];
  pending?: Move;
  confirm: boolean;
  /** Games in progress, for the correspondence list. */
  ongoing: { id: string; opponent: string; myTurn: boolean; fen: string; color: Color; speed: string; secondsLeft?: number }[];
  incoming: Challenge[];
  outgoing: Challenge[];
  challenge: (username: string, opts: { minutes?: number; increment?: number; days?: number; rated: boolean; color: string; variant: string }) => Promise<void>;
  answer: (id: string, accept: boolean) => void;
  cancelChallenge: (id: string) => void;
  signIn: (token: string) => Promise<void>;
  signOut: () => void;
  connect: () => Promise<void>;
  refreshOngoing: () => Promise<void>;
  open: (id: string) => void;
  play: (move: Move) => void;
  confirmPending: () => void;
  cancelPending: () => void;
  setPremove: (p?: [string, string]) => void;
  setConfirm: (v: boolean) => void;
  seek: (opts: { minutes?: number; increment?: number; days?: number; rated: boolean; variant?: string }) => void;
  cancelSeek: () => void;
  challengeComputer: (level: number, minutes: number, increment: number, variant?: string) => void;
  resign: () => void;
  abort: () => void;
  offerDraw: () => void;
}

let events: AbortController | undefined;
let gameStream: AbortController | undefined;
let seekStream: AbortController | undefined;
let lastTick = Date.now();
let pollTimer: ReturnType<typeof setInterval> | undefined;

export const useLichess = create<PlayState>((set, get) => {
  const post = (path: string, form?: Record<string, string>) =>
    api(`https://lichess.org/api/${path}`, { method: "POST", form }).catch((e) => set({ error: String(e.message ?? e) }));

  const playerName = (p: any) => (!p ? "?" : p.aiLevel ? `Stockfish level ${p.aiLevel}` : `${p.name ?? "Anonymous"}${p.rating ? ` (${p.rating})` : ""}`);

  const sendMove = (move: Move) => {
    const s = get();
    if (!s.gameId) return;
    const tree = s.tree;
    const uci = uciOf(tree.pos, move, false);
    const node = tree.play(move);
    if (!node) return;
    Sound.forSan(node.san);
    api(`https://lichess.org/api/board/game/${s.gameId}/move/${uci}`, { method: "POST" }).catch((e) => {
      set({ error: `Lichess rejected the move: ${e.message}` });
      if (tree.last === node) tree.delete(node);
    });
  };

  const applyState = (st: any) => {
    const s = get();
    let tree = s.tree;
    const moves: string[] = String(st.moves ?? "").split(" ").filter(Boolean);
    tree.toEnd();
    if (moves.length < tree.mainline.length) {
      const fresh = new GameTree(tree.root.fen, tree.rules, tree.chess960);
      fresh.headers = new Map(tree.headers);
      tree = fresh;
    }
    for (const uci of moves.slice(tree.mainline.length)) {
      const node = tree.play(uci);
      if (!node) break;
      Sound.forSan(node.san);
    }
    lastTick = Date.now();
    set({ tree, clocks: { white: (st.wtime ?? 0) / 1000, black: (st.btime ?? 0) / 1000 }, pending: undefined });
    const status: string = st.status ?? "started";
    if (status !== "started" && status !== "created") {
      if (!s.playing) return;
      const result = st.winner === "white" ? "1-0" : st.winner === "black" ? "0-1" : status === "aborted" ? "*" : "1/2-1/2";
      const reasons: Record<string, string> = { mate: "Checkmate", resign: "Resignation", outoftime: "Time out", draw: "Draw", stalemate: "Stalemate", aborted: "Game aborted", timeout: "Opponent left", variantEnd: "Variant win" };
      tree.headers.set("Termination", reasons[status] ?? status);
      tree.result = result;
      set({ playing: false, premove: undefined, result: `${reasons[status] ?? status} · ${result}` });
      Sound.end();
      logActivity("game", st.winner ? st.winner === s.myColor : undefined);
      notify("Lichess game over", `${s.names.white} – ${s.names.black}: ${result}`);
      db.saveGame(tree, "Lichess");
      get().refreshOngoing();
      return;
    }
    const pre = get().premove;
    if (pre && tree.current.turn === s.myColor) {
      set({ premove: undefined });
      const m = moveFromUci(tree.pos, pre[0] + pre[1]) ?? moveFromUci(tree.pos, pre[0] + pre[1] + "q");
      if (m) sendMove(m);
    }
  };

  const handleGame = (o: any) => {
    if (o.type === "gameFull") {
      const variant = o.variant?.key ?? "standard";
      const rules = ({ standard: "chess", chess960: "chess", fromPosition: "chess", crazyhouse: "crazyhouse", atomic: "atomic", kingOfTheHill: "kingofthehill", threeCheck: "3check", antichess: "antichess", horde: "horde", racingKings: "racingkings" } as const)[variant as "standard"] ?? "chess";
      const fen = o.initialFen && o.initialFen !== "startpos" ? o.initialFen : rules === "chess" ? START_FEN : GameTree.variantStart(rules).root.fen;
      const tree = new GameTree(fen, rules, variant === "chess960");
      const names = { white: playerName(o.white), black: playerName(o.black) };
      tree.headers.set("Event", "Lichess game");
      tree.headers.set("Site", `https://lichess.org/${get().gameId ?? ""}`);
      const plain = (p: any) => (!p ? "?" : p.aiLevel ? `Stockfish level ${p.aiLevel}` : p.name ?? "Anonymous");
      tree.headers.set("White", plain(o.white));
      tree.headers.set("Black", plain(o.black));
      if (o.white?.rating) tree.headers.set("WhiteElo", String(o.white.rating));
      if (o.black?.rating) tree.headers.set("BlackElo", String(o.black.rating));
      set({ tree, names, myColor: o.black?.id === get().userId ? "black" : "white", hasClock: !!o.clock, correspondence: o.speed === "correspondence", playing: true, result: undefined });
      if (o.state) applyState(o.state);
    } else if (o.type === "gameState") applyState(o);
  };

  setInterval(() => {
    const s = get();
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (!s.playing || !s.hasClock || s.tree.mainline.length < 2) return;
    const mover = s.tree.last.turn;
    set({ clocks: { ...s.clocks, [mover]: Math.max(0, s.clocks[mover] - dt) } });
  }, 100);

  return {
    state: "signedOut",
    username: "",
    userId: "",
    ratings: [],
    seeking: false,
    tree: new GameTree(),
    myColor: "white",
    names: { white: "White", black: "Black" },
    clocks: { white: 0, black: 0 },
    hasClock: false,
    correspondence: false,
    playing: false,
    confirm: load("lichessConfirm", false),
    ongoing: [],
    incoming: [],
    outgoing: [],

    signIn: async (t) => {
      const value = t.trim();
      if (!value) return;
      await call("secret_set", { key: "lichessToken", value }).catch(() => {});
      token = value;
      tokenLoaded = true;
      await get().connect();
    },
    signOut: () => {
      events?.abort();
      gameStream?.abort();
      seekStream?.abort();
      call("secret_set", { key: "lichessToken", value: null }).catch(() => {});
      token = undefined;
      set({ state: "signedOut", username: "", ratings: [], seeking: false, playing: false, ongoing: [] });
    },
    connect: async () => {
      if (get().state !== "signedOut" || !(await lichessToken())) return;
      set({ state: "connecting", error: undefined });
      try {
        const me = await getJson("https://lichess.org/api/account");
        const perfs = me.perfs ?? {};
        set({
          state: "online",
          userId: me.id,
          username: me.username ?? me.id,
          ratings: ["bullet", "blitz", "rapid", "classical", "correspondence"].filter((k) => perfs[k]?.rating).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), rating: perfs[k].rating, games: perfs[k].games ?? 0 })),
        });
        events?.abort();
        events = new AbortController();
        ndjson("https://lichess.org/api/stream/event", (e) => {
          if (e.type === "gameStart") {
            const id = e.game?.gameId ?? e.game?.id;
            get().refreshOngoing();
            // Real-time games open at once; correspondence games wait in the list.
            if (id && e.game?.speed !== "correspondence" && (get().gameId !== id || !get().playing)) get().open(id);
          } else if (e.type === "gameFinish") get().refreshOngoing();
          else if (e.type === "challenge" && e.challenge) {
            const c = challengeOf(e.challenge);
            if (e.challenge.challenger?.id === get().userId) {
              if (!get().outgoing.some((x) => x.id === c.id)) set({ outgoing: [...get().outgoing, c] });
            } else if (!get().incoming.some((x) => x.id === c.id)) {
              set({ incoming: [...get().incoming, c] });
              Sound.success();
              notify("Lichess challenge", `${c.from} challenges you: ${c.variant}, ${c.timeControl}${c.rated ? ", rated" : ""}`, true);
            }
          } else if ((e.type === "challengeCanceled" || e.type === "challengeDeclined") && e.challenge) {
            set({ incoming: get().incoming.filter((x) => x.id !== e.challenge.id), outgoing: get().outgoing.filter((x) => x.id !== e.challenge.id) });
          }
        }, { signal: events.signal }).catch(() => {});
        get().refreshOngoing();
        // Correspondence: check now and then whether an opponent has moved.
        clearInterval(pollTimer);
        pollTimer = setInterval(() => get().refreshOngoing(), 60000);
      } catch (e: any) {
        set({ state: "signedOut", error: e.message ?? String(e) });
      }
    },
    refreshOngoing: async () => {
      try {
        const data = await getJson("https://lichess.org/api/account/playing?nb=30");
        const ongoing = (data.nowPlaying ?? []).map((g: any) => ({ id: g.gameId, opponent: g.opponent?.username ?? "?", myTurn: !!g.isMyTurn, fen: g.fen, color: g.color, speed: g.speed, secondsLeft: g.secondsLeft }));
        const before = new Set(get().ongoing.filter((g) => g.myTurn).map((g) => g.id));
        const fresh = ongoing.filter((g: any) => g.myTurn && g.speed === "correspondence" && !before.has(g.id));
        if (get().ongoing.length && fresh.length) notify("Your move on Lichess", fresh.map((g: any) => `against ${g.opponent}`).join(", "), true);
        set({ ongoing });
      } catch {
        /* offline */
      }
    },
    open: (id) => {
      seekStream?.abort();
      gameStream?.abort();
      gameStream = new AbortController();
      set({ gameId: id, seeking: false, result: undefined, premove: undefined, pending: undefined });
      ndjson(`https://lichess.org/api/board/game/stream/${id}`, handleGame, { signal: gameStream.signal }).catch(() => {});
    },
    play: (move) => {
      const s = get();
      if (!s.playing || s.tree.current !== s.tree.last || s.tree.current.turn !== s.myColor) return;
      if (s.confirm || s.correspondence) set({ pending: move });
      else sendMove(move);
    },
    confirmPending: () => {
      const m = get().pending;
      set({ pending: undefined });
      if (m) sendMove(m);
    },
    cancelPending: () => set({ pending: undefined }),
    setPremove: (premove) => set({ premove }),
    setConfirm: (confirm) => {
      save("lichessConfirm", confirm);
      set({ confirm });
    },
    seek: ({ minutes, increment, days, rated, variant }) => {
      seekStream?.abort();
      seekStream = new AbortController();
      const form: Record<string, string> = { rated: String(rated), variant: variant ?? "standard" };
      if (days) form.days = String(days);
      else {
        form.time = String(minutes ?? 10);
        form.increment = String(increment ?? 0);
      }
      set({ seeking: !days, error: undefined });
      api("https://lichess.org/api/board/seek", { method: "POST", form, signal: seekStream.signal })
        .then((r) => r.text())
        .then(() => {
          set({ seeking: false });
          if (days) get().refreshOngoing();
        })
        .catch((e) => e.name !== "AbortError" && set({ seeking: false, error: e.message }));
    },
    cancelSeek: () => {
      seekStream?.abort();
      set({ seeking: false });
    },
    challengeComputer: (level, minutes, increment, variant) => {
      set({ error: undefined });
      post("challenge/ai", { level: String(level), "clock.limit": String(minutes * 60), "clock.increment": String(increment), color: "random", variant: variant ?? "standard" });
    },
    challenge: async (username, o) => {
      set({ error: undefined });
      const form: Record<string, string> = { rated: String(o.rated), color: o.color, variant: o.variant };
      if (o.days) form.days = String(o.days);
      else if (o.minutes !== undefined) {
        form["clock.limit"] = String(Math.round(o.minutes * 60));
        form["clock.increment"] = String(o.increment ?? 0);
      }
      try {
        const r = await api(`https://lichess.org/api/challenge/${encodeURIComponent(username.trim())}`, { method: "POST", form }).then((x) => x.json());
        const c = challengeOf(r.challenge ?? r);
        if (!get().outgoing.some((x) => x.id === c.id)) set({ outgoing: [...get().outgoing, c] });
      } catch (e: any) {
        set({ error: e.message });
      }
    },
    answer: (id, accept) => {
      set({ incoming: get().incoming.filter((c) => c.id !== id) });
      post(`challenge/${id}/${accept ? "accept" : "decline"}`);
    },
    cancelChallenge: (id) => {
      set({ outgoing: get().outgoing.filter((c) => c.id !== id) });
      post(`challenge/${id}/cancel`);
    },
    resign: () => get().gameId && post(`board/game/${get().gameId}/resign`),
    abort: () => get().gameId && post(`board/game/${get().gameId}/abort`),
    offerDraw: () => get().gameId && post(`board/game/${get().gameId}/draw/yes`),
  };
});
