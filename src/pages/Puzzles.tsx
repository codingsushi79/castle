import { Button, Group, SegmentedControl, Select, Text } from "@mantine/core";
import { IconBolt, IconBulb, IconCalendar, IconCheck, IconEye, IconFlame, IconPlayerSkipForward, IconRotate, IconTarget, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { Panel } from "../components/common";
import { GameTree } from "../lib/chess";
import { canMovePuzzle, dailyStreak, dayNumber, PuzzleMode, THEME_NAMES, usePuzzles } from "../lib/puzzles";
import { clockText } from "../lib/storage";
import { useApp } from "../lib/store";
import { usePacks } from "../lib/packs";
import { IconPackage, IconTrash } from "@tabler/icons-react";
import { ActionIcon } from "@mantine/core";

export default function PuzzlesPage() {
  const p = usePuzzles();
  const app = useApp();
  const [shake, setShake] = useState(0);
  useEffect(() => { if (p.status === "wrong") setShake((n) => n + 1); }, [p.status]);
  useEffect(() => { if (app.takeIntent("daily")) p.setMode("daily"); /* eslint-disable-next-line */ }, []);
  const finished = p.status === "solved" || p.status === "revealed";
  const themes = ["all", ...Object.keys(THEME_NAMES).filter((t) => t !== "all" && t !== "mistake").sort((a, b) => THEME_NAMES[a].localeCompare(THEME_NAMES[b]))];
  const dailyDone = p.stats.dailySolved.includes(dayNumber());

  const status = {
    loading: ["Loading puzzles", "One moment…", "dimmed"],
    solving: [`${p.userColor === "white" ? "White" : "Black"} to move`, "Find the best move.", undefined],
    wrong: ["Not that one", "Have another look.", "red"],
    solved: ["Solved", "Nicely done.", "green"],
    revealed: ["Solution", "Play through it, then try the next one.", "orange"],
    empty: ["", "", undefined],
    rushOver: ["", "", undefined],
  }[p.status] as [string, string, string | undefined];

  return (
    <div className="page">
      <div className="boardcol">
        <div className="toolbar" style={{ margin: "-14px -16px 6px" }}>
          <SegmentedControl value={p.mode} onChange={(v) => p.setMode(v as PuzzleMode)}
            data={[{ value: "rated", label: "Rated" }, { value: "rush", label: "Rush" }, { value: "mistakes", label: `My mistakes${p.mistakes.length ? ` (${p.mistakes.length})` : ""}` }, { value: "daily", label: "Daily" }, { value: "pack", label: "Packs" }]} />
          <span style={{ flex: 1 }} />
          <Text size="xs" c="dimmed">{p.loaded ? `${p.all.length.toLocaleString()} puzzles` : "Loading…"}</Text>
        </div>
        <div className={"boardrow" + (shake ? " shake" : "")} key={shake}>
          <Board key={p.puzzle?.id ?? "none"} fen={p.fen} orientation={p.userColor} lastMove={p.lastMove} hint={p.hint}
            movable={canMovePuzzle(p) ? p.userColor : undefined} onMove={(m) => p.attempt(m)} />
        </div>
      </div>
      <div className="sidecol stagger">
        {p.mode === "rated" && (
          <Panel>
            <Group justify="space-between" align="flex-end">
              <div>
                <Text size="xs" c="dimmed">Your rating</Text>
                <Group gap={6} align="baseline">
                  <Text fw={800} fz={32} ff="ui-rounded, system-ui" lh={1}>{p.rating}</Text>
                  {p.delta !== 0 && <Text fw={700} c={p.delta > 0 ? "green" : "red"}>{p.delta > 0 ? "+" : ""}{p.delta}</Text>}
                </Group>
              </div>
              <div style={{ textAlign: "right" }}>
                <Text c={p.streak ? "orange" : "dimmed"} fw={700}><IconFlame size={15} style={{ verticalAlign: -2 }} /> {p.streak}</Text>
                <Text size="xs" c="dimmed">{p.solved} solved · {p.failed} missed</Text>
              </div>
            </Group>
          </Panel>
        )}
        {p.mode === "rush" && (
          <Panel>
            <Group justify="space-between" align="flex-end">
              <div>
                <Text size="xs" c="dimmed">{p.rushActive ? "Solved" : "Last run"}</Text>
                <Text fw={800} fz={32} ff="ui-rounded, system-ui" lh={1}>{p.rushScore}</Text>
              </div>
              <div style={{ textAlign: "right" }}>
                <Text fw={700} fz={20} ff="ui-rounded, system-ui" c={p.rushActive && p.rushRemaining < 20 ? "red" : undefined}>{clockText(p.rushActive ? p.rushRemaining : p.rushMinutes * 60)}</Text>
                <Group gap={2} justify="flex-end">{[0, 1, 2].map((i) => <IconX key={i} size={15} color={i < p.rushStrikes ? "#ff6b6b" : "#555"} stroke={3} />)}</Group>
              </div>
            </Group>
            <Text size="xs" c="dimmed" mt={6}>Best: {Math.max(0, ...p.stats.rushScores)}. Three misses or the clock end the run. Puzzles get harder as you go.</Text>
          </Panel>
        )}
        {p.mode === "mistakes" && (
          <Panel>
            <Text fw={700} size="md"><IconTarget size={16} style={{ verticalAlign: -3 }} /> {p.mistakes.length} position{p.mistakes.length === 1 ? "" : "s"} to fix</Text>
            {p.mistakes.length === 0 ? (
              <>
                <Text size="sm" c="dimmed" mt={4}>Review a game in Analysis, then choose Train mistakes. Each mistake becomes a puzzle here until you solve it first try.</Text>
                <Button mt={8} variant="light" onClick={() => app.go("analysis")}>Open Analysis</Button>
              </>
            ) : p.puzzle?.source && <Text size="sm" c="dimmed">From {p.puzzle.source}. Find the move you missed.</Text>}
          </Panel>
        )}
        {p.mode === "pack" && <PackCard />}
        {p.mode === "daily" && (
          <Panel>
            <Group justify="space-between">
              <div>
                <Text size="xs" c="dimmed">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</Text>
                <Text fw={700} size="md" c={dailyDone ? "green" : undefined}>{dailyDone ? <IconCheck size={16} style={{ verticalAlign: -3 }} /> : <IconCalendar size={16} style={{ verticalAlign: -3 }} />} {dailyDone ? "Solved today" : "Today's puzzle"}</Text>
              </div>
              <Text c={dailyStreak(p.stats) ? "orange" : "dimmed"} fw={700}><IconFlame size={15} style={{ verticalAlign: -2 }} /> {dailyStreak(p.stats)}</Text>
            </Group>
          </Panel>
        )}
        {p.status !== "rushOver" && p.status !== "empty" && (
          <>
            <Panel>
              <Text fw={700} size="md" c={status[2]}>{status[0]}</Text>
              <Text size="sm" c="dimmed">{status[1]}</Text>
            </Panel>
            {p.puzzle && (
              <Panel>
                <Group justify="space-between">
                  <Text size="sm" fw={500}># {p.puzzle.id}</Text>
                  <Text size="sm" c="dimmed">{finished ? `Rated ${p.puzzle.rating}` : "Rating hidden"}</Text>
                </Group>
                {finished && <Group gap={5} mt={6}>{p.puzzle.themes.slice(0, 6).map((t) => <span key={t} style={{ fontSize: 11, padding: "1px 8px", borderRadius: 10, background: "var(--bg-raised)" }}>{THEME_NAMES[t] ?? t}</span>)}</Group>}
                {p.played.length > 0 && <Text size="sm" c="dimmed" mt={6} ff="ui-rounded, system-ui">{p.played.join("  ")}</Text>}
              </Panel>
            )}
          </>
        )}
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          {p.mode === "rated" && <Select label="Theme" searchable value={p.theme} onChange={(v) => v && p.setTheme(v)} data={themes.map((t) => ({ value: t, label: THEME_NAMES[t] }))} />}
          {p.mode === "rush" ? (
            !p.rushActive && (
              <Group grow>
                <Button size="sm" leftSection={<IconBolt size={15} />} disabled={!p.loaded} onClick={() => p.startRush(3)}>3 minutes</Button>
                <Button size="sm" variant="light" leftSection={<IconBolt size={15} />} disabled={!p.loaded} onClick={() => p.startRush(5)}>5 minutes</Button>
              </Group>
            )
          ) : p.status !== "empty" && (
            <>
              {finished && p.mode !== "daily" && <Button fullWidth size="sm" onClick={() => p.next()}>Next puzzle</Button>}
              {finished ? (
                <Group grow>
                  <Button variant="default" leftSection={<IconRotate size={14} />} onClick={() => p.retry()}>Retry</Button>
                  <Button variant="default" onClick={() => p.puzzle && app.openGame(new GameTree(p.puzzle.fen))}>Analyse</Button>
                </Group>
              ) : (
                <Group grow>
                  <Button variant="default" leftSection={<IconBulb size={14} />} disabled={!canMovePuzzle(p)} onClick={() => p.showHint()}>Hint</Button>
                  <Button variant="default" leftSection={<IconEye size={14} />} onClick={() => p.reveal()}>Solution</Button>
                  {p.mode !== "daily" && <Button variant="default" leftSection={<IconPlayerSkipForward size={14} />} onClick={() => p.next()}>Skip</Button>}
                </Group>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PackCard() {
  const p = usePuzzles();
  const { packs, remove } = usePacks();
  const go = useApp((s) => s.go);
  const pack = packs.find((x) => x.id === p.packId);
  if (pack) {
    return (
      <Panel title={<><IconPackage size={13} /> {pack.name}</>} right={<Button variant="subtle" color="gray" onClick={() => p.openPack(undefined)}>All packs</Button>}>
        <Text size="sm">{pack.solved.length} of {pack.puzzles.length} solved</Text>
        {p.puzzle?.source && <Text size="xs" c="dimmed" mt={4}>From {p.puzzle.source}</Text>}
        {pack.solved.length >= pack.puzzles.length && <Text size="sm" c="green" mt={4}>Pack complete. Puzzles now repeat at random.</Text>}
      </Panel>
    );
  }
  return (
    <Panel title="Puzzle packs" pad={false}>
      {packs.length ? packs.map((x) => (
        <div key={x.id} className="listrow" onClick={() => p.openPack(x.id)}>
          <IconPackage size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" fw={600} truncate>{x.name}</Text>
            <Text size="xs" c="dimmed">{x.solved.length} of {x.puzzles.length} solved · {new Date(x.created).toLocaleDateString()}</Text>
          </div>
          <ActionIcon variant="subtle" color="gray" onClick={(e) => { e.stopPropagation(); remove(x.id); }}><IconTrash size={14} /></ActionIcon>
        </div>
      )) : (
        <div style={{ padding: 12 }}>
          <Text size="sm" c="dimmed">Packs are made from your own games: in the Library, select games (or filter to a player or folder), then choose More, Make a puzzle pack.</Text>
          <Button mt={8} variant="light" onClick={() => go("library")}>Open the Library</Button>
        </div>
      )}
    </Panel>
  );
}
