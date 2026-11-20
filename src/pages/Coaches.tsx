import { Badge, Button, Group, Progress, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconArrowLeft, IconBook2, IconCheck, IconPlayerPlayFilled, IconRefresh, IconSchool, IconTargetArrow } from "@tabler/icons-react";
import { parseSan } from "chessops/san";
import type { Move } from "chessops/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { Board } from "../components/Board";
import { Avatar } from "../components/CoachChat";
import { Panel } from "../components/common";
import { fenOf, GameTree, positionOf, START_FEN, uciOf } from "../lib/chess";
import { Course, CourseMove, courseById, parseLine } from "../lib/courses";
import { COACHES, Personality } from "../lib/personalities";
import { usePlay } from "../lib/play";
import { useRepertoire } from "../lib/repertoire";
import { Sound } from "../lib/sound";
import { load, save } from "../lib/storage";
import { useApp } from "../lib/store";

/** Which chapters of each course you've worked through, and which you've drilled without a slip. */
type CourseProgress = Record<string, { learned: number[]; mastered: number[] }>;
const progressOf = (): CourseProgress => load<CourseProgress>("courseProgress", {});
function mark(courseId: string, chapter: number, kind: "learned" | "mastered") {
  const all = progressOf();
  const p = all[courseId] ?? { learned: [], mastered: [] };
  if (!p[kind].includes(chapter)) p[kind] = [...p[kind], chapter];
  if (kind === "mastered" && !p.learned.includes(chapter)) p.learned = [...p.learned, chapter];
  save("courseProgress", { ...all, [courseId]: p });
}

const coachOf = (course: Course) => COACHES.find((c) => c.coach!.courses.includes(course.id))!;

/** Starts a game against a coach, following a course's lines if one is given. */
function playCoach(coach: Personality, courseId = "") {
  const play = usePlay.getState();
  play.backToSetup();
  play.setCustomStart(undefined);
  play.patch({ opponent: "persona", personaId: coach.id, courseId, rules: "chess", chess960: false });
  useApp.getState().go("play");
}

function addToRepertoire(course: Course) {
  const tree = new GameTree(START_FEN);
  for (const ch of course.chapters) {
    tree.toStart();
    for (const m of parseLine(ch.line)) {
      const move = parseSan(tree.pos, m.san);
      if (!move || !tree.play(move)) break;
    }
  }
  useRepertoire.getState().importTree(tree, course.side);
  notifications.show({ message: `The ${course.name} is in your ${course.side === "white" ? "White" : "Black"} repertoire.`, autoClose: 2500 });
}

export default function CoachesPage() {
  const [open, setOpen] = useState<{ course: string; chapter: number; mode: "learn" | "drill" }>();
  const course = open && courseById(open.course);
  if (open && course) return <Lesson key={`${open.course}-${open.chapter}-${open.mode}`} course={course} chapter={open.chapter} mode={open.mode} onOpen={(chapter, mode) => setOpen({ course: course.id, chapter, mode })} onClose={() => setOpen(undefined)} />;
  return <Overview onOpen={(c, chapter, mode) => setOpen({ course: c, chapter, mode })} />;
}

