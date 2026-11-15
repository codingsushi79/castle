import { listen } from "@tauri-apps/api/event";
import { call } from "./storage";

export interface Personality {
  id: string;
  name: string;
  rating: number;
  blurb: string;
  style: string;
  /** The Maia network that gives this opponent its human-like play, when installed. */
  maia?: number;
  /** Favourite opening lines, as SAN from the starting position. */
  book: string[];
}

export const PERSONALITIES: Personality[] = [
  { id: "pip", name: "Pip", rating: 800, style: "Beginner", blurb: "Just learned the rules. Develops pieces, hangs them, and loves an early queen trip.",
    book: ["e4 e5 Qh5 Nc6 Bc4", "e4 e5 Nf3 Nc6 Bc4 Bc5", "e4 e5 Nf3 Nf6", "d4 d5 Nf3 Nf6"] },
  { id: "nora", name: "Nora", rating: 1100, maia: 1100, style: "Careful newcomer", blurb: "Plays natural, tidy moves and sets up the same structure every game. Misses two-move tactics.",
    book: ["d4 d5 Bf4 Nf6 e3 e6 Nf3", "d4 Nf6 Bf4 g6 e3 Bg7 Nf3", "e4 c6 d4 d5 e5 Bf5", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5", "d4 d5 c4 c6 Nf3 Nf6"] },
  { id: "viktor", name: "Viktor", rating: 1300, maia: 1300, style: "Gambiteer", blurb: "Gives up a pawn in the first five moves and plays for mate. Dangerous if you get greedy, lost if you stay calm.",
    book: ["e4 e5 f4 exf4 Nf3 g5 Bc4", "e4 e5 f4 d5 exd5 e4", "e4 d5 exd5 Nf6", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "d4 e5 dxe5 Nc6 Nf3 Qe7", "d4 Nf6 c4 e5"] },
  { id: "amara", name: "Amara", rating: 1500, maia: 1500, style: "Solid", blurb: "Classical development, sound pawn structure, few risks. Waits for you to overreach.",
    book: ["d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7", "d4 Nf6 c4 e6 Nf3 d5", "e4 e6 d4 d5 Nc3 Nf6", "e4 e6 d4 d5 e5 c5 c3 Nc6", "d4 d5 c4 e6 Nf3 Nf6 Nc3 Be7"] },
  { id: "dmitri", name: "Dmitri", rating: 1700, maia: 1700, style: "Attacker", blurb: "Open positions and opposite-side castling. Knows his Sicilian lines and throws pawns at your king.",
    book: ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", "e4 c5 Nc3 Nc6 f4"] },
  { id: "ingrid", name: "Ingrid", rating: 1900, maia: 1900, style: "Positional", blurb: "Quiet openings, small edges, long squeezes. Happy to trade into a slightly better endgame.",
    book: ["c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2", "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d4", "d4 Nf6 c4 e6 Nc3 Bb4", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", "c4 c5 Nf3 Nf6 g3"] },
  { id: "professor", name: "The Professor", rating: 2300, style: "Master", blurb: "Deep preparation and precise technique. Punishes every inaccuracy but can still be held.",
    book: ["d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6"] },
  { id: "titan", name: "Titan", rating: 3600, style: "Full strength", blurb: "The engine with nothing held back. Play it to see how a position should be handled.", book: [] },
];

export const MAIA_LEVELS = [1100, 1300, 1500, 1700, 1900];

export async function maiaDir(): Promise<string> {
  return call<string>("app_dir", { sub: "maia" });
}

/** Which Maia networks are already downloaded. */
export async function installedMaia(): Promise<number[]> {
  try {
    const files = await call<[string, number][]>("list_dir", { path: await maiaDir() });
    return MAIA_LEVELS.filter((n) => files.some(([name, size]) => name === `maia-${n}.pb.gz` && size > 100000));
  } catch {
    return [];
  }
}

/** Downloads every Maia network (about 1.3 MB each) from the project's release page. */
export async function downloadMaia(onProgress: (done: number, total: number) => void): Promise<void> {
  const dir = await maiaDir();
  const have = await installedMaia();
  const wanted = MAIA_LEVELS.filter((n) => !have.includes(n));
  let done = 0;
  onProgress(0, wanted.length);
  if (!wanted.length) return;
  await new Promise<void>((resolve, reject) => {
    const un = listen<{ id: string; done: boolean; error?: string }>("download-progress", (e) => {
      if (!e.payload.id.startsWith("maia-") || !e.payload.done) return;
      if (e.payload.error) { un.then((f) => f()); return reject(new Error(e.payload.error)); }
      onProgress(++done, wanted.length);
      if (done >= wanted.length) { un.then((f) => f()); resolve(); }
    });
    for (const n of wanted) {
      call("download", { id: `maia-${n}`, url: `https://github.com/CSSLab/maia-chess/releases/download/v1.0/maia-${n}.pb.gz`, dest: `${dir}/maia-${n}.pb.gz` }).catch(reject);
    }
  });
}

/** The book moves this opponent would consider after the given SAN moves. */
export function bookMoves(p: Personality, played: string[]): string[] {
  const out: string[] = [];
  for (const line of p.book) {
    const moves = line.split(" ");
    if (moves.length > played.length && played.every((m, i) => moves[i] === m.replace(/[+#]/g, ""))) out.push(moves[played.length]);
  }
  return out;
}
