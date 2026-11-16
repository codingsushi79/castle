import { listen } from "@tauri-apps/api/event";
import type { Move } from "chessops/types";
import { create } from "zustand";
import { Color, fenOf, GameTree, moveFromUci, positionOf, START_FEN, tryPosition, turnOf, uciOf } from "./chess";
import { db } from "./db";
import { Sound } from "./sound";
import { call, isTauri, load, save } from "./storage";

export interface FicsSeek {
  id: number;
  rating: string;
  name: string;
  time: number;
  increment: number;
  rated: boolean;
  type: string;
}

interface FicsGame {
  number: number;
  white: string;
  black: string;
  relation: number; // 1: my move, -1: opponent's move, 0: observing
  clocks: Record<Color, number>;
  running: boolean;
}

interface State {
  state: "disconnected" | "connecting" | "loggingIn" | "online";
  username: string;
  guest: boolean;
  handle: string;
  console: { text: string; kind: "server" | "sent" | "sys" }[];
  seeks: FicsSeek[];
  game?: FicsGame;
  fen: string;
  lastMove?: [string, string];
  flipped: boolean;
  result?: string;
  error?: string;
  premove?: [string, string];
  pending?: Move;
  confirm: boolean;
  record: GameTree;
  /** Whether a FICS password is stored in the keychain for this username. */
  saved: boolean;
  /** Connects. With remember, a password that FICS accepts is stored in the keychain. */
  connect: (password: string, remember?: boolean) => void;
  /** Logs in with the keychain password, if there is one. Resolves false when there is none. */
  quickConnect: () => Promise<boolean>;
  /** Removes the stored password. */
  forget: () => void;
  disconnect: () => void;
  send: (command: string) => void;
  play: (move: Move) => void;
  confirmPending: () => void;
  set: (p: Partial<Pick<State, "username" | "guest" | "confirm" | "premove" | "pending">>) => void;
  refreshSeeks: () => void;
}

let buffer = "";
let password = "";
/** The password of the login in progress, kept until FICS accepts or rejects it. */
let attempt: { password: string; remember: boolean; fromKeychain: boolean } | undefined;
const KEYCHAIN = "ficsPassword";
let sentUser = false;
let sentPassword = false;
let sentReturn = false;
let readingSeeks = false;
let wired = false;
let lastTick = Date.now();

