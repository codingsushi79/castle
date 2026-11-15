import { Button, Group, Text } from "@mantine/core";
import { IconPin } from "@tabler/icons-react";
import { Slot, Line } from "../lib/analysis";
import { GameTree, GNode, materialBalance, scoreText, Score, winPercent } from "../lib/chess";
import { cachedEval } from "../lib/review";
import { useTree } from "../lib/store";
import { Board, MiniBoard } from "./Board";

const NAMES: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

function squares(fen: string): Map<string, string> {
  const out = new Map<string, string>();
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += parseInt(ch, 10);
      else out.set("abcdefgh"[f++] + (8 - r), ch);
    }
  });
  return out;
}

const describe = (ch: string) => `${ch === ch.toUpperCase() ? "White" : "Black"} ${NAMES[ch.toLowerCase()]}`;

/** What changed between two positions, as plain sentences. */
function changes(a: string, b: string): string[] {
  const from = squares(a), to = squares(b);
  const out: string[] = [];
  const gone = [...from].filter(([sq, p]) => to.get(sq) !== p);
  const came = [...to].filter(([sq, p]) => from.get(sq) !== p);
  const used = new Set<string>();
  for (const [sq, p] of gone) {
    const dest = came.find(([s2, p2]) => p2 === p && !used.has(s2));
    if (dest) {
      used.add(dest[0]);
      out.push(`${describe(p)} ${sq} → ${dest[0]}`);
    } else out.push(`${describe(p)} on ${sq} is gone`);
  }
  for (const [sq, p] of came) if (!used.has(sq)) out.push(`${describe(p)} appears on ${sq}`);
  return out;
}

const evalOf = (n: GNode): Score | undefined => n.eval ?? cachedEval(n.fen)?.s;

export function ComparePanel({ tree, pinned, onPin, slots, lines, running }: { tree: GameTree; pinned?: GNode; onPin: (n?: GNode) => void; slots: Slot[]; lines: Record<number, Line[]>; running: boolean }) {
  useTree(tree);
  const node = tree.current;
  const diff = pinned ? changes(pinned.fen, node.fen) : [];
  const highlight = (fen: string, other: string) => {
    const a = squares(fen), b = squares(other);
    const h: Record<string, string> = {};
    for (const sq of new Set([...a.keys(), ...b.keys()])) if (a.get(sq) !== b.get(sq)) h[sq] = "hl-blue";
    return h;
  };
  const e1 = pinned && evalOf(pinned), e2 = evalOf(node);
  const best = slots.map((s) => ({ slot: s, line: (lines[s.key] ?? [])[0] })).filter((x) => x.line);
  const spread = best.length > 1 ? Math.max(...best.map((b) => winPercent(b.line.score))) - Math.min(...best.map((b) => winPercent(b.line.score))) : 0;
  return (
    <div className="selectable">
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={6}>Two positions</Text>
      {!pinned ? (
        <>
          <Text size="sm" c="dimmed" mb={8}>Pin a position, then move anywhere in the game (or another line) to see what changed.</Text>
          <Button variant="light" leftSection={<IconPin size={14} />} onClick={() => onPin(node)}>Pin this position</Button>
        </>
      ) : (
        <>
          <Group gap={8} wrap="nowrap" align="flex-start">
            <div style={{ textAlign: "center" }}>
              <MiniBoard fen={pinned.fen} size={150} lastMove={pinned.lastMove} />
              <Text size="xs" mt={2}>Pinned {pinned.numberLabel} {pinned.san || "start"}</Text>
              <Text size="xs" c="dimmed">{e1 ? scoreText(e1) : "no evaluation"} · material {materialBalance(pinned.fen) >= 0 ? "+" : ""}{materialBalance(pinned.fen)}</Text>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ width: 150, height: 150 }}><Board fen={node.fen} readOnly highlight={highlight(node.fen, pinned.fen)} /></div>
              <Text size="xs" mt={2}>Now {node.numberLabel} {node.san || "start"}</Text>
              <Text size="xs" c="dimmed">{e2 ? scoreText(e2) : "no evaluation"} · material {materialBalance(node.fen) >= 0 ? "+" : ""}{materialBalance(node.fen)}</Text>
            </div>
          </Group>
          {e1 && e2 && <Text size="sm" mt={8}>White's winning chances went from {winPercent(e1).toFixed(0)}% to {winPercent(e2).toFixed(0)}% ({winPercent(e2) - winPercent(e1) >= 0 ? "+" : ""}{(winPercent(e2) - winPercent(e1)).toFixed(0)}).</Text>}
          <Text size="sm" fw={600} mt={8}>{diff.length ? `${diff.length} change${diff.length === 1 ? "" : "s"}` : "Same piece placement"}</Text>
          {diff.slice(0, 14).map((d, i) => <Text key={i} size="sm" c="dimmed">{d}</Text>)}
          <Group gap={6} mt={8}>
            <Button variant="default" onClick={() => tree.go(pinned)}>Go to pinned</Button>
            <Button variant="default" onClick={() => onPin(node)}>Pin this one instead</Button>
            <Button variant="subtle" color="gray" onClick={() => onPin(undefined)}>Unpin</Button>
          </Group>
        </>
      )}
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt={18} mb={6}>Engines on this position</Text>
      {!running || best.length === 0 ? (
        <Text size="sm" c="dimmed">Start the engine, and add a second one from the engine menu, to compare their verdicts.</Text>
      ) : (
        <>
          {best.map(({ slot, line }) => (
            <Group key={slot.key} justify="space-between" wrap="nowrap" py={2}>
              <Text size="sm" truncate style={{ flex: 1 }}>{slot.name}</Text>
              <Text size="sm" ff="ui-rounded, system-ui">{line.san.split(" ").slice(0, 2).join(" ")}</Text>
              <Text size="sm" fw={700} w={60} ta="right">{scoreText(line.score)}</Text>
              <Text size="xs" c="dimmed" w={50} ta="right">d{line.depth}</Text>
            </Group>
          ))}
          {best.length > 1 && (
            <Text size="sm" mt={6} c={spread > 15 ? "orange" : "dimmed"}>
              {new Set(best.map((b) => b.line.first)).size === 1 ? "All engines agree on the best move." : "The engines disagree on the best move."}
              {" "}Their verdicts are {spread.toFixed(0)} points of winning chances apart.
            </Text>
          )}
        </>
      )}
    </div>
  );
}

