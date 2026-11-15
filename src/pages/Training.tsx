import { Button, Group, Progress, SegmentedControl, Switch, Text } from "@mantine/core";
import { IconBook2, IconCalendar, IconCheck, IconCircle, IconPuzzle, IconRotate, IconTarget } from "@tabler/icons-react";
import type { Move } from "chessops/types";
import { useEffect, useRef, useState } from "react";
import { Board } from "../components/Board";
import { Calculation, OpeningQuiz } from "../components/TrainingExtra";
import { Empty, Panel, Stat } from "../components/common";
import { Color, fenOf, GameTree, GNode, moveFromUci, negate, positionOf, Score, turnOf, uciOf, winPercent } from "../lib/chess";
import { db } from "../lib/db";
import { launch, resolveEngine } from "../lib/engines";
import { tablebase } from "../lib/lichess";
import { dayNumber, usePuzzles } from "../lib/puzzles";
import { dueNodes, useRepertoire } from "../lib/repertoire";
import { Sound } from "../lib/sound";
import { load, save } from "../lib/storage";
import { useApp } from "../lib/store";
import { logActivity } from "../lib/activity";
import { Engine, searchOnce } from "../lib/uci";
import { makeSan } from "chessops/san";

export default function TrainingPage() {
  const app = useApp();
  const [tab, setTab] = useState<string>(load("trainingTab", "plan"));
  const [guessTree, setGuessTree] = useState<GameTree>();
  useEffect(() => {
    const t = app.takeIntent("guess") as GameTree | undefined;
    if (t) { setGuessTree(t); setTab("guess"); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="toolbar">
        <SegmentedControl value={tab} onChange={(v) => { setTab(v); save("trainingTab", v); }}
          data={[{ value: "plan", label: "Study plan" }, { value: "endgames", label: "Endgames" }, { value: "vision", label: "Board vision" }, { value: "guess", label: "Guess the move" }, { value: "openings", label: "Openings" }, { value: "calculation", label: "Calculation" }]} />
      </div>
      {tab === "plan" && <Plan onOpen={setTab} />}
      {tab === "endgames" && <Endgames />}
      {tab === "vision" && <Vision />}
      {tab === "guess" && <Guess initial={guessTree} />}
      {tab === "openings" && <OpeningQuiz />}
      {tab === "calculation" && <Calculation />}
    </>
  );
}

const bumpBest = (key: string, value: number) => {
  const best = load<Record<string, number>>("drillBest", {});
  if (value > (best[key] ?? 0)) save("drillBest", { ...best, [key]: value });
};

// MARK: Study plan

function Plan({ onOpen }: { onOpen: (tab: string) => void }) {
  const app = useApp();
  const p = usePuzzles();
  const r = useRepertoire();
  const today = dayNumber();
  const startOfDay = new Date().setHours(0, 0, 0, 0);
  const puzzlesToday = p.stats.ratingHistory.filter((h) => h.t >= startOfDay).length;
  const due = dueNodes(r.trees.white, "white", r.cards).length + dueNodes(r.trees.black, "black", r.cards).length;
  const endgameDone = load<number>("plan.endgameDay", 0) === today;
  const visionDone = load<number>("plan.visionDay", 0) === today;
  const hasRepertoire = r.trees.white.root.children.length + r.trees.black.root.children.length > 0;
  const items: { done: boolean; title: string; detail: string; icon: React.ReactNode; go: () => void; skip?: boolean }[] = [
    { done: p.stats.dailySolved.includes(today), title: "Daily puzzle", detail: "One puzzle, the same for everyone today.", icon: <IconCalendar size={18} />, go: () => app.go("puzzles", { kind: "daily" }) },
    { done: due === 0, skip: !hasRepertoire, title: hasRepertoire ? `Repertoire: ${due} position${due === 1 ? "" : "s"} due` : "Repertoire", detail: hasRepertoire ? "Positions come back just before you would forget them." : "Build a repertoire first; reviews then appear here.", icon: <IconBook2 size={18} />, go: () => app.go("repertoire") },
    { done: p.mistakes.length === 0, skip: p.mistakes.length === 0, title: `Your mistakes: ${p.mistakes.length} to fix`, detail: "Positions from your own reviewed games.", icon: <IconTarget size={18} />, go: () => { p.setMode("mistakes"); app.go("puzzles"); } },
    { done: puzzlesToday >= 5, title: `Rated puzzles: ${Math.min(5, puzzlesToday)} of 5`, detail: "Five puzzles at your level.", icon: <IconPuzzle size={18} />, go: () => { p.setMode("rated"); app.go("puzzles"); } },
    { done: endgameDone, title: "One endgame", detail: "Play a standard position out against perfect defence.", icon: <IconTarget size={18} />, go: () => onOpen("endgames") },
    { done: visionDone, title: "Board vision", detail: "A 30-second drill.", icon: <IconCircle size={18} />, go: () => onOpen("vision") },
  ];
  const active = items.filter((i) => !i.skip);
  const done = active.filter((i) => i.done).length;
  return (
    <div className="page scroll">
      <div style={{ maxWidth: 680 }} className="stagger">
        <Text fw={700} size="lg">Today's plan</Text>
        <Text c="dimmed" mb="sm">{done} of {active.length} done. About fifteen minutes in all.</Text>
        <Progress value={(done / Math.max(1, active.length)) * 100} mb="md" />
        {items.map((it) => (
          <div key={it.title} className="card pressable" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, opacity: it.skip ? 0.55 : 1 }} onClick={it.go}>
            <span style={{ color: it.done && !it.skip ? "#51cf66" : "#8b8f98" }}>{it.done && !it.skip ? <IconCheck size={20} /> : it.icon}</span>
            <div style={{ flex: 1 }}>
              <Text fw={600} td={it.done && !it.skip ? "line-through" : undefined}>{it.title}</Text>
              <Text size="xs" c="dimmed">{it.detail}</Text>
            </div>
            <Button variant={it.done ? "default" : "light"}>{it.done && !it.skip ? "Again" : "Start"}</Button>
          </div>
        ))}
      </div>
    </div>
  );
}

