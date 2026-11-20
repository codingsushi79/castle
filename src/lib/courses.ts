import type { Color } from "./chess";

/**
 * Opening courses taught by the coaches (personalities.ts). Each chapter is a
 * line from the starting position, written as SAN moves with the coach's
 * explanation in braces after the move it explains. The tests replay every line.
 */
export interface Chapter {
  title: string;
  intro: string;
  line: string;
}

export interface Course {
  id: string;
  name: string;
  eco: string;
  /** The side you learn to play. */
  side: Color;
  level: "Beginner" | "Intermediate" | "Advanced";
  summary: string;
  /** The ideas to remember, shown before the first chapter and after the last. */
  ideas: string[];
  chapters: Chapter[];
}

export interface CourseMove {
  san: string;
  say?: string;
}

/** A chapter's moves with their explanations. */
export function parseLine(line: string): CourseMove[] {
  const out: CourseMove[] = [];
  const re = /\{([^}]*)\}|([^\s{}]+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[1] !== undefined) {
      if (out.length) out[out.length - 1].say = m[1].trim();
    } else if (!/^\d+\.+$/.test(m[2])) out.push({ san: m[2].replace(/^\d+\.+/, "") });
  }
  return out;
}

export const COURSES: Course[] = [
  {
    id: "italian", name: "Italian Game", eco: "C50–C54", side: "white", level: "Beginner",
    summary: "Fast development, a bishop aimed at f7, and a slow, solid centre. The best first opening for White.",
    ideas: ["Develop knights before bishops, and both before the queen.", "The bishop on c4 eyes f7, which only Black's king defends.", "c3 and d3 (or d4) build a centre that is hard to attack.", "Castle early, then bring a rook to e1."],
    chapters: [
      { title: "The main plan", intro: "The quiet Italian: develop everything, castle, and keep the centre solid before expanding.",
        line: "e4 {Take the centre and open lines for the queen and the light-squared bishop.} e5 Nf3 {Develop with a threat: the e5 pawn is attacked.} Nc6 {Black defends it with a knight.} Bc4 {The Italian bishop. It aims at f7, the weakest square in Black's position: only the king guards it.} Bc5 {Black copies, aiming at f2.} c3 {Prepares d4 for a bigger centre, and gives the bishop a retreat on c2 later.} Nf6 {Black develops and attacks e4.} d3 {Defends e4 calmly. White keeps the centre solid first and expands later.} d6 O-O {King safety first.} O-O Re1 {The rook backs up e4 and a future d4.} a6 Bb3 {Steps back before Black can chase the bishop with ...b5 or ...Na5.} Ba7 h3 {Stops ...Bg4, which would pin the knight to the queen.} h6 Nbd2 {This knight is heading for f1 and g3 to join the kingside.}" },
      { title: "Against the Two Knights", intro: "Black attacks e4 at once with 3...Nf6. The calm 4.d3 keeps everything defended.",
        line: "e4 e5 Nf3 Nc6 Bc4 Nf6 {The Two Knights Defence: Black hits e4 straight away.} d3 {The calm answer: e4 is defended and White keeps developing.} Be7 O-O O-O Re1 {Every White piece is coming towards the centre.} d6 c3 {Prepares d4, the same plan as before.} h6 Nbd2 {The knight goes the long way round: d2, f1, g3.} Re8 Bb3 {Out of the way of ...Na5 and ...b5 before they come.} Bf8 Nf1 {Heading for g3, where it watches f5 and e4.}" },
      { title: "The Fried Liver Attack", intro: "If Black answers 4.Ng5 d5 by taking back with the knight, White can sacrifice on f7 and hunt the king.",
        line: "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 {The knight and bishop both attack f7.} d5 {Black's best: block the bishop's line to f7.} exd5 Nxd5 {A natural recapture, and a mistake. (5...Na5 is the move.)} Nxf7 {The Fried Liver: give a knight to drag the king out.} Kxf7 Qf3+ {Check, and the pinned knight on d5 is attacked too.} Ke6 {The king has to defend the knight himself.} Nc3 {Piles up on the pinned knight.} Ncb4 {Black defends d5 again.} O-O {Castle, then Re1: Black's king will never be safe in the middle.} c6 d4 {Open the centre while the king is stuck on e6.}" },
    ],
  },
  {
    id: "scandinavian", name: "Scandinavian Defence", eco: "B01", side: "black", level: "Beginner",
    summary: "Challenge e4 on move one. Easy to learn, with the same simple set-up against almost everything.",
    ideas: ["Take back on d5 with the queen, then put her on a5 or d6 where she's safe.", "Bring the light-squared bishop out (to f5 or g4) before playing ...e6.", "...c6 and ...e6 make a solid wall; castle and develop calmly.", "Don't move the queen again and again: one retreat, then develop."],
    chapters: [
      { title: "The main line with ...Qa5", intro: "The classic set-up: queen to a5, bishop to f5, pawns on c6 and e6.",
        line: "e4 d5 {Challenge the e4 pawn straight away.} exd5 Qxd5 {Take back with the queen. She'll be chased, but she has a safe square to go to.} Nc3 {White develops and attacks the queen.} Qa5 {Out of the way, and still active on the a5–e1 diagonal.} d4 Nf6 {Develop.} Nf3 Bf5 {The light-squared bishop gets out before ...e6 shuts it in.} Bc4 e6 {Now ...e6 is fine: the bishop is already outside the pawn chain.} Bd2 c6 {A solid wall, and a retreat square for the queen on c7.} Qe2 Bb4 {Pins the knight, so tricks with Nd5 or Ne4 don't work.}" },
      { title: "The modern ...Qd6", intro: "The queen goes to d6, where she's harder to chase than on a5.",
        line: "e4 d5 exd5 Qxd5 Nc3 Qd6 {The modern retreat. On d6 the queen is hard to attack and watches both sides.} d4 Nf6 Nf3 a6 {Keeps White's knight and bishop off b5, where they'd hit the queen.} g3 Bg4 {Pins the knight against the queen.} Bg2 Nc6 {Develops and puts pressure on d4.}" },
      { title: "Against 3.Nf3", intro: "If White doesn't chase the queen, Black can be ambitious and castle queenside.",
        line: "e4 d5 exd5 Qxd5 Nf3 Bg4 {Pin the knight: the queen on d5 would like to stay there.} Be2 Nc6 {Develops and adds pressure to d4.} d4 O-O-O {Castling queenside puts the rook straight on the d-file, against d4.}" },
    ],
  },
  {
    id: "ruy-lopez", name: "Ruy Lopez", eco: "C60–C99", side: "white", level: "Intermediate",
    summary: "The Spanish Game: slow pressure on e5, a long-term plan with c3 and d4, and centuries of grandmaster practice.",
    ideas: ["Bb5 attacks the knight that defends e5: the pressure is long-term, not an immediate threat.", "c3 prepares d4 and gives the bishop a home on c2.", "h3 stops ...Bg4 before d4 comes.", "Against the Berlin, the endgame after the queen trade is what both sides play for."],
    chapters: [
      { title: "The Closed Ruy Lopez", intro: "The main line: White builds the centre with c3, h3 and d4.",
        line: "e4 e5 Nf3 Nc6 Bb5 {The Spanish bishop puts pressure on the knight that defends e5.} a6 {Black asks the bishop what it wants.} Ba4 {Keeps up the pressure. (Bxc6 is the Exchange Variation.)} Nf6 O-O {e4 isn't really hanging: if ...Nxe4, White gets it back with Re1 or d4.} Be7 Re1 {Now e4 is defended properly.} b5 Bb3 d6 c3 {Prepares d4, and the bishop will have c2 to retreat to.} O-O h3 {Stops ...Bg4, which would pin the knight that supports d4.} Na5 {Black chases the strong bishop.} Bc2 {It stays on the diagonal towards Black's king.} c5 d4 {The central break White has been preparing since move 9.}" },
      { title: "The Berlin Defence", intro: "Black takes on e4 and heads for an endgame without queens. Know the plan.",
        line: "e4 e5 Nf3 Nc6 Bb5 Nf6 {The Berlin: Black develops and hits e4 at once.} O-O {White castles and lets Black take.} Nxe4 d4 {Opens the e-file towards Black's king, which hasn't castled yet.} Nd6 Bxc6 dxc6 dxe5 Nf5 Qxd8+ Kxd8 {The Berlin endgame. Black has the bishop pair; White has the better pawns on the kingside.}" },
      { title: "The Open Ruy Lopez", intro: "Black takes on e4 and keeps it. White plays for a lead in development.",
        line: "e4 e5 Nf3 Nc6 Bb5 a6 Ba4 Nf6 O-O Nxe4 {The Open Ruy Lopez: Black grabs the pawn.} d4 {Opens the centre while Black's king is still in it.} b5 Bb3 d5 {Black gives back the idea of keeping the pawn and holds the knight on e4.} dxe5 Be6 {Develops and defends d5.} c3 {Gives the bishop a home on c2 and prepares to challenge the knight on e4.}" },
    ],
  },
  {
    id: "queens-gambit", name: "Queen's Gambit", eco: "D06–D69", side: "white", level: "Intermediate",
    summary: "Offer the c-pawn to pull Black's d-pawn away from the centre. Solid, classical and rich in plans.",
    ideas: ["c4 isn't a real sacrifice: if Black takes, White wins the centre and gets the pawn back.", "Bg5 pins the knight that defends d5.", "Against the Slav, a4 stops ...b5 holding the pawn.", "The minority attack and central breaks come once development is done."],
    chapters: [
      { title: "Queen's Gambit Declined", intro: "Black holds d5 with ...e6. White pins, develops, and trades into a pleasant position.",
        line: "d4 d5 c4 {The Queen's Gambit: if Black takes, White gets a big centre with e4.} e6 {Declined: Black keeps a pawn on d5.} Nc3 {Adds a third attacker to d5.} Nf6 Bg5 {Pins the knight that defends d5.} Be7 {Breaks the pin.} e3 {Opens a path for the light-squared bishop.} O-O Nf3 h6 {Asks the bishop to decide.} Bh4 {Keeps the pin.} b6 {The Tartakower Variation: the bishop goes to b7.} cxd5 Nxd5 Bxe7 Qxe7 Nxd5 exd5 Rc1 {The rook goes to the c-file, against Black's c-pawn.} Be6 Qa4 {Puts pressure on a7 and stops ...c5 from being easy.}" },
      { title: "Queen's Gambit Accepted", intro: "Black takes on c4. White gets the pawn back and plays for the centre.",
        line: "d4 d5 c4 dxc4 {Accepted. Black can't keep the pawn for long.} e3 {Opens the bishop's diagonal: Bxc4 is coming.} Nf6 Bxc4 e6 Nf3 {Develops and stops ...e5.} c5 {Black strikes at White's centre.} O-O {Castle before opening the position.} a6 {Prepares ...b5 to chase the bishop.} Bb3 {Out of the way of ...b5.} Nc6 Nc3 {Every White piece is out, and e4 is the next idea.}" },
      { title: "The Slav", intro: "Black defends d5 with ...c6, keeping the light-squared bishop free.",
        line: "d4 d5 c4 c6 {The Slav: d5 is defended without blocking the bishop on c8.} Nf3 {Develop first: the c4 pawn can wait.} Nf6 Nc3 {More pressure on d5.} dxc4 {Now Black takes, hoping to keep it with ...b5.} a4 {Stops ...b5, which would hold on to the pawn.} Bf5 {The bishop gets out before ...e6.} e3 e6 Bxc4 {White has the pawn back.} Bb4 {Pins the knight, so e4 is harder to play.} O-O O-O Qe2 {Prepares e4 to take the centre.}" },
    ],
  },
  {
    id: "london", name: "London System", eco: "D02, A46", side: "white", level: "Beginner",
    summary: "The same solid set-up against almost anything: d4, Bf4, e3, Nf3, c3. Few traps to learn, clear plans.",
    ideas: ["Bf4 comes out before e3 shuts it in.", "c3, d4 and e3 make a pyramid that is very hard to break.", "Keep the bishop with Bg3 or h3; if it's taken on g3, hxg3 opens the h-file.", "Ne5 is the typical outpost, supported by the d4 pawn."],
    chapters: [
      { title: "Against ...d5", intro: "The standard London: the pyramid, the bishop on g3 and a knight on e5.",
        line: "d4 d5 Bf4 {The London bishop gets out before e3 locks it in.} Nf6 e3 {Supports d4 and opens the light-squared bishop's diagonal.} e6 Nf3 {Develop and control e5.} c5 {Black strikes at the centre.} c3 {The London pyramid: c3, d4 and e3. Very hard to break.} Nc6 Nbd2 {This knight supports e4 and the other knight's jump to e5.} Bd6 {Black offers to trade the London bishop.} Bg3 {Keeps the bishop. If Black takes on g3, hxg3 opens the h-file for White's rook.} O-O Bd3 {The bishop points at Black's king.} b6 Ne5 {The knight jumps to its outpost, supported by d4.}" },
      { title: "Against the King's Indian set-up", intro: "Black fianchettoes. The same set-up works, with h3 to keep the bishop safe.",
        line: "d4 Nf6 Bf4 {The same set-up whatever Black plays.} g6 e3 Bg7 Nf3 O-O Be2 {A modest square: the bishop keeps the kingside safe.} d6 h3 {A retreat square on h2: ...Nh5 won't win the bishop.} c5 c3 {The pyramid again.} Nc6 O-O {Development done. White plans Nbd2 and e4 later.}" },
      { title: "Against an early ...Qb6", intro: "Black attacks b2. The simplest answer offers a queen trade.",
        line: "d4 d5 Bf4 c5 e3 Nc6 c3 {The pyramid holds d4.} Qb6 {Black attacks b2, which the bishop on f4 no longer defends.} Qb3 {The simplest answer: offer a queen trade, so b2 is defended.} c4 {Black gains space and attacks the queen.} Qc2 {The queen steps back and keeps an eye on e4.}" },
    ],
  },
  {
    id: "caro-kann", name: "Caro-Kann Defence", eco: "B12–B19", side: "black", level: "Beginner",
    summary: "Solid and sound: ...c6 then ...d5, and the light-squared bishop comes out before ...e6.",
    ideas: ["...c6 supports ...d5, so Black keeps a pawn in the centre.", "Get the light-squared bishop out (f5 or g4) before ...e6.", "Against the Advance, hit the chain at its base with ...c5.", "The structure is healthy: in many endgames Black is the one who's better."],
    chapters: [
      { title: "The Advance Variation", intro: "White gains space with e5. Black develops the bishop, then attacks the base of the chain.",
        line: "e4 c6 {Prepares ...d5 with the c-pawn backing it up.} d4 d5 e5 {The Advance: White grabs space.} Bf5 {The key Caro-Kann idea: the bishop comes out before ...e6 locks it in.} Nf3 {White develops and supports d4.} e6 {Now ...e6 is fine: the bishop is already outside.} Be2 c5 {Strike at the base of White's pawn chain, d4.} Be3 {Defends d4 once more.} Nd7 {Supports ...c5 and keeps e5 under watch.} O-O Ne7 {Heading for c6 or g6, without blocking the f-pawn.}" },
      { title: "The Classical Variation", intro: "Black takes on e4 and the bishop comes to f5, then to the safety of h7.",
        line: "e4 c6 d4 d5 Nc3 dxe4 Nxe4 Bf5 {The bishop attacks the knight and develops.} Ng3 Bg6 {Keeps the bishop on the diagonal.} h4 h6 {Gives the bishop a home on h7 if h5 comes.} Nf3 Nd7 {Stops Ne5, which would hit the bishop.} h5 Bh7 Bd3 Bxd3 Qxd3 e6 {Solid. Black castles next, often queenside.}" },
      { title: "The Exchange Variation", intro: "Symmetrical pawns, but Black still has active play.",
        line: "e4 c6 d4 d5 exd5 cxd5 {Symmetrical pawns.} Bd3 {White aims the bishop at h7.} Nc6 {Pressure on d4.} c3 Nf6 {Develops and guards h7.} Bf4 Bg4 {The bishop gets out before ...e6, as always.} Qb3 {White attacks b7.} Qd7 {Defends b7 and connects towards queenside castling.} Nd2 e6 Ngf3 Bxf3 {Trades the bishop for the knight that would land on e5.} Nxf3 Bd6 {Offers to trade White's good bishop.}" },
    ],
  },
  {
    id: "sicilian", name: "Sicilian Najdorf", eco: "B90–B99", side: "black", level: "Advanced",
    summary: "The fighting answer to 1.e4. Black accepts an unbalanced position to play for a win.",
    ideas: ["...c5 fights for d4 from the side; after ...cxd4 Black has two centre pawns to White's one.", "...a6 controls b5 and prepares ...e5 or ...b5.", "After ...e5, d5 is a hole: fight for it with ...Be6 and knights.", "When the kings castle on opposite sides, it's a race: attack fast."],
    chapters: [
      { title: "Against 6.Be2", intro: "The classical approach. Black plays ...e5 and fights for the d5 square.",
        line: "e4 c5 {Fights for d4 from the side. The position will be unbalanced.} Nf3 d6 d4 cxd4 {Black trades a wing pawn for a centre pawn.} Nxd4 Nf6 {Attacks e4, so White has to defend it.} Nc3 a6 {The Najdorf: controls b5 and prepares ...e5.} Be2 e5 {Kicks the knight. d5 becomes a hole, but Black gains space.} Nb3 Be7 O-O O-O Be3 Be6 {Fights for d5.} Qd2 Nbd7 a4 {Stops ...b5.} Rc8 {The rook goes to the half-open c-file.}" },
      { title: "Against the English Attack", intro: "White castles queenside and storms the kingside. Black must be just as quick.",
        line: "e4 c5 Nf3 d6 d4 cxd4 Nxd4 Nf6 Nc3 a6 Be3 {The English Attack: f3, Qd2, castle long, then g4.} e5 Nb3 Be6 {Fights for d5 at once.} f3 {Keeps Black's pieces off g4 and prepares g4.} Be7 Qd2 O-O {Black castles short; White will castle long.} O-O-O {Opposite-side castling: the attack that arrives first wins.} Nbd7 {Heads for b6 to fight for d5 and a4.} g4 b5 {Black's own pawn storm starts at once.} g5 b4 {Hits the knight that defends e4.}" },
      { title: "Against the Alapin, 2.c3", intro: "Not every White player allows the Najdorf. Against 2.c3, hit e4 straight away.",
        line: "e4 c5 c3 {The Alapin: White wants to play d4 and take back with a pawn.} Nf6 {Hits e4 at once.} e5 Nd5 d4 cxd4 Nf3 Nc6 {Pressure on d4.} cxd4 d6 {Undermine the e5 pawn.} Bc4 {Hits the knight on d5.} Nb6 {Retreats with tempo on the bishop.} Bb5 dxe5 Nxe5 Bd7 {Black has equalised comfortably.}" },
    ],
  },
  {
    id: "kings-indian", name: "King's Indian Defence", eco: "E60–E99", side: "black", level: "Advanced",
    summary: "Let White build a big centre, then attack it, and often White's king, with ...e5 and ...f5.",
    ideas: ["Fianchetto and castle first; challenge the centre afterwards with ...e5.", "When White closes the centre with d5, Black attacks on the kingside with ...f5–f4–g5.", "White attacks on the queenside: it's a race.", "The bishop on g7 is the soul of the position: don't trade it lightly."],
    chapters: [
      { title: "The Classical main line", intro: "The Mar del Plata: White closes the centre, Black storms the kingside.",
        line: "d4 Nf6 c4 g6 {Prepares to fianchetto the bishop.} Nc3 Bg7 e4 d6 {Black lets White build the centre, for now.} Nf3 O-O {Castle before starting the fight.} Be2 e5 {Now Black strikes at the centre.} O-O Nc6 {More pressure on d4.} d5 {White closes the centre.} Ne7 {The knight heads to the kingside to support ...f5.} Ne1 Nd7 {Gets out of the way of the f-pawn.} Nd3 f5 {The thematic break.} Bd2 Nf6 {Back to f6 to support ...g5.} f3 {Holds e4 and blunts the coming ...g4.} f4 {Gains space; ...g5–g4 comes next.}" },
      { title: "Against the Sämisch", intro: "White plays f3 and Be3, often castling queenside. Black hits back in the centre.",
        line: "d4 Nf6 c4 g6 Nc3 Bg7 e4 d6 f3 {The Sämisch: e4 is rock solid, and g4 may come.} O-O Be3 e5 {Strike at d4 before White is fully developed.} d5 {White closes the centre.} Nh5 {Heads for ...f5.} Qd2 f5 O-O-O Nd7 {Opposite sides again: Black's play is on the kingside and in the centre.}" },
      { title: "Against the Fianchetto", intro: "White fianchettoes too. Black's ...e5 and ...c6 create pressure in the centre.",
        line: "d4 Nf6 c4 g6 Nf3 Bg7 g3 O-O Bg2 d6 O-O Nbd7 {Supports ...e5.} Nc3 e5 {The central break, as always.} e4 {White claims the centre too.} c6 {Gives the queen b6 and prepares ...exd4 at the right moment.} h3 Qb6 {Pressure on d4 and b2.}" },
    ],
  },
  {
    id: "french", name: "French Defence", eco: "C00–C19", side: "black", level: "Intermediate",
    summary: "Solid and counterattacking: ...e6 and ...d5, then attack White's pawn chain from the side.",
    ideas: ["Attack the base of White's chain (d4) with ...c5 and ...Qb6.", "The light-squared bishop is often the problem piece: trade it or bring it out via d7.", "...f6 is the second lever against the e5 pawn.", "In the Winawer, Black gives up the dark-squared bishop to damage White's pawns."],
    chapters: [
      { title: "The Advance Variation", intro: "White locks the centre with e5. Black attacks d4 from every side.",
        line: "e4 e6 {Prepares ...d5 with a pawn behind it.} d4 d5 e5 {The Advance: White takes space and locks the centre.} c5 {Strike at the base of the chain.} c3 {Supports d4.} Nc6 {Another attacker for d4.} Nf3 Qb6 {Three pieces now aim at d4.} Be2 cxd4 {Open the c-file before White can keep the chain with c3.} cxd4 Nge7 {Heading for f5, where it adds a fourth attacker to d4.} Na3 Nf5 Nc2 Bb4+ {Forces the king to move: Bd2 would drop d4.} Kf1 {White's king loses the right to castle.}" },
      { title: "The Winawer", intro: "Pin, then take on c3: White's pawns are damaged, but the kingside is a target.",
        line: "e4 e6 d4 d5 Nc3 Bb4 {The Winawer: pin the knight that defends e4.} e5 c5 a3 Bxc3+ bxc3 {White has the bishop pair but doubled pawns.} Ne7 Qg4 {White goes after the g7 pawn.} Qc7 {Counterattack: Black hits c3 and e5.} Qxg7 Rg8 Qxh7 cxd4 {Black has given up the kingside pawns to break White's centre.} Ne2 Nbc6 f4 {A wild, double-edged position.}" },
      { title: "The Tarrasch", intro: "White's knight goes to d2. Black opens the centre with ...c5.",
        line: "e4 e6 d4 d5 Nd2 {The Tarrasch: the knight on d2 can't be pinned.} c5 {Open the centre at once.} exd5 Qxd5 {Taking back with the queen keeps the structure healthy.} Ngf3 cxd4 Bc4 {With tempo on the queen.} Qd6 O-O Nf6 Nb3 {Wins back the pawn on d4.} Nc6 Nbxd4 Nxd4 Nxd4 a6 {Stops Nb5 and Bb5. Black will develop with ...Qc7, ...Bd6 and ...O-O.}" },
    ],
  },
  {
    id: "english", name: "English Opening", eco: "A10–A39", side: "white", level: "Intermediate",
    summary: "1.c4: control d5 from the side, fianchetto the king's bishop, and play on the queenside.",
    ideas: ["c4 and Nc3 control d5; the bishop on g2 adds to it.", "Against ...e5 it's a Sicilian with an extra move for White.", "Plan: a3 and b4 to gain space on the queenside.", "Don't rush the centre: d3 and e4 only when they're useful."],
    chapters: [
      { title: "The Reversed Sicilian", intro: "Against 1...e5, White plays a Sicilian with an extra tempo.",
        line: "c4 {The English: controls d5 from the side.} e5 Nc3 {Another eye on d5.} Nf6 g3 {Prepares to fianchetto the bishop to g2, aiming down the long diagonal.} d5 cxd5 Nxd5 Bg2 {The bishop hits the knight on d5 and, behind it, b7.} Nb6 {Out of the bishop's line.} Nf3 {Hits e5.} Nc6 O-O {Castle, then start the queenside play.} Be7 d3 {Keeps the knights off e4 and prepares Be3.} O-O a3 {Prepares b4 to gain space on the queenside.}" },
      { title: "The Symmetrical English", intro: "Black copies White. The open d-file and the long diagonal decide the game.",
        line: "c4 c5 {The Symmetrical English: Black copies.} Nc3 Nc6 g3 {The fianchetto again.} g6 Bg2 Bg7 Nf3 Nf6 O-O O-O d4 {Opens the centre while Black's pieces mirror White's.} cxd4 Nxd4 {Recapture with the knight, keeping the centre open.} Nxd4 Qxd4 {The queen is centralised, but must watch for ...Ng4 or ...Be6 tricks.} d6 Qd3 {The queen steps back; the bishop on g2 now looks at b7.}" },
      { title: "The Botvinnik set-up", intro: "A grip on d5 with pawns on c4 and e4. White plays on the kingside later with f4.",
        line: "c4 e5 Nc3 Nc6 g3 g6 Bg2 Bg7 e4 {The Botvinnik: c4 and e4 clamp down on d5.} d6 Nge2 {The knight goes to e2 so the f-pawn can advance.} Nge7 {Keeps the f-pawn free.} d3 {Backs up e4 and the light squares.} O-O O-O {Both kings are safe; now the plans begin.} f5 {Black fights for the light squares; White answers with Nd5 or f4.}" },
    ],
  },
];

export const courseById = (id: string) => COURSES.find((c) => c.id === id);
