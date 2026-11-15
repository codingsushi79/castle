import { Button, Group, Progress, SegmentedControl, Select, Switch, Text } from "@mantine/core";
import { IconCheck, IconRefresh, IconX } from "@tabler/icons-react";
import { makeSan } from "chessops/san";
import type { Move } from "chessops/types";
import { useEffect, useMemo, useState } from "react";
import { logActivity } from "../lib/activity";
import { Color, fenOf, fullmoveOf, moveFromUci, positionOf, START_FEN, turnOf, uciOf } from "../lib/chess";
import { useOpenings } from "../lib/openings";
import { usePuzzles } from "../lib/puzzles";
import { Sound } from "../lib/sound";
import { load, save } from "../lib/storage";
import { Board } from "./Board";
import { Empty, Panel, Stat } from "./common";

const bump = (key: string, v: number) => {
  const best = load<Record<string, number>>("drillBest", {});
  if (v > (best[key] ?? 0)) save("drillBest", { ...best, [key]: v });
};

// MARK: Opening quiz

/** "Play the Najdorf main line": play both sides of a named opening from memory. */
export function OpeningQuiz() {
  const book = useOpenings();
  const [level, setLevel] = useState<string>(load("quizLevel", "common"));
  const [chosen, setChosen] = useState<string | null>(null);
  const [line, setLine] = useState<{ eco: string; name: string; moves: string[]; sans: string[] }>();
  const [step, setStep] = useState(0);
  const [fen, setFen] = useState(START_FEN);
  const [last, setLast] = useState<[string, string]>();
  const [misses, setMisses] = useState(0);
  const [shake, setShake] = useState(0);
  const [score, setScore] = useState({ right: 0, total: 0 });
  const [hint, setHint] = useState<string>();

  const pool = useMemo(() => {
    const all = book.all.filter((o) => o.moves.length >= 4);
    if (level === "common") return all.filter((o) => !o.name.includes(",") && o.moves.length <= 10);
    if (level === "deep") return all.filter((o) => o.moves.length >= 10);
    return all;
  }, [book.all, level]);

  const begin = (o?: typeof line) => {
    const pick = o ?? pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    setLine(pick);
    setStep(0);
    setFen(START_FEN);
    setLast(undefined);
    setMisses(0);
    setHint(undefined);
  };
  useEffect(() => { if (book.loaded && !line) begin(); /* eslint-disable-next-line */ }, [book.loaded]);

  const done = !!line && step >= line.moves.length;
  const onMove = (m: Move) => {
    if (!line || done) return;
    const pos = positionOf(fen).clone();
    const uci = uciOf(pos, m, false);
    if (uci !== line.moves[step]) {
      setMisses((n) => n + 1);
      setShake((n) => n + 1);
      Sound.error();
      if (misses >= 1) setHint(line.sans[step]);
      return;
    }
    const san = makeSan(pos, m);
    pos.play(m);
    Sound.forSan(san);
    setFen(fenOf(pos));
    setLast([uci.slice(0, 2), uci.slice(2, 4)]);
    setHint(undefined);
    const next = step + 1;
    setStep(next);
    if (next >= line.moves.length) {
      const clean = misses === 0;
      setScore((s) => ({ right: s.right + (clean ? 1 : 0), total: s.total + 1 }));
      logActivity("quiz", clean);
      if (clean) Sound.success();
    }
  };

  if (!book.loaded) return <Empty title="Loading openings…" />;
  return (
    <div className="page">
      <div className="boardcol">
        <div className={"boardrow" + (shake ? " shake" : "")} key={shake}>
          <Board fen={fen} lastMove={last} movable={done ? undefined : turnOf(fen)} onMove={onMove} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title="Opening quiz">
          <Text size="xs" c="dimmed">{line?.eco}</Text>
          <Text fw={700} size="lg">{line?.name}</Text>
          <Text size="sm" c="dimmed" mt={4}>Play both sides' moves of this line from memory.</Text>
          <Progress mt={10} value={line ? (step / line.moves.length) * 100 : 0} size="sm" />
          <Text size="xs" c="dimmed" mt={2}>Move {Math.min(step + 1, line?.moves.length ?? 0)} of {line?.moves.length}</Text>
          {hint && <Text mt={8} size="sm" c="orange">The book move is {hint}.</Text>}
          {done && (
            <Text mt={8} fw={700} c={misses ? "orange" : "green"}>
              {misses ? <IconX size={15} style={{ verticalAlign: -2 }} /> : <IconCheck size={15} style={{ verticalAlign: -2 }} />} {misses ? `Done, with ${misses} slip${misses === 1 ? "" : "s"}.` : "Perfect."}
            </Text>
          )}
          {done && <Text size="sm" c="dimmed" mt={4} ff="ui-rounded, system-ui">{line!.sans.map((s, i) => (i % 2 ? s : `${i / 2 + 1}. ${s}`)).join(" ")}</Text>}
        </Panel>
        <Panel>
          <Group grow gap={8}><Stat label="Perfect" value={score.right} /><Stat label="Played" value={score.total} /></Group>
        </Panel>
        <Panel title="Choose">
          <SegmentedControl fullWidth value={level} onChange={(v) => { setLevel(v); save("quizLevel", v); }} data={[{ value: "common", label: "Main openings" }, { value: "all", label: "All lines" }, { value: "deep", label: "Long lines" }]} />
          <Select mt={8} searchable clearable placeholder="Or pick one by name" value={chosen} limit={60}
            data={pool.map((o, i) => ({ value: String(i), label: `${o.eco} ${o.name}` }))}
            onChange={(v) => { setChosen(null); if (v) begin(pool[parseInt(v, 10)]); }} />
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12, display: "flex", gap: 8 }}>
          <Button style={{ flex: 1 }} variant="default" leftSection={<IconRefresh size={14} />} onClick={() => begin(line)}>Again</Button>
          <Button style={{ flex: 1 }} onClick={() => begin()}>{done ? "Next opening" : "Skip"}</Button>
        </div>
      </div>
    </div>
  );
}