// MARK: Endgames against the tablebase

interface Endgame {
  name: string;
  fen: string;
  goal: "win" | "draw";
  level: string;
  note: string;
}

const ENDGAMES: Endgame[] = [
  { name: "Queen mate", fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1", goal: "win", level: "Basic", note: "Box the king in with the queen a knight's move away, then bring your king." },
  { name: "Rook mate", fen: "8/8/8/4k3/8/8/8/R3K3 w - - 0 1", goal: "win", level: "Basic", note: "Cut the king off rank by rank; use your king to take the opposition." },
  { name: "King in front of the pawn", fen: "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1", goal: "win", level: "Basic", note: "With the king on the sixth rank ahead of its pawn, the win is certain." },
  { name: "Hold with the opposition", fen: "4k3/8/8/4K3/4P3/8/8/8 b - - 0 1", goal: "draw", level: "Basic", note: "Step in front of the enemy king and never give up the opposition." },
  { name: "Rook pawn fortress", fen: "7k/8/7K/7P/8/8/8/8 b - - 0 1", goal: "draw", level: "Basic", note: "Stay in the corner. A rook pawn cannot win if the defender's king reaches it." },
  { name: "Escort the pawn", fen: "8/5k2/8/8/8/8/4PK2/8 w - - 0 1", goal: "win", level: "Club", note: "Lead with the king, not the pawn. Reach a key square before pushing." },
  { name: "Lucena position", fen: "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1", goal: "win", level: "Club", note: "Build a bridge: bring the rook to the fourth rank to shield your king from checks." },
  { name: "Philidor defence", fen: "3k4/R7/8/3PK3/8/8/8/1r6 b - - 0 1", goal: "draw", level: "Club", note: "Keep the rook on the sixth rank until the pawn advances, then check from behind." },
  { name: "Two bishops", fen: "8/8/8/4k3/8/8/8/2B1KB2 w - - 0 1", goal: "win", level: "Advanced", note: "Use the bishops side by side as a wall and drive the king to a corner." },
  { name: "Saavedra", fen: "8/8/1KP5/3r4/8/8/8/k7 w - - 0 1", goal: "win", level: "Advanced", note: "A famous study. Dodge the checks, then find the surprising promotion." },
  { name: "Bishop and knight", fen: "8/8/8/4k3/8/8/8/2B1K1N1 w - - 0 1", goal: "win", level: "Expert", note: "Force the king to the corner of your bishop's colour. Up to 33 moves with perfect play." },
];

function Endgames() {
  const [index, setIndex] = useState<number>(load("endgameIndex", 0));
  const eg = ENDGAMES[index];
  const [fen, setFen] = useState(eg.fen);
  const [last, setLast] = useState<[string, string]>();
  const [status, setStatus] = useState<"play" | "thinking" | "slip" | "won" | "lost" | "offline">("play");
  const [message, setMessage] = useState("");
  const [moves, setMoves] = useState(0);
  const [slips, setSlips] = useState(0);
  const [before, setBefore] = useState<string>();
  const user: Color = turnOf(eg.fen);
  const solved = load<Record<string, number>>("endgamesSolved", {});

  const reset = (i = index) => {
    setIndex(i);
    save("endgameIndex", i);
    setFen(ENDGAMES[i].fen);
    setLast(undefined);
    setStatus("play");
    setMessage("");
    setMoves(0);
    setSlips(0);
  };

  const succeed = (text: string) => {
    setStatus("won");
    setMessage(text);
    Sound.success();
    if (slips === 0) save("endgamesSolved", { ...solved, [eg.name]: (solved[eg.name] ?? 0) + 1 });
    save("plan.endgameDay", dayNumber());
    logActivity("endgame", slips === 0);
    bumpBest("Endgames mastered", Object.keys({ ...solved, ...(slips === 0 ? { [eg.name]: 1 } : {}) }).length);
  };

  const onMove = async (move: Move) => {
    if (status !== "play") return;
    const pos = positionOf(fen).clone();
    const uci = uciOf(pos, move, false);
    const san = makeSan(pos, move);
    const promoted = "promotion" in move && !!move.promotion;
    pos.play(move);
    const next = fenOf(pos);
    setBefore(fen);
    setFen(next);
    setLast([uci.slice(0, 2), uci.slice(2, 4)]);
    Sound.forSan(san);
    setMoves((m) => m + 1);
    if (pos.isCheckmate()) return succeed("Checkmate.");
    if (pos.isEnd()) return eg.goal === "draw" ? succeed("Drawn. You held it.") : (setStatus("lost"), setMessage("Stalemate: the win is gone."));
    setStatus("thinking");
    try {
      const tb = await tablebase(next);
      // The verdict is for the opponent, who is now to move.
      const ok = eg.goal === "win" ? tb.verdict === "loss" : tb.verdict !== "win";
      if (!ok) {
        setSlips((s) => s + 1);
        setStatus("slip");
        setMessage(eg.goal === "win" ? `${san} lets the win slip: with best play the game is now ${tb.verdict === "win" ? "lost" : "only a draw"}.` : `${san} loses: the opponent now wins by force.`);
        Sound.error();
        return;
      }
      if (eg.goal === "win" && promoted) return succeed("Promoted with a won position.");
      if (eg.goal === "draw" && moves + 1 >= 12) return succeed("Twelve accurate moves. The draw is secure.");
      // Perfect defence: the reply that holds out longest (or wins fastest).
      const best = [...tb.moves].sort((a, b) => rank(a.verdict) - rank(b.verdict) || (a.verdict === "win" ? Math.abs(a.dtm ?? a.dtz ?? 0) - Math.abs(b.dtm ?? b.dtz ?? 0) : Math.abs(b.dtm ?? b.dtz ?? 0) - Math.abs(a.dtm ?? a.dtz ?? 0)))[0];
      const reply = best && moveFromUci(pos, best.uci);
      if (!reply) return succeed("Done.");
      setTimeout(() => {
        const rsan = makeSan(pos, reply);
        pos.play(reply);
        setFen(fenOf(pos));
        setLast([best.uci.slice(0, 2), best.uci.slice(2, 4)]);
        Sound.forSan(rsan);
        if (pos.isCheckmate()) { setStatus("lost"); setMessage("Checkmated."); }
        else if (pos.isEnd()) eg.goal === "draw" ? succeed("Drawn. You held it.") : (setStatus("lost"), setMessage("Drawn: the win is gone."));
        else setStatus("play");
      }, 350);
    } catch {
      setStatus("offline");
      setMessage("The tablebase could not be reached. Check your connection and try again.");
    }
  };

  return (
    <div className="page">
      <div style={{ width: 250, flex: "none", borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflowY: "auto" }}>
        {ENDGAMES.map((e, i) => (
          <div key={e.name} className={"listrow" + (i === index ? " on" : "")} onClick={() => reset(i)}>
            <span style={{ color: solved[e.name] ? "#51cf66" : "#555" }}>{solved[e.name] ? <IconCheck size={15} /> : <IconCircle size={15} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" fw={600} truncate>{e.name}</Text>
              <Text size="xs" c="dimmed">{e.level} · {e.goal === "win" ? "win" : "hold the draw"}</Text>
            </div>
          </div>
        ))}
      </div>
      <div className="boardcol">
        <div className="boardrow">
          <Board key={eg.name} fen={fen} orientation={user} lastMove={last} movable={status === "play" ? user : undefined} onMove={onMove} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title={eg.name}>
          <Text fw={700}>{user === "white" ? "White" : "Black"} to {eg.goal === "win" ? "win" : "draw"}</Text>
          <Text size="sm" c="dimmed" mt={4}>{eg.note}</Text>
        </Panel>
        <Panel>
          <Group grow gap={8}><Stat label="Your moves" value={moves} /><Stat label="Slips" value={slips} color="#ff6b6b" /></Group>
          <Text mt={10} fw={600} c={status === "won" ? "green" : status === "slip" || status === "lost" ? "red" : undefined}>
            {status === "play" ? "Your move" : status === "thinking" ? "Checking with the tablebase…" : status === "won" ? "Success" : status === "slip" ? "Not quite" : status === "lost" ? "Failed" : "Offline"}
          </Text>
          {message && <Text size="sm" c="dimmed">{message}</Text>}
          <Text size="xs" c="dimmed" mt={8}>The opponent plays perfectly from the endgame tablebase, and every move of yours is checked against it.</Text>
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12, display: "flex", gap: 8 }}>
          {status === "slip" && before && <Button style={{ flex: 1 }} onClick={() => { setFen(before); setStatus("play"); setMessage(""); setLast(undefined); }}>Take it back</Button>}
          <Button style={{ flex: 1 }} variant="default" leftSection={<IconRotate size={14} />} onClick={() => reset()}>Restart</Button>
          {status === "won" && index < ENDGAMES.length - 1 && <Button style={{ flex: 1 }} onClick={() => reset(index + 1)}>Next</Button>}
        </div>
      </div>
    </div>
  );
}

