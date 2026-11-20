import { listen } from "@tauri-apps/api/event";
import { call } from "./storage";

/** Leanings in how an opponent picks among good moves, in winning-chance points (0–100 scale). */
export interface Leaning {
  /** Giving check. */
  checks?: number;
  /** Capturing. */
  captures?: number;
  /** Trading pieces of equal value. */
  trades?: number;
  /** Pushing pawns towards the other king. */
  storms?: number;
  /** Quiet moves: no capture, no check. */
  quiet?: number;
  /** Moving the queen in the first ten moves. */
  earlyQueen?: number;
}

/** How an opponent talks during a game. See voices.ts. */
export type Temperament = "cheerful" | "careful" | "showman" | "intense" | "dry" | "machine" | "coach";

export interface Personality {
  id: string;
  name: string;
  /** The rating it plays at, measured: see strength.ts. Titan's 3000+ means no limit. */
  rating: number;
  blurb: string;
  style: string;
  /** The Maia network that gives this opponent its human-like choices, when installed. */
  maia?: number;
  /** Favourite opening lines, as SAN from the starting position. */
  book: string[];
  leaning?: Leaning;
  temperament: Temperament;
  /** How often it says something when nothing big happens, 0 to 1. */
  chattiness: number;
  /** The colour of its avatar. */
  color: string;
  /** Things only this opponent says, by event; the temperament fills in the rest. */
  lines?: Partial<Record<string, string[]>>;
  /** Coaches teach openings (courses.ts), explain their moves and can play at any strength. */
  coach?: { title: string; courses: string[]; bio: string };
}

