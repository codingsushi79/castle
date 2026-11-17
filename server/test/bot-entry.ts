export { chooseMove, BOTS } from "../lib/bot.js";
export { positionAfter } from "../lib/chess.js";
import { parseFen } from "chessops/fen";
import { Chess } from "chessops/chess";
export const positionFromFen = (fen: string) => Chess.fromSetup(parseFen(fen).unwrap()).unwrap();