const rank = (v: string) => (v === "win" ? 0 : v.includes("win") ? 1 : v === "draw" ? 2 : v.includes("loss") && v !== "loss" ? 3 : 4);

// MARK: Board vision

const FILES = "abcdefgh";
const randomSquare = () => FILES[Math.floor(Math.random() * 8)] + (1 + Math.floor(Math.random() * 8));
const isLight = (sq: string) => (FILES.indexOf(sq[0]) + parseInt(sq[1], 10)) % 2 === 1;

function knightDistance(from: string, to: string): number {
  const idx = (s: string) => [FILES.indexOf(s[0]), parseInt(s[1], 10) - 1];
  const [tx, ty] = idx(to);
  const seen = new Set([from]);
  let frontier = [idx(from)];
  for (let d = 0; d < 7; d++) {
    if (frontier.some(([x, y]) => x === tx && y === ty)) return d;
    const next: number[][] = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]]) {
        const nx = x + dx, ny = y + dy, name = FILES[nx] + (ny + 1);
        if (nx < 0 || nx > 7 || ny < 0 || ny > 7 || seen.has(name)) continue;
        seen.add(name);
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return 6;
}

type Drill = "find" | "colour" | "knight";
const DRILLS: Record<Drill, { name: string; help: string }> = {
  find: { name: "Find the square", help: "A square is named. Click it on a board with no coordinates." },
  colour: { name: "Light or dark", help: "Say the colour of the named square without looking at a board." },
  knight: { name: "Knight distance", help: "How many moves does the knight need to reach the marked square?" },
};