export const useFics = create<State>((set, get) => {
  const raw = (text: string) => call("fics_send", { text }).catch(() => {});
  const log = (text: string, kind: "server" | "sent" | "sys") => set({ console: [...get().console, { text, kind }].slice(-600) });

  const commit = (move: Move) => {
    const s = get();
    const pos = positionOf(s.fen).clone();
    const uci = uciOf(pos, move, false);
    pos.play(move);
    Sound.move();
    // Show the move right away; the server's board update confirms it.
    set({ fen: fenOf(pos), lastMove: [uci.slice(0, 2), uci.slice(2, 4)], game: s.game && { ...s.game, relation: -1 } });
    raw(uci.length === 5 ? `${uci.slice(0, 4)}=${uci[4]}` : uci);
  };

  const style12 = (line: string) => {
    const f = line.split(/\s+/);
    if (f.length < 31) return;
    const rows = f.slice(1, 9).map((r) => r.replace(/-+/g, (m) => String(m.length)));
    const turn = f[9] === "B" ? "b" : "w";
    const castle = (f[11] === "1" ? "K" : "") + (f[12] === "1" ? "Q" : "") + (f[13] === "1" ? "k" : "") + (f[14] === "1" ? "q" : "");
    const epFile = parseInt(f[10], 10);
    const ep = epFile >= 0 ? "abcdefgh"[epFile] + (turn === "w" ? "6" : "3") : "-";
    const fen = `${rows.join("/")} ${turn} ${castle || "-"} ${ep} ${f[15]} ${f[26]}`;
    const relation = parseInt(f[19], 10) || 0;
    const minutes = parseInt(f[20], 10) || 0;
    const fullmove = parseInt(f[26], 10) || 1;
    const game: FicsGame = {
      number: parseInt(f[16], 10) || 0, white: f[17], black: f[18], relation,
      clocks: { white: parseFloat(f[24]) || 0, black: parseFloat(f[25]) || 0 },
      running: Math.abs(relation) <= 1 && (fullmove > 1 || turn === "b") && minutes > 0,
    };
    const s = get();
    let record = s.record;
    let lastMove = s.lastMove;
    const san = f[29] === "none" ? "" : f[29];
    if (s.game?.number !== game.number || f[27] === "none") {
      record = new GameTree(tryPosition(fen) ? fen : START_FEN);
      record.headers.set("Event", "FICS game");
      record.headers.set("Site", "freechess.org");
      record.headers.set("White", game.white);
      record.headers.set("Black", game.black);
      lastMove = undefined;
      set({ result: undefined, flipped: f[30] === "1" });
    } else if (san) {
      record.toEnd();
      const node = record.playSan(san);
      if (node) {
        lastMove = node.lastMove;
        Sound.forSan(node.san);
      }
    }
    lastTick = Date.now();
    set({ fen, game, record, lastMove, pending: undefined });
    const pre = get().premove;
    if (relation === 1 && pre) {
      set({ premove: undefined });
      const pos = tryPosition(fen);
      const m = pos && (moveFromUci(pos, pre[0] + pre[1]) ?? moveFromUci(pos, pre[0] + pre[1] + "q"));
      if (m) commit(m);
    } else if (relation !== -1) set({ premove: undefined });
  };

  const handleLine = (rawLine: string) => {
    let line = rawLine;
    while (line.startsWith("fics% ")) line = line.slice(6);
    if (line.startsWith("<12> ")) return style12(line);
    const s = get();
    if (s.state === "loggingIn") {
      if (line.includes("**** Starting FICS session as ")) {
        const name = line.replace("**** Starting FICS session as ", "").replace(" ****", "");
        set({ handle: name.split("(")[0].trim(), state: "online" });
        if (attempt?.remember && !s.guest && attempt.password) {
          call("secret_set", { key: KEYCHAIN, value: `${s.username}\n${attempt.password}` }).catch(() => {});
          set({ saved: true });
        }
        attempt = undefined;
        for (const c of ["set style 12", "set interface Castle", "set bell 0", "set seek 0"]) raw(c);
        get().refreshSeeks();
      } else if (line.toLowerCase().includes("invalid password")) {
        set({ error: "Invalid password." });
        // A stored password that no longer works is dropped, so the next visit asks again.
        if (attempt?.fromKeychain) get().forget();
        attempt = undefined;
      }
      else if (line.toLowerCase().includes("press return to enter the server") && !sentReturn) {
        sentReturn = true;
        raw("");
      }
    }
    const f = line.trim().split(/\s+/);
    if (f.length >= 7 && /^\d+$/.test(f[0]) && /^\d+$/.test(f[3]) && /^\d+$/.test(f[4]) && (f[5] === "rated" || f[5] === "unrated")) {
      if (!readingSeeks) {
        readingSeeks = true;
        set({ seeks: [] });
        setTimeout(() => (readingSeeks = false), 1000);
      }
      const seek: FicsSeek = { id: parseInt(f[0], 10), rating: f[1], name: f[2], time: parseInt(f[3], 10), increment: parseInt(f[4], 10), rated: f[5] === "rated", type: f[6] };
      if (!get().seeks.some((x) => x.id === seek.id)) set({ seeks: [...get().seeks, seek] });
      return;
    }
    if (line.startsWith("{Game ")) {
      const close = line.indexOf("}");
      const result = line.slice(close + 1).trim();
      if (close > 0 && ["1-0", "0-1", "1/2-1/2", "*"].includes(result)) {
        const reason = line.slice(line.lastIndexOf(")", close) + 1, close).trim();
        const g = get();
        const wasMine = g.game && Math.abs(g.game.relation) === 1;
        g.record.result = result;
        set({ result: `${reason} · ${result}`, game: g.game && { ...g.game, running: false, relation: 0 } });
        Sound.end();
        if (wasMine) db.saveGame(g.record, "FICS");
        get().refreshSeeks();
      }
    }
    if (/ads? displayed\./.test(line)) return;
    if (line.trim()) log(line, "server");
  };

  const ingest = (text: string) => {
    buffer += text;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
    // Login prompts arrive without a trailing newline.
    const s = get();
    if (s.state !== "loggingIn") {
      if (buffer.startsWith("fics% ")) buffer = buffer.slice(6);
      return;
    }
    const tail = buffer.toLowerCase();
    if (tail.includes("login:") && !sentUser) {
      sentUser = true;
      buffer = "";
      raw(s.guest || !s.username ? "guest" : s.username);
    } else if (tail.includes("press return to enter the server") && !sentReturn) {
      sentReturn = true;
      buffer = "";
      raw("");
    } else if (tail.includes("password:") && !sentPassword) {
      sentPassword = true;
      buffer = "";
      raw(password);
      password = "";
    } else if (tail.includes("login:") && sentUser) {
      set({ error: "FICS did not accept that login." });
      get().disconnect();
    }
  };

  const wire = () => {
    if (wired || !isTauri) return;
    wired = true;
    listen<string>("fics-data", (e) => ingest(e.payload));
    listen("fics-closed", () => {
      if (get().state !== "disconnected") {
        log("Disconnected.", "sys");
        set({ state: "disconnected" });
      }
    });
    setInterval(() => {
      const now = Date.now();
      const dt = (now - lastTick) / 1000;
      lastTick = now;
      const g = get().game;
      if (!g?.running) return;
      const mover = turnOf(get().fen);
      set({ game: { ...g, clocks: { ...g.clocks, [mover]: Math.max(0, g.clocks[mover] - dt) } } });
    }, 100);
  };

  return {
    state: "disconnected",
    username: load("ficsUser", ""),
    guest: load("ficsGuest", true),
    saved: false,
    handle: "",
    console: [],
    seeks: [],
    fen: START_FEN,
    flipped: false,
    confirm: load("ficsConfirm", false),
    record: new GameTree(),
    set: (p) => {
      set(p);
      if (p.confirm !== undefined) save("ficsConfirm", p.confirm);
      if (p.username !== undefined) save("ficsUser", p.username);
      if (p.guest !== undefined) save("ficsGuest", p.guest);
    },
    connect: (pw, remember = false) => {
      if (get().state !== "disconnected") return;
      wire();
      password = pw;
      attempt = { password: pw, remember, fromKeychain: false };
      buffer = "";
      sentUser = sentPassword = sentReturn = false;
      set({ state: "connecting", error: undefined, console: [{ text: "Connecting to freechess.org…", kind: "sys" }], seeks: [], game: undefined, result: undefined });
      call("fics_connect", { host: "freechess.org", port: 5000 })
        .then(() => set({ state: "loggingIn" }))
        .catch((e) => set({ state: "disconnected", error: `Can't reach freechess.org: ${e}` }));
    },
    quickConnect: async () => {
      const stored = await call<string | null>("secret_get", { key: KEYCHAIN }).catch(() => null);
      const [user, pw] = stored ? [stored.slice(0, stored.indexOf("\n")), stored.slice(stored.indexOf("\n") + 1)] : [];
      if (!user || !pw) {
        set({ saved: false });
        return false;
      }
      set({ saved: true, username: user, guest: false });
      save("ficsUser", user);
      save("ficsGuest", false);
      get().connect(pw);
      attempt = { password: pw, remember: false, fromKeychain: true };
      return true;
    },
    forget: () => {
      call("secret_set", { key: KEYCHAIN, value: null }).catch(() => {});
      set({ saved: false });
    },
    disconnect: () => {
      if (get().state === "online") raw("quit");
      call("fics_disconnect").catch(() => {});
      password = "";
      set({ state: "disconnected" });
    },
    send: (command) => {
      const text = command.trim();
      if (!text || get().state !== "online") return;
      log(text, "sent");
      raw(text);
    },
    play: (move) => {
      const s = get();
      if (s.game?.relation !== 1 || s.pending) return;
      if (s.confirm) set({ pending: move });
      else commit(move);
    },
    confirmPending: () => {
      const m = get().pending;
      set({ pending: undefined });
      if (m) commit(m);
    },
    refreshSeeks: () => {
      if (get().state === "online") raw("sought");
    },
  };
});
