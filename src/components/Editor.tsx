import { Button, Checkbox, Group, Modal, SegmentedControl, Stack, Text, TextInput } from "@mantine/core";
import { IconEraser } from "@tabler/icons-react";
import { useState } from "react";
import { Color, START_FEN, tryPosition } from "../lib/chess";
import { PieceImg } from "./Board";
import { boardColors, useApp } from "../lib/store";

const ROLES = ["king", "queen", "rook", "bishop", "knight", "pawn"] as const;
const LETTER: Record<string, string> = { king: "k", queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p" };
const ROLE_OF: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

/** 64 characters from a1 to h8, '.' for an empty square. */
function boardOf(fen: string): string[] {
  const out = new Array(64).fill(".");
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += parseInt(ch, 10);
      else out[(7 - r) * 8 + file++] = ch;
    }
  });
  return out;
}

function placement(board: string[]): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = "", empty = 0;
    for (let file = 0; file < 8; file++) {
      const ch = board[rank * 8 + file];
      if (ch === ".") empty++;
      else { if (empty) row += empty; empty = 0; row += ch; }
    }
    rows.push(row + (empty || ""));
  }
  return rows.join("/");
}

/** Places pieces by hand, either to analyse a position or to describe a pattern to search for. */
export function PositionEditor({ opened, onClose, purpose, initial, onDone }: { opened: boolean; onClose: () => void; purpose: "setup" | "pattern"; initial?: string; onDone: (fen: string, pattern: string) => void }) {
  const settings = useApp((s) => s.settings);
  const theme = boardColors(settings.boardTheme, settings);
  const [board, setBoard] = useState<string[]>(() => (purpose === "pattern" ? new Array(64).fill(".") : boardOf(initial ?? START_FEN)));
  const [turn, setTurn] = useState<Color>(initial?.split(" ")[1] === "b" ? "black" : "white");
  const [rights, setRights] = useState(initial?.split(" ")[2] ?? "KQkq");
  const [tool, setTool] = useState("P");
  const [flipped, setFlipped] = useState(false);
  const [fenText, setFenText] = useState("");
  const [painting, setPainting] = useState<string>();

  const castle = [...rights].filter((c) => "KQkq".includes(c)).join("") || "-";
  const fen = `${placement(board)} ${turn === "white" ? "w" : "b"} ${castle} - 0 1`;
  const legal = (() => {
    const pos = tryPosition(fen);
    return !!pos;
  })();

  const paint = (i: number, value: string) => setBoard((b) => (b[i] === value ? b : b.map((c, j) => (j === i ? value : c))));
  const down = (i: number) => {
    const value = tool === "." || board[i] === tool ? "." : tool;
    setPainting(value);
    paint(i, value);
  };

  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const rank = flipped ? r : 7 - r, file = flipped ? 7 - f : f;
      const i = rank * 8 + file, ch = board[i];
      squares.push(
        <div key={i} style={{ background: (rank + file) % 2 ? theme.light : theme.dark, display: "grid", placeItems: "center" }}
          onMouseDown={() => down(i)} onMouseEnter={() => painting !== undefined && paint(i, painting)}>
          {ch !== "." && <PieceImg role={ROLE_OF[ch.toLowerCase()]} color={ch === ch.toUpperCase() ? "white" : "black"} size={46} />}
        </div>,
      );
    }
  }

  const toggle = (c: string) => setRights((r) => (r.includes(c) ? r.replace(c, "") : r + c));

  return (
    <Modal opened={opened} onClose={onClose} size={760} title={<Text fw={700}>{purpose === "setup" ? "Set up a position" : "Search by pattern"}</Text>}>
      <Text size="sm" c="dimmed" mb="sm">
        {purpose === "setup" ? "Pick a piece, then click or drag across squares. Click a piece again to remove it." : "Place only the pieces that matter. Games where they all stood on these squares at once are found."}
      </Text>
      <Group align="flex-start" wrap="nowrap" onMouseUp={() => setPainting(undefined)} onMouseLeave={() => setPainting(undefined)}>
        <div style={{ display: "grid", gridTemplate: "repeat(8, 50px) / repeat(8, 50px)", borderRadius: 4, overflow: "hidden", flex: "none", cursor: "pointer" }}>{squares}</div>
        <Stack gap="xs" style={{ flex: 1 }}>
          {(["white", "black"] as Color[]).map((color) => (
            <Group gap={4} key={color}>
              {ROLES.map((role) => {
                const ch = color === "white" ? LETTER[role].toUpperCase() : LETTER[role];
                return (
                  <button key={role} className="pressable" onClick={() => setTool(ch)}
                    style={{ border: 0, borderRadius: 6, padding: 3, background: tool === ch ? "var(--mantine-primary-color-filled)" : "var(--bg-raised)" }}>
                    <PieceImg role={role} color={color} size={30} />
                  </button>
                );
              })}
            </Group>
          ))}
          <Group gap={6}>
            <Button variant={tool === "." ? "filled" : "default"} leftSection={<IconEraser size={14} />} onClick={() => setTool(".")}>Eraser</Button>
            <Button variant="default" onClick={() => { setBoard(boardOf(START_FEN)); setRights("KQkq"); setTurn("white"); }}>Start</Button>
            <Button variant="default" onClick={() => { setBoard(new Array(64).fill(".")); setRights(""); }}>Clear</Button>
            <Button variant="default" onClick={() => setFlipped(!flipped)}>Flip</Button>
          </Group>
          {purpose === "setup" && (
            <>
              <SegmentedControl value={turn} onChange={(v) => setTurn(v as Color)} data={[{ value: "white", label: "White to move" }, { value: "black", label: "Black to move" }]} />
              <Group gap="md">
                {[["K", "White O-O"], ["Q", "White O-O-O"], ["k", "Black O-O"], ["q", "Black O-O-O"]].map(([c, label]) => (
                  <Checkbox key={c} label={label} checked={rights.includes(c)} onChange={() => toggle(c)} />
                ))}
              </Group>
              <TextInput placeholder="Paste a FEN and press Return" value={fenText} onChange={(e) => setFenText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !tryPosition(fenText.trim())) return;
                  const parts = fenText.trim().split(" ");
                  setBoard(boardOf(parts[0]));
                  setTurn(parts[1] === "b" ? "black" : "white");
                  setRights(parts[2] ?? "");
                }} />
              {!legal && <Text size="xs" c="orange">Needs one king each, no pawns on the back ranks, and the side that just moved not in check.</Text>}
            </>
          )}
        </Stack>
      </Group>
      <Group justify="flex-end" mt="md">
        <Button variant="default" onClick={onClose}>Cancel</Button>
        <Button disabled={purpose === "setup" ? !legal : board.every((c) => c === ".")} onClick={() => { onDone(fen, board.join("")); onClose(); }}>
          {purpose === "setup" ? "Analyse" : "Search library"}
        </Button>
      </Group>
    </Modal>
  );
}