// MARK: Calculation

interface Task {
  fen: string;
  line: string[]; // uci
  sans: string[];
  question: "square" | "check";
  piece?: { square: string; name: string };
  answer: string;
}

const NAMES: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

/** Builds a question about a line from a puzzle, played only in the head. */
function makeTask(fen: string, moves: string[], length: number): Task | undefined {
  const pos = positionOf(fen).clone();
  const line: string[] = [], sans: string[] = [];
  let lastTo = "";
  for (const u of moves.slice(0, length)) {
    const m = moveFromUci(pos, u);
    if (!m) return undefined;
    sans.push(makeSan(pos, m));
    line.push(u);
    pos.play(m);
    lastTo = u.slice(2, 4);
  }
  if (!line.length) return undefined;
  const end = fenOf(pos);
  // Ask about the piece that moved first, so it must be followed through the line.
  if (Math.random() < 0.7) {
    const first = line[0].slice(0, 2);
    let at = first;
    for (const u of line) if (u.slice(0, 2) === at) at = u.slice(2, 4);
    const start = positionOf(fen).board.get(parseSq(first));
    const now = pos.board.get(parseSq(at));
    if (start && now && start.role === now.role && start.color === now.color) {
      return { fen, line, sans, question: "square", piece: { square: first, name: `${start.color === "white" ? "White" : "Black"} ${NAMES[start.role === "knight" ? "n" : start.role[0]]} from ${first}` }, answer: at };
    }
  }
  return { fen, line, sans, question: "check", answer: pos.isCheckmate() ? "mate" : pos.isCheck() ? "check" : "none", piece: { square: lastTo, name: end } };
}

const parseSq = (s: string) => (s.charCodeAt(1) - 49) * 8 + (s.charCodeAt(0) - 97);

