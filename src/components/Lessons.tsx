import { Badge, Button, Group, Progress, Text } from "@mantine/core";
import { IconBulb, IconCheck, IconChevronRight, IconSchool } from "@tabler/icons-react";
import { makeSan } from "chessops/san";
import type { Move } from "chessops/types";
import { useEffect, useMemo, useState } from "react";
import { Color, fenOf, moveFromUci, positionOf, turnOf, uciOf } from "../lib/chess";
import { Lesson, LESSONS, Step, useLessonProgress } from "../lib/lessons";
import { usePuzzles } from "../lib/puzzles";
import { Sound } from "../lib/sound";
import { Board } from "./Board";
import { Panel } from "./common";
import { Markdown } from "./WhatsNew";

/** A practice puzzle as a lesson step: the opponent's setup move, then the solution. */
interface Item extends Step { practice?: boolean; rating?: number }

function practiceFor(lesson: Lesson, all: { fen: string; moves: string[]; rating: number; themes: string[] }[]): Item[] {
  const { themes, count, maxRating } = lesson.practice;
  const pool = all.filter((p) => p.rating <= maxRating && themes.some((t) => p.themes.includes(t))).sort((a, b) => a.rating - b.rating);
  const start = Math.floor(Math.random() * Math.max(1, Math.min(pool.length - count, count * 2)));
  return pool.slice(start, start + count).map((p) => ({
    fen: p.fen, setup: p.moves[0], moves: p.moves.slice(1), practice: true, rating: p.rating,
    prompt: `${turnOf(p.fen) === "white" ? "Black" : "White"} to move. Practice: find the best move.`, done: "Solved.",
  }));
}