export const PERSONALITIES: Personality[] = [
  { id: "bea", name: "Bea", rating: 400, style: "First steps", temperament: "cheerful", chattiness: 0.5, color: "#f4a261",
    blurb: "Knows how every piece moves and not much more. Leaves pieces where they can be taken and is delighted by every capture.",
    leaning: { captures: 6, earlyQueen: 4 }, book: ["e4 e5 Qh5", "e4 e5 Bc4 Nc6 Qf3", "a4 e5 h4", "e4 Nc6 Qh5"],
    lines: { hello: ["Hi! I just learned how the horse moves. It's the knight? The knight."], loss: ["That was fun! Again?"] } },
  { id: "pip", name: "Pip", rating: 800, style: "Beginner", temperament: "cheerful", chattiness: 0.45, color: "#e9c46a",
    blurb: "Just learned the rules. Develops pieces, hangs them, and loves an early queen trip.",
    leaning: { captures: 4, earlyQueen: 3, checks: 2 }, book: ["e4 e5 Qh5 Nc6 Bc4", "e4 e5 Nf3 Nc6 Bc4 Bc5", "e4 e5 Nf3 Nf6", "d4 d5 Nf3 Nf6"] },
  { id: "theo", name: "Theo", rating: 1000, style: "Weekend player", temperament: "cheerful", chattiness: 0.4, color: "#90be6d",
    blurb: "Plays every Saturday at the café. Swaps pieces whenever he can, because fewer pieces means fewer things to worry about.",
    leaning: { trades: 4, captures: 2 }, book: ["e4 e5 Nf3 Nc6 Nc3 Nf6 Bc4", "e4 e5 Nc3 Nf6 Bc4", "d4 d5 e3 Nf6 Bd3", "e4 c5 Nc3 Nc6 Nf3"],
    lines: { hello: ["Fancy a game? I'll warn you, I like to trade."] } },
  { id: "nora", name: "Nora", rating: 1100, maia: 1100, style: "Careful newcomer", temperament: "careful", chattiness: 0.3, color: "#43aa8b",
    blurb: "Plays natural, tidy moves and sets up the same structure every game. Misses two-move tactics.",
    leaning: { quiet: 2 }, book: ["d4 d5 Bf4 Nf6 e3 e6 Nf3", "d4 Nf6 Bf4 g6 e3 Bg7 Nf3", "e4 c6 d4 d5 e5 Bf5", "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5", "d4 d5 c4 c6 Nf3 Nf6"] },
  { id: "viktor", name: "Viktor", rating: 1300, maia: 1300, style: "Gambiteer", temperament: "showman", chattiness: 0.5, color: "#f94144",
    blurb: "Gives up a pawn in the first five moves and plays for mate. Dangerous if you get greedy, lost if you stay calm.",
    leaning: { checks: 4, storms: 3 }, book: ["e4 e5 f4 exf4 Nf3 g5 Bc4", "e4 e5 f4 d5 exd5 e4", "e4 d5 exd5 Nf6", "e4 e5 Nf3 Nc6 Bc4 Bc5 b4", "d4 e5 dxe5 Nc6 Nf3 Qe7", "d4 Nf6 c4 e5"],
    lines: { hello: ["A pawn? Take it. I insist."], leftBook: ["Now the fun begins."] } },
  { id: "sana", name: "Sana", rating: 1400, style: "Endgame grinder", temperament: "careful", chattiness: 0.3, color: "#577590",
    blurb: "Trades into endgames and wins them slowly. Her middlegames are plain, but she won't lose a won ending.",
    leaning: { trades: 5, quiet: 1 }, book: ["d4 d5 c4 dxc4 e3 Nf6 Bxc4 e6 Nf3", "e4 e5 Nf3 Nc6 d4 exd4 Nxd4", "e4 e6 d4 d5 exd5 exd5", "c4 e5 Nc3 Nc6 g3"],
    lines: { hello: ["Let's see who's still standing in the endgame."] } },
  { id: "amara", name: "Amara", rating: 1500, maia: 1500, style: "Solid", temperament: "careful", chattiness: 0.3, color: "#4d908e",
    blurb: "Classical development, sound pawn structure, few risks. Waits for you to overreach.",
    leaning: { quiet: 2 }, book: ["d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7", "d4 Nf6 c4 e6 Nf3 d5", "e4 e6 d4 d5 Nc3 Nf6", "e4 e6 d4 d5 e5 c5 c3 Nc6", "d4 d5 c4 e6 Nf3 Nf6 Nc3 Be7"] },
  { id: "felix", name: "Felix", rating: 1600, style: "Hypermodern trickster", temperament: "showman", chattiness: 0.45, color: "#9b5de5",
    blurb: "Fianchettoes everything, gives you the centre and then tries to knock it over. Loves a trap.",
    leaning: { checks: 2 }, book: ["Nf3 d5 g3 Nf6 Bg2 c6 O-O Bg4", "g3 d5 Bg2 Nf6 Nf3", "e4 g6 d4 Bg7 Nc3 d6", "d4 Nf6 c4 g6 Nc3 d5", "e4 d6 d4 Nf6 Nc3 g6"],
    lines: { hello: ["Take the centre. Go on. It's all yours."] } },
  { id: "dmitri", name: "Dmitri", rating: 1700, maia: 1700, style: "Attacker", temperament: "intense", chattiness: 0.35, color: "#f3722c",
    blurb: "Open positions and opposite-side castling. Knows his Sicilian lines and throws pawns at your king.",
    leaning: { checks: 3, storms: 4 }, book: ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6", "e4 c5 Nf3 Nc6 d4 cxd4 Nxd4 g6", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6", "e4 c5 Nc3 Nc6 f4"] },
  { id: "lucia", name: "Lucia", rating: 1800, style: "Tactician", temperament: "showman", chattiness: 0.4, color: "#f15bb5",
    blurb: "Sharp lines, sacrifices and complications. Calculates well; gets impatient in quiet positions.",
    leaning: { checks: 3, captures: 2 }, book: ["e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5 Na5", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 Nc6", "e4 e5 Nf3 Nc6 d4 exd4 Bc4", "d4 d5 c4 e5"],
    lines: { hello: ["Let's make this messy."] } },
  { id: "ingrid", name: "Ingrid", rating: 1900, maia: 1900, style: "Positional", temperament: "dry", chattiness: 0.25, color: "#277da1",
    blurb: "Quiet openings, small edges, long squeezes. Happy to trade into a slightly better endgame.",
    leaning: { quiet: 2, trades: 1 }, book: ["c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2", "Nf3 d5 g3 Nf6 Bg2 e6 O-O Be7 d4", "d4 Nf6 c4 e6 Nc3 Bb4", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4", "c4 c5 Nf3 Nf6 g3"] },
  { id: "kofi", name: "Kofi", rating: 2000, style: "Counterpuncher", temperament: "intense", chattiness: 0.3, color: "#e76f51",
    blurb: "An expert who lets you attack, then hits back hard. Defends well and punishes overextension.",
    leaning: { captures: 1 }, book: ["e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6", "d4 Nf6 c4 e6 Nf3 b6", "e4 e5 Nf3 Nc6 Bb5 Nf6", "d4 Nf6 c4 c5 d5 b5"],
    lines: { hello: ["Go ahead and attack. I'll be waiting."] } },
  { id: "mei", name: "Mei", rating: 2100, style: "Universal", temperament: "dry", chattiness: 0.25, color: "#2a9d8f",
    blurb: "No favourite kind of position: she plays whatever the board asks for, quickly and accurately.",
    book: ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O", "d4 d5 c4 c6 Nf3 Nf6 Nc3 dxc4", "e4 c6 d4 d5 e5 Bf5 Nf3 e6", "c4 Nf6 Nc3 e6 e4"] },
  { id: "rafael", name: "Rafael", rating: 2200, style: "Candidate master", temperament: "dry", chattiness: 0.25, color: "#264653",
    blurb: "Deep in the Ruy Lopez and the Queen's Gambit. Precise in the middlegame, occasionally careless in time trouble.",
    leaning: { quiet: 1 }, book: ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 O-O c3 d5", "d4 d5 c4 e6 Nc3 Nf6 cxd5 exd5 Bg5", "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3"] },
  { id: "professor", name: "The Professor", rating: 2300, style: "Master", temperament: "dry", chattiness: 0.3, color: "#6d597a",
    blurb: "Deep preparation and precise technique. Punishes every inaccuracy but can still be held.",
    book: ["d4 Nf6 c4 e6 g3 d5 Bg2 Be7 Nf3 O-O", "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6", "d4 d5 c4 c6 Nf3 Nf6 Nc3 e6", "e4 c5 Nf3 e6 d4 cxd4 Nxd4 a6"],
    lines: { hello: ["Shall we begin? Take your time."] } },
  { id: "yara", name: "Yara", rating: 2450, style: "International master", temperament: "intense", chattiness: 0.2, color: "#b5179e",
    blurb: "Plays to win with either colour. Sharp, well prepared and very hard to trick.",
    book: ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Bg5 e6 f4", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5", "e4 e5 Nf3 Nc6 Bb5 Nf6 O-O Nxe4 d4 Nd6"] },
  { id: "titan", name: "Titan", rating: 3600, style: "Full strength", temperament: "machine", chattiness: 0.1, color: "#495057",
    blurb: "The engine with nothing held back. Play it to see how a position should be handled.", book: [] },

  // Coaches. Each teaches openings and talks you through the game; you choose how strongly they play.
  { id: "coach-maya", name: "Coach Maya", rating: 1000, style: "Coach · first openings", temperament: "coach", chattiness: 0.6, color: "#06d6a0",
    coach: { title: "Opening principles", courses: ["italian", "scandinavian"], bio: "Taught hundreds of kids their first openings. Patient, clear, and always explains why." },
    blurb: "Teaches the Italian Game and the Scandinavian. Explains every move, hers and yours.",
    book: ["e4 e5 Nf3 Nc6 Bc4 Bc5 c3 Nf6 d3", "e4 d5 exd5 Qxd5 Nc3 Qa5 d4 Nf6 Nf3 Bf5"] },
  { id: "coach-leo", name: "Coach Leo", rating: 1600, style: "Coach · classical", temperament: "coach", chattiness: 0.55, color: "#118ab2",
    coach: { title: "Classical chess", courses: ["ruy-lopez", "queens-gambit"], bio: "A club trainer who believes in the classics: control the centre, develop, castle, then make a plan." },
    blurb: "Teaches the Ruy Lopez and the Queen's Gambit, with the plans that go with them.",
    book: ["e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Be7 Re1 b5 Bb3 d6 c3 O-O h3", "d4 d5 c4 e6 Nc3 Nf6 Bg5 Be7 e3 O-O Nf3"] },
  { id: "coach-sam", name: "Coach Sam", rating: 1400, style: "Coach · systems", temperament: "coach", chattiness: 0.55, color: "#ef476f",
    coach: { title: "Reliable systems", courses: ["london", "caro-kann"], bio: "Prefers setups you can play half asleep: the same plan against almost anything." },
    blurb: "Teaches the London System and the Caro-Kann: solid set-ups with clear plans.",
    book: ["d4 d5 Bf4 Nf6 e3 e6 Nf3 Bd6 Bg3 O-O Bd3 c5 c3 Nc6 Nbd2", "e4 c6 d4 d5 e5 Bf5 Nf3 e6 Be2 c5"] },
  { id: "coach-ines", name: "Coach Ines", rating: 2000, style: "Coach · fighting defences", temperament: "coach", chattiness: 0.5, color: "#ffd166",
    coach: { title: "Play for a win with Black", courses: ["sicilian", "kings-indian"], bio: "A former national junior champion who wants you to play for a win with Black, not just survive." },
    blurb: "Teaches the Sicilian Najdorf and the King's Indian: unbalanced openings where Black plays for the win.",
    book: ["e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be2 e5 Nb3 Be7", "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 Nf3 O-O Be2 e5 O-O Nc6"] },
  { id: "coach-oskar", name: "Coach Oskar", rating: 1800, style: "Coach · French and English", temperament: "coach", chattiness: 0.5, color: "#8338ec",
    coach: { title: "Structures and plans", courses: ["french", "english"], bio: "Thinks in pawn structures. Ask him about a position and he'll start with the pawns." },
    blurb: "Teaches the French Defence and the English Opening, built around their pawn structures.",
    book: ["e4 e6 d4 d5 e5 c5 c3 Nc6 Nf3 Qb6", "c4 e5 Nc3 Nf6 g3 d5 cxd5 Nxd5 Bg2 Nb6"] },
];

export const COACHES = PERSONALITIES.filter((p) => p.coach);
export const OPPONENTS = PERSONALITIES.filter((p) => !p.coach);
export const personaById = (id: string) => PERSONALITIES.find((p) => p.id === id);

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