function Vision() {
  const app = useApp();
  const [drill, setDrill] = useState<Drill>("find");
  const [running, setRunning] = useState(false);
  const [left, setLeft] = useState(30);
  const [score, setScore] = useState(0);
  const [misses, setMisses] = useState(0);
  const [target, setTarget] = useState("e4");
  const [from, setFrom] = useState("b1");
  const [flash, setFlash] = useState<Record<string, string>>({});
  const [orientation, setOrientation] = useState<Color>("white");
  const best = load<Record<string, number>>("drillBest", {});

  const next = () => {
    let t = randomSquare(), f = randomSquare();
    while (t === f) f = randomSquare();
    setTarget(t);
    setFrom(f);
  };
  const start = () => { setScore(0); setMisses(0); setLeft(30); setRunning(true); setFlash({}); next(); };

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setLeft((l) => Math.max(0, l - 0.1)), 100);
    return () => clearInterval(t);
  }, [running]);
  useEffect(() => {
    if (running && left <= 0) {
      setRunning(false);
      Sound.end();
      bumpBest(DRILLS[drill].name, score);
      logActivity("vision", true, score);
      save("plan.visionDay", dayNumber());
    }
  }, [left, running, drill, score]);

  const answer = (ok: boolean, sq?: string) => {
    if (!running) return;
    if (ok) { setScore((s) => s + 1); Sound.move(); } else { setMisses((m) => m + 1); Sound.error(); }
    if (sq) { setFlash({ [sq]: ok ? "hl-green" : "hl-red", ...(ok ? {} : { [target]: "hl-blue" }) }); setTimeout(() => setFlash({}), 350); }
    next();
  };

  const kd = knightDistance(from, target);
  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          {drill === "colour" ? (
            <div style={{ flex: 1, display: "grid", placeItems: "center" }}><Text fz={140} fw={800} ff="ui-rounded, system-ui">{running ? target : "?"}</Text></div>
          ) : drill === "find" ? (
            <VisionBoard orientation={orientation} highlight={flash} onSelect={(sq) => answer(sq === target, sq)} />
          ) : (
            <Board fen={`8/8/8/8/8/8/8/8 w - - 0 1`.replace("8/8/8/8/8/8/8/8", knightFen(from))} orientation={orientation} highlight={{ [target]: "hl-green" }} />
          )}
        </div>
      </div>
      <div className="sidecol">
        <Panel title="Drill">
          <SegmentedControl fullWidth orientation="vertical" value={drill} onChange={(v) => { setDrill(v as Drill); setRunning(false); }} data={Object.entries(DRILLS).map(([value, d]) => ({ value, label: d.name }))} />
          <Text size="sm" c="dimmed" mt={8}>{DRILLS[drill].help}</Text>
          {drill !== "colour" && <Switch mt={10} label="From Black's side" checked={orientation === "black"} onChange={(e) => setOrientation(e.currentTarget.checked ? "black" : "white")} />}
        </Panel>
        <Panel>
          <Group grow gap={8}><Stat label="Score" value={score} /><Stat label="Misses" value={misses} color="#ff6b6b" /><Stat label="Best" value={best[DRILLS[drill].name] ?? 0} /></Group>
          <Progress mt={10} value={(left / 30) * 100} color={left < 8 ? "red" : undefined} />
          {running && drill === "find" && <Text ta="center" fz={54} fw={800} ff="ui-rounded, system-ui" mt={6}>{target}</Text>}
          {running && drill === "colour" && (
            <Group grow mt={12}>
              <Button size="md" variant="white" color="dark" onClick={() => answer(isLight(target))}>Light</Button>
              <Button size="md" variant="filled" color="dark" onClick={() => answer(!isLight(target))}>Dark</Button>
            </Group>
          )}
          {running && drill === "knight" && (
            <Group grow mt={12} gap={6}>{[1, 2, 3, 4, 5, 6].map((n) => <Button key={n} size="md" variant="default" onClick={() => answer(n === kd)}>{n}</Button>)}</Group>
          )}
          {!running && left <= 0 && <Text mt={10} fw={700} c="green">Time. {score} correct, {misses} missed.</Text>}
        </Panel>
        <Panel title="Blindfold play">
          <Switch label="Hide the pieces during games on the Play page" checked={app.settings.blindfold} onChange={(e) => app.set({ blindfold: e.currentTarget.checked })} />
          <Text size="xs" c="dimmed" mt={4}>Moves are still shown in the move list. Squares highlight as usual.</Text>
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12 }}><Button fullWidth size="md" onClick={start}>{running ? "Restart" : "Start 30 seconds"}</Button></div>
      </div>
    </div>
  );
}