/** The lessons list, and a lesson being worked through. */
export function LearnPage({ toolbar }: { toolbar: React.ReactNode }) {
  const progress = useLessonProgress();
  const puzzles = usePuzzles();
  const [lesson, setLesson] = useState<Lesson>();
  const [phase, setPhase] = useState<"intro" | "items" | "done">("intro");
  const [items, setItems] = useState<Item[]>([]);
  const [index, setIndex] = useState(0);
  const [fen, setFen] = useState("8/8/8/8/8/8/8/8 w - - 0 1");
  const [lastMove, setLastMove] = useState<[string, string]>();
  const [ptr, setPtr] = useState(0);
  const [state, setState] = useState<"setup" | "solving" | "wrong" | "solved">("setup");
  const [hint, setHint] = useState<[string, string]>();
  const [shake, setShake] = useState(0);
  useEffect(() => { if (!puzzles.loaded) puzzles.load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const item = items[index];
  const userColor: Color = useMemo(() => (item ? (item.setup ? (turnOf(item.fen) === "white" ? "black" : "white") : turnOf(item.fen)) : "white"), [item]);

  const playOn = (from: string, uci: string) => {
    const pos = positionOf(from).clone();
    const m = moveFromUci(pos, uci);
    if (!m) return from;
    Sound.forSan(makeSan(pos, m));
    pos.play(m);
    const u = uciOf(positionOf(from), m, false);
    setLastMove([u.slice(0, 2), u.slice(2, 4)]);
    return fenOf(pos);
  };

  // Each item starts from its position, with the opponent's setup move played for you.
  useEffect(() => {
    if (!item) return;
    setFen(item.fen); setLastMove(undefined); setPtr(0); setHint(undefined);
    if (!item.setup) { setState("solving"); return; }
    setState("setup");
    const t = setTimeout(() => { setFen(playOn(item.fen, item.setup!)); setState("solving"); }, 600);
    return () => clearTimeout(t);
  }, [item]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (l: Lesson) => { setLesson(l); setPhase("intro"); setIndex(0); setItems([...l.steps, ...practiceFor(l, puzzles.all)]); };

  const attempt = (move: Move) => {
    if (!item || state !== "solving") return;
    const pos = positionOf(fen);
    const uci = uciOf(pos, move, false);
    const played = pos.clone();
    played.play(move);
    const expected = item.moves[ptr];
    if (uci !== expected && !(moveFromUci(pos, expected) && JSON.stringify(moveFromUci(pos, expected)) === JSON.stringify(move)) && !played.isCheckmate()) {
      Sound.error();
      setState("wrong");
      setShake((n) => n + 1);
      setTimeout(() => setState("solving"), 700);
      return;
    }
    let next = playOn(fen, uci);
    setHint(undefined);
    if (ptr + 1 >= item.moves.length || played.isCheckmate()) {
      setFen(next); setState("solved"); Sound.success();
      return;
    }
    setFen(next);
    setState("setup");
    setTimeout(() => { next = playOn(next, item.moves[ptr + 1]); setFen(next); setPtr(ptr + 2); setState("solving"); }, 450);
  };

  const nextItem = () => {
    if (index + 1 < items.length) setIndex(index + 1);
    else { setPhase("done"); if (lesson) progress.markDone(lesson.id); Sound.end(); }
  };

  const groups = ["Checkmates", "Tactics", "Endgames"] as const;
  return (
    <div className="page">
      <div className="boardcol">
        {toolbar}
        <div className={"boardrow" + (shake ? " shake" : "")} key={shake}>
          <Board key={`${lesson?.id}-${index}`} fen={phase === "items" ? fen : "8/8/8/8/8/8/8/8 w - - 0 1"} orientation={userColor} lastMove={lastMove}
            movable={phase === "items" && state === "solving" ? userColor : undefined} onMove={attempt}
            shapes={hint ? [{ from: hint[0], to: hint[1], color: "green" }] : undefined} />
        </div>
      </div>
      <div className="sidecol wide stagger">
        {!lesson ? (
          <>
            <Panel title={<><IconSchool size={13} /> Lessons</>}>
              <Text size="sm" c="dimmed">Short lessons: an explanation, a worked example or two, then practice puzzles on the same idea. {progress.done.length} of {LESSONS.length} done.</Text>
              <Progress mt={8} size="sm" value={(progress.done.length / LESSONS.length) * 100} />
            </Panel>
            {groups.map((g) => (
              <Panel key={g} title={g} pad={false}>
                {LESSONS.filter((l) => l.group === g).map((l) => (
                  <div key={l.id} className="listrow" onClick={() => start(l)}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <Text size="sm" fw={600}>{l.title}</Text>
                      <Text size="xs" c="dimmed" truncate>{l.summary}</Text>
                    </div>
                    {progress.done.includes(l.id) ? <IconCheck size={16} color="var(--mantine-color-teal-6)" /> : <IconChevronRight size={16} />}
                  </div>
                ))}
              </Panel>
            ))}
          </>
        ) : (
          <>
            <Panel title={<><IconSchool size={13} /> {lesson.title}</>} right={<Button size="compact-xs" variant="subtle" onClick={() => setLesson(undefined)}>All lessons</Button>}>
              {phase === "intro" ? (
                <>
                  <Markdown text={lesson.intro} />
                  <Button mt="sm" fullWidth disabled={!items.length} onClick={() => setPhase("items")}>{lesson.steps.length ? "Show me" : "Practise"}</Button>
                  {!puzzles.loaded && <Text size="xs" c="dimmed" mt={4}>Loading practice puzzles…</Text>}
                </>
              ) : phase === "done" ? (
                <>
                  <Text fw={700} c="teal"><IconCheck size={16} style={{ verticalAlign: -3 }} /> Lesson complete</Text>
                  <Text size="sm" c="dimmed" mt={4}>Keep it fresh with more {lesson.title.toLowerCase()} puzzles under Rated, or pick the next lesson.</Text>
                  <Group gap={6} mt="sm">
                    <Button size="xs" onClick={() => { const i = LESSONS.indexOf(lesson); if (LESSONS[i + 1]) start(LESSONS[i + 1]); else setLesson(undefined); }}>Next lesson</Button>
                    <Button size="xs" variant="default" onClick={() => start(lesson)}>Again</Button>
                  </Group>
                </>
              ) : item && (
                <>
                  <Group justify="space-between" mb={6}>
                    <Badge variant="light" color={item.practice ? "orange" : "teal"}>{item.practice ? `Practice ${index - lesson.steps.length + 1} of ${items.length - lesson.steps.length}` : `Example ${index + 1} of ${lesson.steps.length}`}</Badge>
                    {item.rating && <Text size="xs" c="dimmed">rated {item.rating}</Text>}
                  </Group>
                  <Text size="sm" fw={600}>{state === "solved" ? item.done : state === "wrong" ? "Not that one. Have another look." : item.prompt}</Text>
                  <Progress mt={8} size="xs" value={((index + (state === "solved" ? 1 : 0)) / items.length) * 100} />
                  <Group gap={6} mt="sm">
                    {state === "solved" ? <Button size="xs" onClick={nextItem}>{index + 1 < items.length ? "Next" : "Finish"}</Button> : (
                      <>
                        <Button size="xs" variant="default" leftSection={<IconBulb size={14} />} disabled={state !== "solving"}
                          onClick={() => { const m = item.moves[ptr]; setHint([m.slice(0, 2), m.slice(2, 4)]); }}>Hint</Button>
                        <Button size="xs" variant="subtle" disabled={state !== "solving"}
                          onClick={() => { const m = moveFromUci(positionOf(fen), item.moves[ptr]); if (m) attempt(m); }}>Show me</Button>
                      </>
                    )}
                  </Group>
                </>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
