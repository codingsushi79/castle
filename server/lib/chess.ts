import { Chess } from "chessops/chess";
import { makeFen } from "chessops/fen";
import { parseUci } from "chessops/util";

export type Result = "1-0" | "0-1" | "1/2-1/2";
export interface Replay {
  ok: boolean;
  fen: string;
  turn: "white" | "black";
  ended?: { result: Result; reason: string };
}

/** Plays a game's moves from the start, checking each, and reports how it stands. */
export function replay(moves: string[]): Replay {
  const pos = Chess.default();
  const seen = new Map<string, number>();
  const key = () => makeFen(pos.toSetup()).split(" ").slice(0, 4).join(" ");
  seen.set(key(), 1);
  for (const uci of moves) {
    const m = parseUci(uci);
    if (!m || !pos.isLegal(m)) return { ok: false, fen: makeFen(pos.toSetup()), turn: pos.turn };
    pos.play(m);
    const k = key();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const fen = makeFen(pos.toSetup());
  let ended: Replay["ended"];
  if (pos.isCheckmate()) ended = { result: pos.turn === "white" ? "0-1" : "1-0", reason: "checkmate" };
  else if (pos.isStalemate()) ended = { result: "1/2-1/2", reason: "stalemate" };
  else if (pos.isInsufficientMaterial()) ended = { result: "1/2-1/2", reason: "insufficient material" };
  else if ((seen.get(key()) ?? 0) >= 3) ended = { result: "1/2-1/2", reason: "threefold repetition" };
  else if (pos.halfmoves >= 100) ended = { result: "1/2-1/2", reason: "fifty-move rule" };
  return { ok: true, fen, turn: pos.turn, ended };
}

/** Whether a side has any way left to checkmate: a flag against a bare king is a draw. */
export function canMate(moves: string[], color: "white" | "black"): boolean {
  const pos = Chess.default();
  for (const uci of moves) {
    const m = parseUci(uci);
    if (m && pos.isLegal(m)) pos.play(m);
  }
  return !pos.hasInsufficientMaterial(color);
}
