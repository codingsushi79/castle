import { create } from "zustand";
import { load, save } from "./storage";

/**
 * Guided lessons: a short explanation, one or two worked examples played out on
 * the board, then practice puzzles on the same theme from Castle's puzzle set.
 *
 * In a step, `moves` alternate between the learner and the opponent, starting
 * with the learner (or, when `setup` is given, after the opponent's setup move).
 * Every example is checked in the tests: legal, and mating where it says mate.
 */
export interface Step { fen: string; setup?: string; moves: string[]; prompt: string; done: string; mate?: boolean }
export interface Lesson {
  id: string; group: "Checkmates" | "Tactics" | "Endgames"; title: string; summary: string;
  /** Markdown, shown before the first step. */
  intro: string;
  steps: Step[];
  practice: { themes: string[]; count: number; maxRating: number };
}

export const LESSONS: Lesson[] = [
  {
    id: "back-rank", group: "Checkmates", title: "Back-rank mate", summary: "When the king is shut in by its own pawns.",
    intro: "A king behind an unmoved row of pawns has nowhere to go. A rook or queen landing on the **back rank** gives mate if nothing can block or capture it.\n\n- Look for an open file to the enemy's first rank.\n- Check what defends that rank: one defender can often be lured away.\n- Protect yourself with *luft*: a pawn move that gives your king a square.",
    steps: [
      { fen: "6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", moves: ["d1d8"], prompt: "Black's king is trapped behind its pawns. Mate in one.", done: "Rd8#: the pawns that shelter the king also cage it.", mate: true },
    ],
    practice: { themes: ["backRankMate"], count: 5, maxRating: 1600 },
  },
  {
    id: "smothered", group: "Checkmates", title: "Smothered mate", summary: "A knight mates a king hemmed in by its own pieces.",
    intro: "When a king is surrounded by its **own** pieces, a single knight check can be mate: knights jump, so nothing can block, and the king has no square to run to.\n\nIt usually happens in a corner, after the defender's pieces crowd around the king.",
    steps: [
      { fen: "6rk/6pp/8/6N1/8/8/8/6K1 w - - 0 1", moves: ["g5f7"], prompt: "The king is boxed in by its rook and pawns. Find the knight mate.", done: "Nf7#: the rook and pawns take away every escape square.", mate: true },
    ],
    practice: { themes: ["smotheredMate", "mateIn2"], count: 4, maxRating: 1800 },
  },
  {
    id: "mate-in-one", group: "Checkmates", title: "Mate in one", summary: "Spot the finishing blow.",
    intro: "Before every move, look at **checks** first: every one of them. A check that leaves the king no square, no block and no capture is mate.\n\nPractising short mates trains you to see them in your own games.",
    steps: [
      { fen: "k7/8/1K6/8/8/8/7Q/8 w - - 0 1", moves: ["h2h8"], prompt: "The king and queen work together. Mate in one.", done: "Qh8#: the queen covers the back rank, your king covers a7 and b7.", mate: true },
    ],
    practice: { themes: ["mateIn1"], count: 6, maxRating: 1500 },
  },
  {
    id: "mate-in-two", group: "Checkmates", title: "Mate in two", summary: "A forcing move, then mate.",
    intro: "Mates in two usually start with a **forcing move**: a check, a capture or a threat the opponent must answer. After the forced reply, the mate is there.\n\nAsk: *what does my first move force, and what does it leave behind?*",
    steps: [
      { fen: "2r3k1/1p4pp/6P1/2R2P1P/b7/P2R2K1/2n5/8 b - - 6 44", setup: "c8c5", moves: ["d3d8", "a4e8", "d8e8"], prompt: "Black just took your rook on c5. Mate in two.", done: "Rd8+ forces Be8, and Rxe8 is mate: the bishop could block once, but not twice.", mate: true },
    ],
    practice: { themes: ["mateIn2"], count: 6, maxRating: 1700 },
  },
  {
    id: "forks", group: "Tactics", title: "Forks", summary: "One piece attacks two at once.",
    intro: "A **fork** attacks two things at once, so the opponent can only save one. Knights are the classic forkers, but any piece can do it, even a pawn.\n\nThe best forks include a check, so the opponent has no time to save both.",
    steps: [
      { fen: "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", moves: ["b5c7", "e8e7", "c7a8"], prompt: "The king and rook are a knight's jump apart. Fork them.", done: "Nc7+ forks the king and rook, and the rook falls." },
    ],
    practice: { themes: ["fork"], count: 6, maxRating: 1600 },
  },
  {
    id: "pins", group: "Tactics", title: "Pins", summary: "A piece that can't move without exposing a bigger one.",
    intro: "A **pin** holds a piece in place because moving it would expose something more valuable behind it. Pinned to the king, it can't move at all.\n\nOnce a piece is pinned, **attack it again**: it can't run away.",
    steps: [
      { fen: "4k3/8/2n5/1B6/3P4/8/8/4K3 w - - 0 1", moves: ["d4d5"], prompt: "Black's knight is pinned to the king. Attack it.", done: "d5! The knight can't move, and it's lost." },
    ],
    practice: { themes: ["pin"], count: 6, maxRating: 1600 },
  },
  {
    id: "skewers", group: "Tactics", title: "Skewers", summary: "A pin in reverse: the big piece is in front.",
    intro: "A **skewer** attacks a valuable piece that must move, exposing a piece behind it. It's a pin the other way round, and long-range pieces (rooks, bishops, queens) do it.",
    steps: [
      { fen: "8/8/8/3k3q/8/8/8/R3K3 w - - 0 1", moves: ["a1a5", "d5e4", "a5h5"], prompt: "Black's king and queen share a rank. Skewer them.", done: "Ra5+! The king steps aside, and Rxh5 wins the queen." },
    ],
    practice: { themes: ["skewer"], count: 5, maxRating: 1700 },
  },
  {
    id: "discovered", group: "Tactics", title: "Discovered attacks", summary: "Move one piece, unleash another.",
    intro: "Moving a piece out of the way can **uncover an attack** by the piece behind it. Then both pieces threaten something, and the opponent can only answer one. A discovered *check* is the strongest kind.",
    steps: [],
    practice: { themes: ["discoveredAttack"], count: 6, maxRating: 1700 },
  },
  {
    id: "deflection", group: "Tactics", title: "Deflection", summary: "Drag a defender away from its job.",
    intro: "If one piece holds the position together, **force it to leave**: offer it something it must take, or attack it so it has to move. Then hit what it was guarding.",
    steps: [],
    practice: { themes: ["deflection"], count: 5, maxRating: 1800 },
  },
  {
    id: "promotion", group: "Endgames", title: "Promotion", summary: "Turning a pawn into a queen.",
    intro: "A pawn that reaches the last rank becomes a queen (or any piece you choose). In the endgame, an **unstoppable passed pawn** is often worth more than a piece.\n\nCount the moves: can the enemy king catch your pawn?",
    steps: [
      { fen: "8/P7/8/8/8/8/k7/4K3 w - - 0 1", moves: ["a7a8q"], prompt: "Your pawn is one step away.", done: "a8=Q. A new queen, and the endgame is won." },
    ],
    practice: { themes: ["promotion"], count: 5, maxRating: 1700 },
  },
  {
    id: "pawn-endgames", group: "Endgames", title: "Pawn endgames", summary: "Opposition, key squares, and counting.",
    intro: "In pawn endings every tempo counts.\n\n- **Opposition:** kings facing each other with one square between; the side *not* to move holds it.\n- **Key squares:** get your king in front of your pawn, on the squares that win.\n- **Count:** races are decided by counting moves to promotion.",
    steps: [],
    practice: { themes: ["pawnEndgame"], count: 6, maxRating: 1800 },
  },
  {
    id: "rook-endgames", group: "Endgames", title: "Rook endgames", summary: "The most common endings of all.",
    intro: "Rook endings are the ones you'll meet most.\n\n- Put your rook **behind** passed pawns, yours or theirs.\n- Keep your rook **active**: a passive rook defends, an active one wins.\n- Cut the enemy king off along a rank or file.",
    steps: [],
    practice: { themes: ["rookEndgame"], count: 6, maxRating: 1900 },
  },
];

/** Which lessons are finished, and which practice puzzles were solved. */
export const useLessonProgress = create<{ done: string[]; markDone: (id: string) => void }>((set, get) => ({
  done: load<string[]>("lessonsDone", []),
  markDone: (id) => {
    if (get().done.includes(id)) return;
    const done = [...get().done, id];
    save("lessonsDone", done);
    set({ done });
  },
}));
