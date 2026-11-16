import { Button, Group, SegmentedControl, Text, Tooltip } from "@mantine/core";
import { IconEraser, IconHandStop } from "@tabler/icons-react";
import { Color, START_FEN, tryPosition } from "../lib/chess";
import { PieceImg } from "./Board";

/** Placing pieces by hand on the analysis board. */
export interface Placement {
  /** The FEN board part. */
  board: string;
  turn: Color;
  /** "move" drags pieces about; "." erases; a FEN letter places that piece. */
  tool: string;
}

const ROLES = ["king", "queen", "rook", "bishop", "knight", "pawn"] as const;
const LETTER: Record<string, string> = { king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p" };

export const EMPTY_BOARD = "8/8/8/8/8/8/8/8";

/** 64 characters from a1 to h8, '.' for an empty square. */
function squaresOf(board: string): string[] {
  const out = new Array(64).fill(".");
  board.split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += parseInt(ch, 10);
      else out[(7 - r) * 8 + file++] = ch;
    }
  });
  return out;
}

function boardOf(squares: string[]): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "", empty = 0;
    for (let file = 0; file < 8; file++) {
      const ch = squares[rank * 8 + file];
      if (ch === ".") empty++;
      else { if (empty) row += empty; empty = 0; row += ch; }
    }
    rows.push(row + (empty || ""));
  }
  return rows.join("/");
}

const index = (square: string) => (square.charCodeAt(1) - 49) * 8 + (square.charCodeAt(0) - 97);

/**
 * Applies the current tool to a square. The first square of a stroke decides
 * whether the stroke places or erases: starting on the same piece removes it.
 */
export function paint(p: Placement, square: string, start: boolean, erasing: boolean): { board: string; erasing: boolean } {
  const sq = squaresOf(p.board);
  const i = index(square);
  if (start) erasing = p.tool === "." || sq[i] === p.tool;
  const value = erasing ? "." : p.tool;
  // Only one king of each colour: placing a king moves it.
  if (!erasing && (value === "K" || value === "k")) for (let j = 0; j < 64; j++) if (sq[j] === value) sq[j] = ".";
  sq[i] = value;
  return { board: boardOf(sq), erasing };
}

/** Castling rights that the placement allows: king and rook on their home squares. */
function castlingOf(board: string): string {
  const sq = squaresOf(board);
  let out = "";
  if (sq[4] === "K") { if (sq[7] === "R") out += "K"; if (sq[0] === "R") out += "Q"; }
  if (sq[60] === "k") { if (sq[63] === "r") out += "k"; if (sq[56] === "r") out += "q"; }
  return out || "-";
}

export const placementFen = (p: Placement) => `${p.board} ${p.turn === "white" ? "w" : "b"} ${castlingOf(p.board)} - 0 1`;

/** Why the placement is not a position Castle can analyse, or undefined when it is. */
export function placementProblem(p: Placement): string | undefined {
  const sq = squaresOf(p.board);
  const count = (c: string) => sq.filter((x) => x === c).length;
  if (count("K") !== 1 || count("k") !== 1) return "Each side needs exactly one king.";
  if ([...sq.slice(0, 8), ...sq.slice(56)].some((c) => c === "P" || c === "p")) return "Pawns can't stand on the first or last rank.";
  if (!tryPosition(placementFen(p))) return `The side not to move is in check: it would be ${p.turn === "white" ? "White" : "Black"}'s king that was just captured.`;
  return undefined;
}

export function PlacementBar({ p, onChange, onDone, onCancel }: { p: Placement; onChange: (p: Placement) => void; onDone: (fen: string) => void; onCancel: () => void }) {
  const problem = placementProblem(p);
  const tool = (value: string, label: string, child: React.ReactNode) => (
    <Tooltip label={label} openDelay={400} key={value}>
      <button className="pressable placement-tool" data-on={p.tool === value || undefined} onClick={() => onChange({ ...p, tool: value })}>{child}</button>
    </Tooltip>
  );
  return (
    <div className="placement-bar">
      <Group gap={4} wrap="nowrap" justify="center">
        {tool("move", "Move pieces (drag off the board to remove)", <IconHandStop size={22} />)}
        {(["white", "black"] as Color[]).flatMap((color) =>
          ROLES.map((role) => {
            const ch = color === "white" ? LETTER[role].toUpperCase() : LETTER[role];
            return tool(ch, `${color === "white" ? "White" : "Black"} ${role}`, <PieceImg role={role} color={color} size={26} />);
          }),
        )}
        {tool(".", "Eraser", <IconEraser size={20} />)}
      </Group>
      <Group gap={6} justify="center" mt={8} wrap="wrap">
        <SegmentedControl size="xs" value={p.turn} onChange={(v) => onChange({ ...p, turn: v as Color })} data={[{ value: "white", label: "White to move" }, { value: "black", label: "Black to move" }]} />
        <Button size="xs" variant="default" onClick={() => onChange({ ...p, board: START_FEN.split(" ")[0], turn: "white" })}>Start position</Button>
        <Button size="xs" variant="default" onClick={() => onChange({ ...p, board: EMPTY_BOARD })}>Clear</Button>
        <Button size="xs" variant="default" onClick={onCancel}>Cancel</Button>
        <Button size="xs" disabled={!!problem} onClick={() => onDone(placementFen(p))}>Analyse this position</Button>
      </Group>
      <Text size="xs" c={problem ? "orange" : "dimmed"} ta="center" mt={6}>
        {problem ?? `Castling is allowed where king and rook stand on their home squares (${castlingOf(p.board)}).`}
      </Text>
    </div>
  );
}
