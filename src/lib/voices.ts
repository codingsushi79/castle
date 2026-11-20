import type { Personality, Temperament } from "./personalities";

/**
 * What opponents say during a game. Each event has lines for each temperament;
 * a personality can replace any of them with its own (Personality.lines).
 *
 * Placeholders: {name} the opponent, {opening}, {san} the move just played,
 * {best} the better move, {why} a short reason ("it leaves your knight on f6
 * undefended"), {piece} a piece name, {reply} the punishing reply.
 */
export type ChatEvent =
  | "hello" | "opening" | "leftBook"
  | "youBlunder" | "youMistake" | "youGood" | "youMissed"
  | "iBlundered" | "letOff"
  | "check" | "bigCapture" | "castle" | "promote"
  | "winning" | "losing" | "endgame"
  | "win" | "loss" | "draw" | "takeback" | "idle";

type Lines = Record<ChatEvent, string[]>;

const VOICES: Record<Temperament, Lines> = {
  cheerful: {
    hello: ["Hi! Let's play!", "Ooh, a game! I'll try my best.", "Good luck! Not too much luck though."],
    opening: ["Is this the {opening}? I think I've seen this one!", "The {opening}! I know the first few moves of this."],
    leftBook: ["Okay, I don't know what to do now. Let's see…", "That's all the moves I memorised."],
    youBlunder: ["Wait… can I just take that?", "Hmm, is your {piece} supposed to be there?", "Ooh, I think I see something!"],
    youMistake: ["Hmm, interesting move.", "Are you sure about that one?"],
    youGood: ["Whoa, nice move.", "Hey, that's a good one."],
    youMissed: ["Phew! I think you could have done something there.", "I got lucky there, didn't I?"],
    iBlundered: ["Oh no. Oh no no no.", "Oops! I didn't see that.", "Wait, that's mine! Was mine."],
    letOff: ["Phew, you didn't see it!", "Hehe, I got away with one."],
    check: ["Check! I love saying that.", "Check!"],
    bigCapture: ["Yum, a {piece}!", "I'll take that {piece}, thank you!"],
    castle: ["Castling! The king goes in his little house."],
    promote: ["A new queen! Can I have two?"],
    winning: ["Am I… winning? I think I'm winning!", "This is going really well!"],
    losing: ["Uh oh. This is going badly, isn't it?", "I'm in trouble, aren't I?"],
    endgame: ["Not many pieces left now."],
    win: ["I won?! I won! Thanks for the game!", "Yay! Good game!"],
    loss: ["You got me! Good game!", "Aww. Well played! Rematch?"],
    draw: ["A draw! Nobody loses. I like that."],
    takeback: ["Sure, take it back. I make mistakes too!"],
    idle: ["Hmm, what should I do…", "I'm thinking really hard.", "This is fun."],
  },
  careful: {
    hello: ["Good luck. Let's have a clean game.", "Ready when you are."],
    opening: ["The {opening}. I play this a lot.", "Ah, the {opening}. Familiar ground."],
    leftBook: ["Out of my preparation now.", "That's where my notes end."],
    youBlunder: ["I think that {piece} is loose.", "Hm. I'm going to have to check that twice."],
    youMistake: ["That gives me something to work with.", "Not the most accurate, I think."],
    youGood: ["Good move.", "That's precise."],
    youMissed: ["I was worried there for a moment.", "I think you had something better there."],
    iBlundered: ["I missed that. Careless of me.", "That was a mistake. Well spotted."],
    letOff: ["You let me off there.", "I got away with that one."],
    check: ["Check."],
    bigCapture: ["I'll take the {piece}."],
    castle: ["Castling. King safety first."],
    promote: ["Promoting."],
    winning: ["I should be better here. Careful now.", "Steady. No need to rush."],
    losing: ["This is difficult for me.", "I need to hold this together."],
    endgame: ["An endgame. Let's be precise."],
    win: ["Good game. Thanks for playing.", "Thank you for the game."],
    loss: ["Well played. You deserved that.", "Good game. I'll learn from it."],
    draw: ["A fair result, I think."],
    takeback: ["All right, go ahead."],
    idle: ["Let me think about this.", "Hmm."],
  },
  showman: {
    hello: ["Let's give the audience a show!", "I hope you like fireworks."],
    opening: ["The {opening}! Bold choice. I approve.", "Ah, the {opening}. Things are about to get exciting."],
    leftBook: ["Now we're improvising!", "No more theory. Just chess."],
    youBlunder: ["Ohh, you shouldn't have done that.", "A gift! For me?"],
    youMistake: ["Interesting… very interesting.", "Bold. Not good, but bold."],
    youGood: ["Ha! You saw it. Nicely done.", "Oh, that's a good move. Annoying, but good."],
    youMissed: ["You missed your chance! The show goes on.", "Ha! You had me and you let me go."],
    iBlundered: ["Ah. That wasn't part of the plan.", "Well, every show has a mishap."],
    letOff: ["And the magician escapes!", "Ta-da! Still alive."],
    check: ["Check! Feel the pressure?", "Check!"],
    bigCapture: ["Your {piece}! Lovely.", "Thank you for the {piece}."],
    castle: ["Tucking the king away before the fun starts."],
    promote: ["A new queen enters the stage!"],
    winning: ["Now this is my kind of position.", "The attack is coming. Can you feel it?"],
    losing: ["Not my best performance so far.", "I still have a trick or two."],
    endgame: ["The endgame. Less fun, but still."],
    win: ["And that's the show! Thanks for playing.", "Bravo! For me, I mean. Good game!"],
    loss: ["You win this one. Encore?", "A great game. I tip my hat."],
    draw: ["A draw. The crowd wanted more."],
    takeback: ["A second take? Fine, fine."],
    idle: ["What's the most exciting move here…", "Hmm, sacrifices, sacrifices…"],
  },
  intense: {
    hello: ["Let's play.", "I'm here to win. Good luck."],
    opening: ["The {opening}. I know it well.", "{opening}. Fine."],
    leftBook: ["Out of book. Now we fight."],
    youBlunder: ["That's a mistake.", "You'll regret that."],
    youMistake: ["Inaccurate.", "That's not the move."],
    youGood: ["Strong.", "Good move."],
    youMissed: ["You missed it.", "That was your chance."],
    iBlundered: ["Bad move from me.", "I overlooked that."],
    letOff: ["Lucky for me.", "You didn't see it."],
    check: ["Check."],
    bigCapture: ["Taking the {piece}."],
    castle: ["Castling."],
    promote: ["Queen."],
    winning: ["This is winning.", "It's going my way."],
    losing: ["I'm not done yet.", "I'll keep fighting."],
    endgame: ["Endgame."],
    win: ["Good game.", "Well fought."],
    loss: ["Well played. Next time.", "You earned that."],
    draw: ["A draw."],
    takeback: ["Once."],
    idle: ["…", "Focus."],
  },
  dry: {
    hello: ["Good luck.", "Let us begin."],
    opening: ["The {opening}. A respectable choice.", "{opening}. Well-trodden territory."],
    leftBook: ["We have left theory."],
    youBlunder: ["That rather loses something.", "I suspect you'll want that one back."],
    youMistake: ["Slightly imprecise.", "A small concession."],
    youGood: ["Accurate.", "The right idea."],
    youMissed: ["There was more in the position.", "You let that chance pass."],
    iBlundered: ["An oversight on my part.", "That was poor of me."],
    letOff: ["You didn't take your chance.", "I'll take the reprieve."],
    check: ["Check."],
    bigCapture: ["The {piece}, then."],
    castle: ["Castling."],
    promote: ["Promotion."],
    winning: ["The position should be mine now.", "This is technique from here."],
    losing: ["I'm worse. Let's see how much.", "Difficult."],
    endgame: ["An endgame. My favourite part."],
    win: ["Good game.", "Thank you for the game."],
    loss: ["Well played. A deserved result.", "You played that well."],
    draw: ["A draw. Fair enough."],
    takeback: ["Very well."],
    idle: ["Hm.", "Let me see."],
  },
  machine: {
    hello: ["Ready."], opening: ["{opening}."], leftBook: [], youBlunder: [], youMistake: [], youGood: [], youMissed: [],
    iBlundered: [], letOff: [], check: [], bigCapture: [], castle: [], promote: [], winning: [], losing: [], endgame: [],
    win: ["1-0." /* replaced by the result */], loss: ["Well played."], draw: ["½-½."], takeback: ["Taking back."], idle: [],
  },
  coach: {
    hello: ["Hi! I'll talk you through the game as we play. Ask for a hint any time.", "Let's play. Think about every move before you make it, and I'll tell you what I see."],
    opening: ["This is the {opening}.", "We're in the {opening}. Remember the ideas, not just the moves."],
    leftBook: ["That's the end of the opening theory I wanted to show you. Now make a plan.", "We're out of the opening. Finish developing, and check your king is safe."],
    youBlunder: ["Careful! {why} {best} was better.", "That's a blunder. {why} Look at {best} instead.", "Stop and check that one. {why} {best} was the move."],
    youMistake: ["Not the best. {why} {best} was stronger.", "A small slip. {why} {best} was more accurate.", "{best} was more accurate there."],
    youGood: ["Good move! That's what I would have played.", "Exactly right.", "Well found!"],
    youMissed: ["You had something better there: {best}. {why}", "Did you see {best}? {why}"],
    iBlundered: ["Well spotted! I left that open, and you found it.", "Yes, you punished my mistake. That's how you do it."],
    letOff: ["I made a mistake on my last move. Can you see what you could have done? It was {best}.", "My last move was a mistake. {best} would have taken advantage of it."],
    check: ["Check. Look for all three ways out: move the king, block, or take the checking piece."],
    bigCapture: ["I'm taking your {piece}."],
    castle: ["I'm castling: my king is safer, and my rook comes towards the centre."],
    promote: ["Promotion! A pawn that reaches the last rank becomes a queen."],
    winning: ["I'm better now. Look for active moves and don't give me any more targets.", "Things are going my way. Try to make it as hard as possible for me."],
    losing: ["You're doing well. Now trade pieces and keep it simple.", "You're winning! Stay careful: check every capture and every check."],
    endgame: ["We've reached the endgame. Kings come out and fight now, and passed pawns matter most."],
    win: ["Good game! Let's look at it together in the analysis to see where it turned.", "That's the game. Well fought. Open it in analysis and check your mistakes."],
    loss: ["You won! Excellent. Review it anyway: there's always something to learn.", "Well played! You earned that one."],
    draw: ["A draw. A fair result."],
    takeback: ["Of course, try again. What did you miss?"],
    idle: ["Ask yourself: what is my opponent threatening?", "Before each move, check every capture and check you have.", "Which of your pieces is doing the least? Improve it."],
  },
};

/** One line for this opponent and event, with placeholders filled in, or undefined if it has nothing to say. */
export function line(p: Personality, event: ChatEvent, vars: Record<string, string> = {}, random = Math.random): string | undefined {
  const options = p.lines?.[event] ?? VOICES[p.temperament][event];
  if (!options?.length) return undefined;
  // Lines that need a value we don't have are skipped rather than shown half-filled.
  const usable = options.filter((t) => [...t.matchAll(/\{(\w+)\}/g)].every((m) => m[1] === "name" || vars[m[1]]));
  if (!usable.length) return undefined;
  const text = usable[Math.floor(random() * usable.length)];
  return text.replace(/\{(\w+)\}/g, (_, k) => (k === "name" ? p.name : vars[k]));
}