/** Read a line, keep the board in your head, and answer a question about the result. */
export function Calculation() {
  const puzzles = usePuzzles();
  const [length, setLength] = useState(2);
  const [task, setTask] = useState<Task>();
  const [result, setResult] = useState<{ ok: boolean; picked: string }>();
  const [streak, setStreak] = useState(0);
  const [hideBoard, setHideBoard] = useState<boolean>(load("calcHide", false));
  const best = load<Record<string, number>>("drillBest", {})["Calculation streak"] ?? 0;

  const next = () => {
    setResult(undefined);
    for (let i = 0; i < 50; i++) {
      const p = puzzles.all[Math.floor(Math.random() * puzzles.all.length)];
      if (!p || p.moves.length < length + 1) continue;
      const shown = positionOf(p.fen).clone();
      const first = moveFromUci(shown, p.moves[0]);
      if (!first) continue;
      shown.play(first);
      const t = makeTask(fenOf(shown), p.moves.slice(1), length);
      if (t) return setTask(t);
    }
  };
  useEffect(() => { if (puzzles.loaded && !task) next(); /* eslint-disable-next-line */ }, [puzzles.loaded]);

  const answer = (picked: string) => {
    if (!task || result) return;
    const ok = picked === task.answer;
    setResult({ ok, picked });
    logActivity("calculation", ok, length);
    if (ok) {
      Sound.success();
      const s = streak + 1;
      setStreak(s);
      bump("Calculation streak", s);
      if (s % 3 === 0 && length < 6) setLength(length + 1);
    } else {
      Sound.error();
      setStreak(0);
      if (length > 2) setLength(length - 1);
    }
  };

  const endFen = useMemo(() => {
    if (!task) return START_FEN;
    const pos = positionOf(task.fen).clone();
    task.line.forEach((u) => { const m = moveFromUci(pos, u); if (m) pos.play(m); });
    return fenOf(pos);
  }, [task]);

  if (!puzzles.loaded || !task) return <Empty title="Loading…" />;
  const orientation: Color = turnOf(task.fen);
  const showFen = result ? endFen : task.fen;
  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow" style={{ visibility: hideBoard && !result ? "hidden" : "visible" }}>
          <Board fen={showFen} orientation={orientation}
            highlight={result && task.question === "square" ? { [task.answer]: "hl-green", ...(result.ok ? {} : { [result.picked]: "hl-red" }) } : undefined}
            onSelect={task.question === "square" && !result ? (sq) => answer(sq) : undefined} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title="Calculation">
          <Text size="sm" c="dimmed">From this position, play through the line in your head. The board will not move.</Text>
          <Text mt={8} fw={700} size="lg" ff="ui-rounded, system-ui" className="selectable">
            {task.sans.map((s, i) => {
              // Number the moves as they would be in the game.
              const startWhite = orientation === "white";
              const white = (i % 2 === 0) === startWhite;
              const n = fullmoveOf(task.fen) + Math.floor((i + (startWhite ? 0 : 1)) / 2);
              return (white ? `${n}. ` : i === 0 ? `${n}… ` : "") + s + " ";
            })}
          </Text>
          <Text mt={10} fw={600}>
            {task.question === "square" ? `Where is the ${task.piece!.name} now? Click its square.` : "After the line, is the side to move in check?"}
          </Text>
          {task.question === "check" && !result && (
            <Group grow mt={8}>
              <Button variant="default" onClick={() => answer("none")}>No</Button>
              <Button variant="default" onClick={() => answer("check")}>Check</Button>
              <Button variant="default" onClick={() => answer("mate")}>Checkmate</Button>
            </Group>
          )}
          {result && (
            <Text mt={10} fw={700} c={result.ok ? "green" : "red"}>
              {result.ok ? "Right." : task.question === "square" ? `It ends on ${task.answer}.` : `The answer is ${task.answer === "none" ? "no check" : task.answer}.`} The board now shows the final position.
            </Text>
          )}
        </Panel>
        <Panel>
          <Group grow gap={8}><Stat label="Line length" value={length} /><Stat label="Streak" value={streak} /><Stat label="Best" value={best} /></Group>
          <Text size="xs" c="dimmed" mt={6}>Three right in a row makes the lines one move longer.</Text>
          <Switch mt={8} label="Hide the board while answering" checked={hideBoard} onChange={(e) => { setHideBoard(e.currentTarget.checked); save("calcHide", e.currentTarget.checked); }} />
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12 }}><Button fullWidth size="md" onClick={next}>{result ? "Next" : "Skip"}</Button></div>
      </div>
    </div>
  );
}
