import { Alert, Button, Group, Loader, SegmentedControl, Select, Switch, Text, TextInput } from "@mantine/core";
import { IconBolt, IconBulb, IconCalendar, IconCheck, IconEye, IconFlame, IconPlayerSkipForward, IconRotate, IconSwords, IconTarget, IconTrophy, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { Panel } from "../components/common";
import { GameTree } from "../lib/chess";
import { canMovePuzzle, dailyStreak, dayNumber, PuzzleMode, THEME_NAMES, usePuzzles } from "../lib/puzzles";
import { clockText } from "../lib/storage";
import { useApp } from "../lib/store";
import { usePacks } from "../lib/packs";
import { useRace } from "../lib/race";
import { api, useOnline } from "../lib/online";
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
  const raceKind = useRace((s) => s.kind);
  const raceError = useRace((s) => s.error);
  if (p.mode === "battle" || (p.mode === "rush" && raceKind === "rush")) return <RacePage />;

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
            data={[{ value: "rated", label: "Rated" }, { value: "rush", label: "Rush" }, { value: "mistakes", label: `My mistakes${p.mistakes.length ? ` (${p.mistakes.length})` : ""}` }, { value: "daily", label: "Daily" }, { value: "pack", label: "Packs" }, { value: "battle", label: "Battle" }]} />
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
        {p.mode === "rush" && !p.rushActive && <RushBoard minutes={p.rushMinutes} />}
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
              <>
                <Text size="xs" fw={600}>Ranked: checked by Castle Online, on the leaderboard</Text>
                <Group grow>
                  <Button size="sm" leftSection={<IconTrophy size={15} />} onClick={() => useRace.getState().startRush(3).catch((e) => useRace.setState({ error: e.message }))}>3 minutes</Button>
                  <Button size="sm" variant="light" leftSection={<IconTrophy size={15} />} onClick={() => useRace.getState().startRush(5).catch((e) => useRace.setState({ error: e.message }))}>5 minutes</Button>
                </Group>
                <Text size="xs" fw={600} mt={4}>Practice: offline, just for you</Text>
                <Group grow>
                  <Button size="sm" variant="default" leftSection={<IconBolt size={15} />} disabled={!p.loaded} onClick={() => p.startRush(3)}>3 minutes</Button>
                  <Button size="sm" variant="default" leftSection={<IconBolt size={15} />} disabled={!p.loaded} onClick={() => p.startRush(5)}>5 minutes</Button>
                </Group>
                {raceError && <Text size="xs" c="red">{raceError}</Text>}
              </>
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

/** The best checked rush runs from everyone who plays Castle Online. */
function RushBoard({ minutes }: { minutes: number }) {
  const [length, setLength] = useState(minutes === 5 ? 5 : 3);
  const [scores, setScores] = useState<{ guest: string; name: string; score: number }[]>();
  const me = useOnline((s) => s.profile?.id);
  useEffect(() => {
    let live = true;
    api<{ scores: { guest: string; name: string; score: number }[] }>(`rush?minutes=${length}`).then((r) => live && setScores(r.scores)).catch(() => live && setScores([]));
    return () => { live = false; };
  }, [length]);
  return (
    <Panel title={<><IconTrophy size={13} /> Rush leaderboard</>} pad={false}
      right={<SegmentedControl size="xs" value={String(length)} onChange={(v) => setLength(Number(v))} data={[{ value: "3", label: "3 min" }, { value: "5", label: "5 min" }]} />}>
      {!scores ? <Loader size="xs" m={12} /> : scores.length ? scores.slice(0, 10).map((x, i) => (
        <div key={x.guest} className="listrow" style={{ cursor: "default", fontWeight: x.guest === me ? 800 : undefined }}>
          <Text size="xs" w={20} c="dimmed">{i + 1}</Text>
          <Text size="sm" style={{ flex: 1 }} truncate>{x.name}{x.guest === me ? " (you)" : ""}</Text>
          <Text size="sm" fw={700}>{x.score}</Text>
        </div>
      )) : <Text size="xs" c="dimmed" p={12}>No ranked runs yet. Every move of a ranked run is checked by the server, so these scores are real.</Text>}
    </Panel>
  );
}

/** Ranked rush and puzzle battles: every move goes to the server, which keeps the solutions and the score. */
function RacePage() {
  const p = usePuzzles();
  const r = useRace();
  const online = useOnline();
  const [code, setCode] = useState("");
  const [minutes, setMinutes] = useState("3");
  const [isPublic, setPublic] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!online.ready) { online.start(); return; }
    online.refreshLobby();
    const t = setInterval(() => !useRace.getState().race && useOnline.getState().refreshLobby(), 4000);
    return () => clearInterval(t);
  }, [online.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e: any) { useRace.setState({ error: e.message }); } finally { setBusy(undefined); }
  };

  const now = Date.now() + r.offset;
  const race = r.race, runView = r.run;
  const me = race && r.side ? race[r.side] : undefined;
  const them = race && r.side ? race[r.side === "a" ? "b" : "a"] : undefined;
  const ends = race?.endsAt ?? runView?.endsAt ?? null;
  const left = ends ? Math.max(0, (ends - now) / 1000) : Number(minutes) * 60;
  const myScore = Math.max(runView?.score ?? 0, me?.score ?? 0), myStrikes = Math.max(runView?.strikes ?? 0, me?.strikes ?? 0);
  const over = race ? race.status === "finished" : runView?.status === "finished" || (!!ends && left <= 0) || myStrikes >= 3;
  const strikes = (n: number) => <Group gap={2}>{[0, 1, 2].map((i) => <IconX key={i} size={13} color={i < n ? "#ff6b6b" : "#555"} stroke={3} />)}</Group>;
  const verdict = race && over && them ? (myScore > them.score ? "You win!" : myScore < them.score ? `${them.name} wins` : "A tie") : undefined;
  const active = r.kind === "rush" || !!race;

  return (
    <div className="page">
      <div className="boardcol">
        <div className="toolbar" style={{ margin: "-14px -16px 6px" }}>
          <SegmentedControl value={p.mode} onChange={(m) => { r.leave(); p.setMode(m as PuzzleMode); }}
            data={[{ value: "rated", label: "Rated" }, { value: "rush", label: "Rush" }, { value: "mistakes", label: "My mistakes" }, { value: "daily", label: "Daily" }, { value: "pack", label: "Packs" }, { value: "battle", label: "Battle" }]} />
        </div>
        <div className={"boardrow" + (r.flash === "wrong" ? " shake" : "")}>
          <Board key={runView ? `${runView.id}-${runView.index}` : "idle"} fen={r.fen} orientation={r.userColor} lastMove={r.answer ?? r.lastMove}
            movable={r.ready ? r.userColor : undefined} onMove={(m) => r.attempt(m)} />
        </div>
      </div>
      <div className="sidecol stagger">
        {r.error && <div style={{ padding: "10px 12px 0" }}><Alert color="orange" p="xs" withCloseButton onClose={() => useRace.setState({ error: undefined })}>{r.error}</Alert></div>}
        {active ? (
          <>
            <Panel title={<>{r.kind === "rush" ? <IconTrophy size={13} /> : <IconSwords size={13} />} {r.kind === "rush" ? "Ranked rush" : "Puzzle battle"} · {r.kind === "rush" ? (runView?.endsAt && runView.startedAt ? Math.round((runView.endsAt - runView.startedAt) / 60000) : minutes) : race?.minutes} min</>}>
              {race?.status === "waiting" ? (
                <>
                  <Group gap={8}><Loader size="xs" /><Text fw={700}>Waiting for an opponent</Text></Group>
                  <Text size="sm" c="dimmed" mt={4}>Share the code <b>{race.code}</b>{isPublic ? ", or wait for someone from the lobby" : ""}. The race starts five seconds after they join.</Text>
                </>
              ) : race?.status === "countdown" ? (
                <Text fw={800} fz={28} ta="center">Starting in {Math.max(1, Math.ceil(((race.startedAt ?? now) - now) / 1000))}…</Text>
              ) : (
                <Text fw={800} fz={28} ta="center" ff="ui-rounded, system-ui" c={left < 15 && !over ? "red" : undefined}>{verdict ?? (over ? "Time!" : clockText(left))}</Text>
              )}
              {race && race.status !== "waiting" && them ? (
                <Group grow mt="sm">
                  {[{ score: myScore, st: myStrikes, label: "You" }, { score: them.score, st: them.strikes, label: them.name ?? "Opponent" }].map((x) => (
                    <div key={x.label} style={{ textAlign: "center" }}>
                      <Text size="xs" c="dimmed" truncate>{x.label}</Text>
                      <Text fw={800} fz={36} ff="ui-rounded, system-ui" lh={1.1}>{x.score}</Text>
                      <Group justify="center">{strikes(x.st)}</Group>
                    </div>
                  ))}
                </Group>
              ) : r.kind === "rush" && (
                <div style={{ textAlign: "center", marginTop: 8 }}>
                  <Text fw={800} fz={36} ff="ui-rounded, system-ui" lh={1.1}>{myScore}</Text>
                  <Group justify="center">{strikes(myStrikes)}</Group>
                </div>
              )}
              {!over && myStrikes >= 3 && <Text size="sm" c="dimmed" mt={6} ta="center">Three misses: you're out.</Text>}
              {!over && r.flash && <Text size="sm" mt={6} ta="center" c={r.flash === "right" ? "green" : "red"}>{r.flash === "right" ? "Solved" : "Missed: the right move is shown"}</Text>}
              {!over && !r.flash && runView?.status === "running" && myStrikes < 3 && <Text size="sm" mt={6} ta="center" c="dimmed">{r.userColor === "white" ? "White" : "Black"} to move · puzzle {runView.index + 1}{runView.puzzle ? ` · rated ${runView.puzzle.rating}` : ""}</Text>}
              {over && r.kind === "rush" && <Text size="sm" mt={6} ta="center">Final score {myScore}. It's on the leaderboard if it's your best.</Text>}
            </Panel>
            {r.kind === "rush" && over && <RushBoard minutes={Number(minutes)} />}
            <div style={{ padding: 12 }}>
              <Button fullWidth variant="default" onClick={() => r.leave()}>{over ? (r.kind === "rush" ? "Done" : "New battle") : race?.status === "waiting" ? "Cancel" : "Leave"}</Button>
            </div>
          </>
        ) : (
          <>
            <Panel title={<><IconSwords size={13} /> Puzzle battle</>}>
              <Text size="sm" c="dimmed">Race another player through the same puzzles. Each solve scores a point; three misses and you're out. Puzzles get harder as you go, and the server checks every move.</Text>
              <Group mt="sm" gap="md" align="flex-end">
                <SegmentedControl size="xs" value={minutes} onChange={setMinutes} data={[{ value: "2", label: "2 min" }, { value: "3", label: "3 min" }, { value: "5", label: "5 min" }]} />
                <Switch size="xs" label="Listed in the lobby" checked={isPublic} onChange={(e) => setPublic(e.currentTarget.checked)} />
              </Group>
              <Button mt="sm" fullWidth loading={busy === "create"} disabled={!online.ready} leftSection={<IconSwords size={15} />}
                onClick={() => run("create", () => r.createBattle(Number(minutes), isPublic))}>Start a battle</Button>
              <Group mt="sm" gap={6} wrap="nowrap">
                <TextInput style={{ flex: 1 }} size="xs" placeholder="Join with a code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && code && run("join", () => r.joinBattle(code))} />
                <Button size="xs" variant="default" disabled={!code || !online.ready} loading={busy === "join"} onClick={() => run("join", () => r.joinBattle(code))}>Join</Button>
              </Group>
              {!online.ready && <Text size="xs" c={online.error ? "orange" : "dimmed"} mt={6}>{online.error ?? "Connecting to Castle Online…"}</Text>}
            </Panel>
            <Panel title="Open battles" pad={false}>
              {online.races.length ? online.races.map((x) => (
                <div key={x.id} className="listrow">
                  <Text size="sm" style={{ flex: 1 }} truncate><b>{x.name}</b> · {x.minutes} min</Text>
                  <Button size="xs" variant="light" loading={busy === x.code} onClick={() => run(x.code, () => r.joinBattle(x.code))}>Battle</Button>
                </div>
              )) : <Text size="sm" c="dimmed" p={12}>Nobody is waiting. Start a battle and it shows up here.</Text>}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