function Overview({ onOpen }: { onOpen: (course: string, chapter: number, mode: "learn" | "drill") => void }) {
  const progress = progressOf();
  return (
    <div className="page scroll">
      <div style={{ maxWidth: 900, width: "100%" }} className="stagger">
        <Group gap={10} mb={4}><IconSchool size={22} /><Text fw={800} size="xl">Coaches</Text></Group>
        <Text c="dimmed" mb="md">Each coach teaches two openings move by move, then plays you in them and talks you through the game. You choose how strongly they play.</Text>
        {COACHES.map((coach) => (
          <Panel key={coach.id}>
            <Group gap={12} wrap="nowrap" align="flex-start">
              <Avatar p={coach} size={46} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Group justify="space-between" wrap="nowrap">
                  <div>
                    <Text fw={800}>{coach.name}</Text>
                    <Text size="sm" c="dimmed">{coach.coach!.title}</Text>
                  </div>
                  <Button variant="default" leftSection={<IconPlayerPlayFilled size={14} />} onClick={() => playCoach(coach)}>Play {coach.name.replace("Coach ", "")}</Button>
                </Group>
                <Text size="sm" mt={6}>{coach.coach!.bio}</Text>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8, marginTop: 10 }}>
                  {coach.coach!.courses.map((id) => {
                    const c = courseById(id)!;
                    const p = progress[id] ?? { learned: [], mastered: [] };
                    const next = c.chapters.findIndex((_, i) => !p.learned.includes(i));
                    return (
                      <div key={id} style={{ padding: 10, borderRadius: 8, background: "var(--bg-raised)" }}>
                        <Group justify="space-between" wrap="nowrap">
                          <Text fw={700}>{c.name}</Text>
                          <Badge variant="light" color={c.side === "white" ? "gray" : "dark"}>{c.side === "white" ? "White" : "Black"}</Badge>
                        </Group>
                        <Text size="xs" c="dimmed">{c.eco} · {c.level}</Text>
                        <Text size="sm" mt={4}>{c.summary}</Text>
                        <Progress mt={8} size="sm" value={(p.mastered.length / c.chapters.length) * 100} />
                        <Text size="xs" c="dimmed" mt={2}>{p.learned.length} of {c.chapters.length} chapters learned, {p.mastered.length} drilled</Text>
                        <Group gap={6} mt={8}>
                          <Button size="xs" leftSection={<IconBook2 size={14} />} onClick={() => onOpen(id, next < 0 ? 0 : next, "learn")}>{next < 0 ? "Review" : p.learned.length ? "Continue" : "Learn"}</Button>
                          <Button size="xs" variant="default" leftSection={<IconTargetArrow size={14} />} disabled={!p.learned.length}
                            onClick={() => { const pool = c.chapters.map((_, i) => i).filter((i) => p.learned.includes(i)); onOpen(id, pool[Math.floor(Math.random() * pool.length)], "drill"); }}>Drill</Button>
                          <Button size="xs" variant="default" leftSection={<IconPlayerPlayFilled size={14} />} onClick={() => playCoach(coach, id)}>Play it</Button>
                        </Group>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Group>
          </Panel>
        ))}
      </div>
    </div>
  );
}

/**
 * One chapter: the coach plays the other side's moves and explains each one.
 * Learning shows your move with an arrow; drilling asks you to remember it.
 */
function Lesson({ course, chapter, mode, onOpen, onClose }: { course: Course; chapter: number; mode: "learn" | "drill"; onOpen: (chapter: number, mode: "learn" | "drill") => void; onClose: () => void }) {
  const coach = coachOf(course);
  const ch = course.chapters[chapter];
  const moves: CourseMove[] = useMemo(() => parseLine(ch.line), [ch.line]);
  const fens = useMemo(() => {
    const out = [START_FEN];
    const pos = positionOf(START_FEN).clone();
    for (const m of moves) { const mv = parseSan(pos, m.san); if (!mv) break; pos.play(mv); out.push(fenOf(pos)); }
    return out;
  }, [moves]);
  const [ptr, setPtr] = useState(0);
  const [said, setSaid] = useState<string>(ch.intro);
  const [wrong, setWrong] = useState(0);
  const [slips, setSlips] = useState(0);
  const [lastMove, setLastMove] = useState<[string, string]>();
  const done = ptr >= moves.length;
  const yourTurn = !done && (ptr % 2 === 0) === (course.side === "white");
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const uciAt = (i: number) => {
    const pos = positionOf(fens[i]);
    const mv = parseSan(pos, moves[i].san);
    return mv ? uciOf(pos, mv, false) : "";
  };

  // The coach plays the other side's moves, with a pause to read what was said.
  useEffect(() => {
    if (done || yourTurn) return;
    timer.current = setTimeout(() => {
      const u = uciAt(ptr);
      Sound.forSan(moves[ptr].san);
      setLastMove([u.slice(0, 2), u.slice(2, 4)]);
      if (mode === "learn") setSaid(moves[ptr].say ? `${moves[ptr].san}: ${moves[ptr].say}` : `I'll play ${moves[ptr].san}.`);
      setPtr(ptr + 1);
    }, mode === "learn" ? (ptr === 0 ? 900 : 1100) : 450);
    return () => clearTimeout(timer.current);
  }, [ptr]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!done) return;
    mark(course.id, chapter, mode === "drill" && slips === 0 ? "mastered" : "learned");
    Sound.end();
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMove = (move: Move) => {
    if (!yourTurn) return;
    const pos = positionOf(fens[ptr]);
    const played = uciOf(pos, move, false);
    const expected = uciAt(ptr);
    if (played !== expected) {
      setWrong(wrong + 1);
      setSlips(slips + 1);
      Sound.error();
      setSaid(wrong === 0 ? `Not that one. ${mode === "drill" ? "Think about the plan: what does this opening want?" : "Follow the arrow."}` : `The move is ${moves[ptr].san}.`);
      return;
    }
    Sound.forSan(moves[ptr].san);
    setLastMove([played.slice(0, 2), played.slice(2, 4)]);
    setWrong(0);
    setSaid(mode === "learn" ? moves[ptr].say ?? "Right." : moves[ptr].say ? `Right. ${moves[ptr].say}` : "Right.");
    setPtr(ptr + 1);
  };

  const showArrow = yourTurn && (mode === "learn" || wrong >= 2);
  const arrowUci = showArrow ? uciAt(ptr) : "";
  const moveNumber = Math.floor(ptr / 2) + 1;

  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          <Board fen={fens[ptr]} orientation={course.side} movable={yourTurn ? course.side : undefined} lastMove={lastMove} onMove={onMove}
            arrows={arrowUci ? [{ from: arrowUci.slice(0, 2), to: arrowUci.slice(2, 4), color: mode === "learn" ? "paleGreen" : "green" }] : undefined}
            hint={yourTurn && mode === "drill" && wrong === 1 ? uciAt(ptr).slice(0, 2) : undefined} />
        </div>
      </div>
      <div className="sidecol wide">
        <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
          <Button variant="subtle" color="gray" size="xs" leftSection={<IconArrowLeft size={14} />} onClick={onClose}>All coaches</Button>
          <Text fw={800} size="lg" mt={4}>{course.name}</Text>
          <Text size="sm" c="dimmed">Chapter {chapter + 1} of {course.chapters.length}: {ch.title} · {mode === "learn" ? "Learning" : "Drill"}</Text>
          <Progress mt={8} size="sm" value={(ptr / moves.length) * 100} />
        </div>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10, flex: 1, overflowY: "auto" }}>
          <Group gap={10} wrap="nowrap" align="flex-start">
            <Avatar p={coach} size={36} />
            <div className="speech" style={{ flex: 1 }}>
              {said || (yourTurn ? "Your move." : "…")}
            </div>
          </Group>
          {!done && (
            <Text size="sm" fw={600}>
              {yourTurn ? (mode === "learn" ? `Play ${moves[ptr].san}, as the arrow shows.` : `${course.side === "white" ? "White" : "Black"} to play, move ${moveNumber}. What does the course play here?`) : `${coach.name} is playing…`}
            </Text>
          )}
          {done && (
            <>
              <Group gap={6}><IconCheck size={18} color="var(--mantine-color-green-5)" /><Text fw={700}>{mode === "drill" ? (slips === 0 ? "Perfect: chapter mastered." : `Done, with ${slips} slip${slips === 1 ? "" : "s"}. Drill it again to master it.`) : "Chapter learned."}</Text></Group>
              {chapter === course.chapters.length - 1 && mode === "learn" && (
                <div>
                  <Text size="sm" fw={700} mb={4}>Remember</Text>
                  {course.ideas.map((idea) => <Text key={idea} size="sm" mb={2}>• {idea}</Text>)}
                </div>
              )}
              <Group gap={6}>
                {chapter + 1 < course.chapters.length && <Button size="sm" onClick={() => onOpen(chapter + 1, mode)}>Next chapter</Button>}
                <Button size="sm" variant={chapter + 1 < course.chapters.length ? "default" : "filled"} leftSection={<IconTargetArrow size={14} />} onClick={() => onOpen(chapter, "drill")}>Drill this chapter</Button>
                <Button size="sm" variant="default" leftSection={<IconPlayerPlayFilled size={14} />} onClick={() => playCoach(coach, course.id)}>Play it against {coach.name.replace("Coach ", "")}</Button>
              </Group>
            </>
          )}
        </div>
        <div style={{ padding: 12, borderTop: "1px solid var(--border)" }}>
          <Group gap={6}>
            <Button size="xs" variant="default" leftSection={<IconRefresh size={14} />} onClick={() => onOpen(chapter, mode)}>Restart</Button>
            <Button size="xs" variant="default" leftSection={<IconBook2 size={14} />} onClick={() => addToRepertoire(course)}>Add to my repertoire</Button>
          </Group>
          <Group gap={4} mt={8}>
            {course.chapters.map((c, i) => (
              <Button key={c.title} size="compact-xs" variant={i === chapter ? "filled" : "subtle"} color={i === chapter ? undefined : "gray"} onClick={() => onOpen(i, "learn")}>{i + 1}. {c.title}</Button>
            ))}
          </Group>
        </div>
      </div>
    </div>
  );
}