function knightFen(square: string): string {
  const file = FILES.indexOf(square[0]), rank = parseInt(square[1], 10);
  const rows: string[] = [];
  for (let r = 8; r >= 1; r--) rows.push(r === rank ? `${file || ""}N${7 - file || ""}` : "8");
  return rows.join("/");
}

function VisionBoard({ orientation, highlight, onSelect }: { orientation: Color; highlight: Record<string, string>; onSelect: (sq: string) => void }) {
  const coords = useApp((s) => s.settings.coords);
  const set = useApp((s) => s.set);
  // Coordinates would give the answer away.
  useEffect(() => {
    if (!coords) return;
    set({ coords: false });
    return () => set({ coords: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <Board fen="8/8/8/8/8/8/8/8 w - - 0 1" orientation={orientation} highlight={highlight} onSelect={onSelect} />;
}

// MARK: Guess the move

function Guess({ initial }: { initial?: GameTree }) {
  const [tree, setTree] = useState<GameTree | undefined>(initial);
  const [side, setSide] = useState<Color>("white");
  const [index, setIndex] = useState(0);
  const [points, setPoints] = useState(0);
  const [asked, setAsked] = useState(0);
  const [feedback, setFeedback] = useState<{ text: string; color: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const engine = useRef<Engine>();
  useEffect(() => () => engine.current?.quit(), []);

  const nodes = tree ? [tree.root, ...tree.mainline] : [];
  const node: GNode | undefined = nodes[index];
  const next = nodes[index + 1];
  const finished = !!tree && !next;

  const begin = (t: GameTree, c: Color) => {
    setTree(t);
    setSide(c);
    setPoints(0);
    setAsked(0);
    setFeedback(undefined);
    // Skip the opening: start around move 8.
    let i = Math.min(14, Math.max(0, t.mainline.length - 8));
    while (i < t.mainline.length && [t.root, ...t.mainline][i].turn !== c) i++;
    setIndex(i);
  };

  const pickRandom = async () => {
    setError(undefined);
    const r = await db.query({ limit: 300, sort: "plies", desc: true }).catch(() => undefined);
    const pool = (r?.rows ?? []).filter((g) => g.plies >= 40 && !g.variant);
    if (!pool.length) return setError("The library has no long games yet. Import some, or open a game in Analysis and choose Position, Guess the moves.");
    const row = pool[Math.floor(Math.random() * pool.length)];
    const t = GameTree.fromPgn(await db.get(row.id));
    if (t) begin(t, row.result === "0-1" ? "black" : "white");
  };

  const evalAfter = async (fen: string, moves: string): Promise<Score | undefined> => {
    if (!engine.current) {
      const entry = resolveEngine();
      if (!entry) return undefined;
      engine.current = await launch(entry);
    }
    const { info } = await searchOnce(engine.current, { position: `position fen ${fen} moves ${moves}`, go: "go movetime 300" });
    if (!info) return undefined;
    // After the move it is the other side's turn; convert to White's point of view.
    return turnOf(fen) === "white" ? negate(info.score) : info.score;
  };

  const guess = async (move: Move) => {
    if (!tree || !node || !next || busy || feedback) return;
    const pos = tree.posAt(node);
    const uci = uciOf(pos, move, tree.chess960);
    const san = makeSan(pos, move);
    setAsked((a) => a + 1);
    if (uci === next.uci) {
      setPoints((p) => p + 3);
      logActivity("guess", true);
      setFeedback({ text: `${san} is the move played. 3 points.`, color: "green" });
      Sound.success();
    } else {
      setBusy(true);
      let gained = 0, text = `The game went ${next.san}.`;
      try {
        const [mine, theirs] = [await evalAfter(node.fen, uci), await evalAfter(node.fen, next.uci!)];
        if (mine && theirs) {
          const pov = (s: Score) => (side === "white" ? winPercent(s) : 100 - winPercent(s));
          const diff = pov(theirs) - pov(mine);
          gained = diff <= 3 ? 2 : diff <= 10 ? 1 : 0;
          text = gained === 2 ? `${san} is as good as the game's ${next.san}. 2 points.` : gained === 1 ? `${san} is playable, but ${next.san} was stronger. 1 point.` : `${san} is clearly weaker than ${next.san}. No points.`;
        }
      } catch {
        /* no engine: no partial credit */
      }
      setBusy(false);
      setPoints((p) => p + gained);
      logActivity("guess", gained > 0);
      setFeedback({ text, color: gained ? "yellow" : "red" });
      gained ? Sound.move() : Sound.error();
    }
  };

  const advance = () => {
    setFeedback(undefined);
    // Play the game move and the opponent's reply.
    let i = index + 1;
    if (nodes[i + 1] && nodes[i].turn !== side) i++;
    setIndex(i);
  };

  if (!tree) {
    return (
      <div className="page">
        <Empty icon={<IconTarget size={36} />} title="Guess the move">
          Step through a game and try to find each move one side played. An exact match scores 3, a move the engine rates as good scores 2, a playable one 1.
          <Group justify="center" mt="md"><Button onClick={pickRandom}>Pick a game from my library</Button></Group>
          {error && <Text size="sm" c="orange" mt="sm">{error}</Text>}
        </Empty>
      </div>
    );
  }
  const shown = feedback && next ? next : node!;
  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          <Board fen={shown.fen} orientation={side} lastMove={shown.lastMove} movable={!feedback && !busy && next && node!.turn === side ? side : undefined} onMove={guess} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title="Game">
          <Text fw={700}>{tree.tag("White", "White")} – {tree.tag("Black", "Black")}</Text>
          <Text size="xs" c="dimmed">{[tree.tag("Event"), tree.tag("Date"), tree.result].filter(Boolean).join(" · ")}</Text>
          <Text size="sm" mt={6}>You are guessing {side === "white" ? "White" : "Black"}'s moves.</Text>
        </Panel>
        <Panel>
          <Group grow gap={8}><Stat label="Points" value={points} /><Stat label="Of possible" value={asked * 3} /><Stat label="Score" value={asked ? `${Math.round((points / (asked * 3)) * 100)}%` : "–"} /></Group>
          <Progress mt={10} value={nodes.length > 1 ? (index / (nodes.length - 1)) * 100 : 0} size="sm" />
          <Text mt={10} fw={600} c={feedback?.color}>{finished ? "Game complete" : busy ? "Comparing with the engine…" : feedback ? feedback.text : `Move ${Math.floor(index / 2) + 1}: what would you play?`}</Text>
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12, display: "flex", gap: 8 }}>
          {feedback && !finished && <Button style={{ flex: 1 }} onClick={advance}>Continue</Button>}
          <Button style={{ flex: 1 }} variant="default" onClick={() => begin(tree, side === "white" ? "black" : "white")}>Switch side</Button>
          <Button style={{ flex: 1 }} variant="default" onClick={pickRandom}>Another game</Button>
        </div>
      </div>
    </div>
  );
}
