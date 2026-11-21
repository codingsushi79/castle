import { Alert, Button, Group, NumberInput, Progress, SegmentedControl, Select, Slider, Switch, Text } from "@mantine/core";
import { IconArrowBackUp, IconBrain, IconDownload, IconFlag, IconPlayerPlayFilled, IconRotate, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { MoveList, NavBar, Panel, PlayerStrip } from "../components/common";
import { Color, materialBalance, START_FEN, variantName, VARIANTS } from "../lib/chess";
import { available, entryOf, resolveEngine, useEngines } from "../lib/engines";
import { openingFor, useOpenings } from "../lib/openings";
import { COACHES, downloadMaia, installedMaia, MAIA_LEVELS, OPPONENTS, PERSONALITIES } from "../lib/personalities";
import { hasClock, modelEngineOf, personaEngine, personaRange, usePlay } from "../lib/play";
import { courseById } from "../lib/courses";
import { eloRange } from "../lib/strength";
import { Avatar, CoachChat } from "../components/CoachChat";
import { useOnline } from "../lib/online";
import { useApp, useTree } from "../lib/store";
import { OnlineGame, OnlinePanels } from "./Online";

const TIMES: [number, number, string][] = [[0, 0, "No clock"], [1, 0, "1+0"], [3, 2, "3+2"], [5, 0, "5+0"], [10, 5, "10+5"], [15, 10, "15+10"], [30, 0, "30+0"]];

export default function PlayPage() {
  const play = usePlay();
  const app = useApp();
  useEffect(() => {
    const from = app.takeIntent("playFrom") as { fen: string; rules: any } | undefined;
    if (from) {
      play.backToSetup();
      play.setCustomStart(from);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onlineGame = useOnline((s) => !!s.game);
  if (play.phase === "setup" && play.opponent === "online" && onlineGame) return <OnlineGame />;
  return play.phase === "setup" ? <Setup /> : <Game />;
}

function Setup() {
  const p = usePlay();
  const custom = p.handicap || p.delayMode !== "none" || !TIMES.some(([m, i]) => m === p.minutes && i === p.increment);
  const [showCustom, setShowCustom] = useState(false);
  useEngines((s) => s.engines);
  const [maia, setMaia] = useState<number[]>([]);
  const [dl, setDl] = useState<{ done: number; total: number }>();
  const [dlError, setDlError] = useState<string>();
  useEffect(() => { installedMaia().then(setMaia); }, []);
  const lc0 = !!entryOf("lc0")?.path;
  const persona = PERSONALITIES.find((x) => x.id === p.personaId) ?? PERSONALITIES.find((x) => x.id === "amara")!;
  const coachRange = personaRange();
  const online = p.opponent === "online";
  const courseSide = persona.coach && p.courseId ? courseById(p.courseId)?.side : undefined;
  const preview = online ? START_FEN : p.customStart?.fen ?? (p.rules === "chess" ? START_FEN : undefined);

  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          <Board key={p.rules + (p.customStart?.fen ?? "") + online} fen={preview ?? START_FEN} rules={online ? "chess" : p.customStart?.rules ?? "chess"} orientation={!online && (courseSide ?? p.side) === "black" ? "black" : "white"} />
        </div>
      </div>
      <div className="sidecol wide stagger">
        <Panel title="Opponent">
          <SegmentedControl fullWidth value={p.opponent} onChange={(v) => p.patch({ opponent: v as any })}
            data={[{ value: "engine", label: "Engine" }, { value: "persona", label: "Personality" }, { value: "human", label: "Human here" }, { value: "online", label: "Online" }]} />
          {p.opponent === "engine" && (() => {
            const [lo, hi] = eloRange(modelEngineOf(resolveEngine(p.engineId)));
            return (
              <>
                <Select mt={8} label="Engine" value={p.engineId} onChange={(v) => v && p.patch({ engineId: v })} data={available().map((e) => ({ value: e.id, label: e.name }))} />
                <Switch mt={10} label="Limit playing strength" checked={p.limit} onChange={(e) => p.patch({ limit: e.currentTarget.checked })} />
                {p.limit && (
                  <>
                    <Group mt={6} gap={10} wrap="nowrap">
                      <Slider style={{ flex: 1 }} min={lo} max={hi} step={25} value={Math.min(hi, Math.max(lo, p.elo))} onChange={(v) => p.patch({ elo: v })} label={null} />
                      <Text fw={700} w={40} ta="right">{Math.min(hi, Math.max(lo, p.elo))}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" mt={2}>Measured in games against Stockfish at known ratings, so the number means what it says.</Text>
                  </>
                )}
              </>
            );
          })()}
          {p.opponent === "persona" && (
            <>
              <div className="persona-grid">
                {OPPONENTS.map((x) => (
                  <div key={x.id} className={"persona-card pressable" + (x.id === p.personaId ? " on" : "")} onClick={() => p.patch({ personaId: x.id, courseId: "" })}>
                    <Avatar p={x} size={30} />
                    <div style={{ minWidth: 0 }}>
                      <Text fw={700} size="sm" truncate>{x.name} <span style={{ opacity: 0.7, fontWeight: 400 }}>{x.rating >= 3000 ? "max" : x.rating}</span></Text>
                      <Text size="xs" style={{ opacity: 0.75 }} truncate>{x.style}</Text>
                    </div>
                  </div>
                ))}
              </div>
              <Text size="xs" fw={700} c="dimmed" mt={12} tt="uppercase">Coaches</Text>
              <div className="persona-grid">
                {COACHES.map((x) => (
                  <div key={x.id} className={"persona-card pressable" + (x.id === p.personaId ? " on" : "")} onClick={() => p.patch({ personaId: x.id, courseId: "" })}>
                    <Avatar p={x} size={30} />
                    <div style={{ minWidth: 0 }}>
                      <Text fw={700} size="sm" truncate>{x.name}</Text>
                      <Text size="xs" style={{ opacity: 0.75 }} truncate>{x.coach!.title}</Text>
                    </div>
                  </div>
                ))}
              </div>
              <Text size="sm" mt={10}>{persona.blurb}</Text>
              {persona.coach ? (
                <>
                  <Text size="sm" fw={500} mt={10}>{persona.name} plays at</Text>
                  <Group gap={10} wrap="nowrap">
                    <Slider style={{ flex: 1 }} min={coachRange[0]} max={coachRange[1]} step={50} value={Math.min(coachRange[1], Math.max(coachRange[0], p.coachElo))} onChange={(v) => p.patch({ coachElo: v })} label={null} />
                    <Text fw={700} w={40} ta="right">{Math.min(coachRange[1], Math.max(coachRange[0], p.coachElo))}</Text>
                  </Group>
                  <Select mt={8} label="Practise an opening" value={p.courseId || "none"} onChange={(v) => p.patch({ courseId: !v || v === "none" ? "" : v })}
                    data={[{ value: "none", label: "No, just play" }, ...persona.coach.courses.map((id) => ({ value: id, label: `${courseById(id)?.name} (as ${courseById(id)?.side === "white" ? "White" : "Black"})` }))]} />
                  {p.courseId && <Text size="xs" c="dimmed" mt={4}>You play {courseById(p.courseId)?.side === "white" ? "White" : "Black"}, and {persona.name} follows the course's lines. Learn them first in Coaches.</Text>}
                </>
              ) : (
                <Text size="xs" c={persona.rating < 3000 && (persona.rating > coachRange[1] || persona.rating < coachRange[0]) ? "orange" : "dimmed"} mt={4}>
                  {persona.rating >= 3000 ? "No limit at all."
                    : persona.rating > coachRange[1] || persona.rating < coachRange[0]
                      ? `Rated ${persona.rating}, but with ${personaEngine(persona.rating)?.name ?? "this engine"} plays at about ${Math.round(Math.min(coachRange[1], Math.max(coachRange[0], persona.rating)))}. Install Stockfish on the Engines page for the full range.`
                    : `Plays at ${persona.rating}, measured in games against Stockfish at known ratings.`}
                </Text>
              )}
              {persona.maia && (
                maia.includes(persona.maia) && lc0 ? (
                  <Text size="xs" c="dimmed" mt={4}>Picks human-like moves with the Maia {persona.maia} network, trained on human games.</Text>
                ) : !lc0 ? (
                  <Text size="xs" c="dimmed" mt={4}>Install Leela Chess Zero on the Engines page for more human-like move choices.</Text>
                ) : (
                  <Group mt={6} gap={8}>
                    <Button variant="light" leftSection={<IconDownload size={14} />} loading={!!dl && dl.done < dl.total}
                      onClick={() => { setDlError(undefined); downloadMaia((done, total) => setDl({ done, total })).then(() => installedMaia().then(setMaia)).catch((e) => setDlError(e.message)); }}>
                      Download human-like networks
                    </Button>
                    <Text size="xs" c="dimmed">{MAIA_LEVELS.length} files, about 7 MB</Text>
                  </Group>
                )
              )}
              {dl && dl.total > 0 && dl.done < dl.total && <Progress mt={6} value={(dl.done / dl.total) * 100} size="sm" animated />}
              {dlError && <Text size="xs" c="red" mt={4}>{dlError}</Text>}
              <Switch mt={10} label="Talk during the game" description={persona.coach ? "Comments on your moves, explains theirs, and gives hints" : "Comments on the game as it goes"} checked={p.talk} onChange={(e) => p.patch({ talk: e.currentTarget.checked })} />
            </>
          )}
        </Panel>
        {online && <OnlinePanels />}
        {!online && p.opponent !== "human" && !courseSide && (
          <Panel title="Play as">
            <SegmentedControl fullWidth value={p.side} onChange={(v) => p.patch({ side: v as any })} data={[{ value: "white", label: "White" }, { value: "black", label: "Black" }, { value: "random", label: "Random" }]} />
          </Panel>
        )}
        {!online && <Panel title="Game">
          {p.customStart ? (
            <Group justify="space-between">
              <Text size="sm">From the position you chose ({variantName(p.customStart.rules)})</Text>
              <Button variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={() => p.setCustomStart(undefined)}>Reset</Button>
            </Group>
          ) : (
            <>
              <Select label="Variant" value={p.chess960 && p.rules === "chess" ? "chess960" : p.rules}
                onChange={(v) => v && p.patch(v === "chess960" ? { rules: "chess", chess960: true } : { rules: v as any, chess960: false })}
                data={[{ value: "chess", label: "Standard" }, { value: "chess960", label: "Chess960" }, ...VARIANTS.slice(1).map((v) => ({ value: v.rules, label: v.name }))]} />
              {p.rules !== "chess" && p.opponent !== "human" && (
                <Text size="xs" c={entryOf("fairy-stockfish")?.path ? "dimmed" : "orange"} mt={4}>
                  {entryOf("fairy-stockfish")?.path ? "Fairy-Stockfish plays this variant." : "Variants against the computer need Fairy-Stockfish (Engines page)."}
                </Text>
              )}
            </>
          )}
          <Text size="sm" fw={500} mt={10} mb={4}>Time control</Text>
          <Group gap={6}>
            {TIMES.map(([m, i, label]) => (
              <Button key={label} variant={!custom && p.minutes === m && p.increment === i ? "filled" : "default"} onClick={() => p.patch({ minutes: m, increment: i, handicap: false, delayMode: "none", delay: 0 })}>{label}</Button>
            ))}
            <Button variant={custom ? "filled" : "default"} onClick={() => setShowCustom(!showCustom)}>Custom…</Button>
          </Group>
          {(showCustom || custom) && (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 6, background: "var(--bg-raised)" }}>
              <Group grow>
                <NumberInput label={p.handicap ? "White minutes" : "Minutes"} min={0} max={600} step={1} value={p.minutes} onChange={(v) => typeof v === "number" && p.patch({ minutes: v })} />
                <NumberInput label={p.handicap ? "White increment" : "Increment (s)"} min={0} max={180} value={p.increment} onChange={(v) => typeof v === "number" && p.patch({ increment: v })} />
              </Group>
              <Switch mt={8} label="Give Black different time (handicap)" checked={p.handicap} onChange={(e) => p.patch({ handicap: e.currentTarget.checked, blackMinutes: p.minutes, blackIncrement: p.increment })} />
              {p.handicap && (
                <Group grow mt={6}>
                  <NumberInput label="Black minutes" min={0} max={600} value={p.blackMinutes} onChange={(v) => typeof v === "number" && p.patch({ blackMinutes: v })} />
                  <NumberInput label="Black increment" min={0} max={180} value={p.blackIncrement} onChange={(v) => typeof v === "number" && p.patch({ blackIncrement: v })} />
                </Group>
              )}
              <Group grow mt={8}>
                <Select label="Delay" value={p.delayMode} onChange={(v) => v && p.patch({ delayMode: v as any, delay: v === "none" ? 0 : p.delay || 5 })}
                  data={[{ value: "none", label: "None" }, { value: "simple", label: "Simple delay" }, { value: "bronstein", label: "Bronstein delay" }]} />
                <NumberInput label="Delay seconds" min={0} max={60} disabled={p.delayMode === "none"} value={p.delay} onChange={(v) => typeof v === "number" && p.patch({ delay: v })} />
              </Group>
              <Text size="xs" c="dimmed" mt={6}>Simple delay: the clock waits that long before running each move. Bronstein: after each move, up to that much of the time used is given back.</Text>
            </div>
          )}
        </Panel>}
        {!online && (
          <div style={{ padding: 12 }}>
            {p.error && <Alert color="red" mb={8} p="xs">{p.error}</Alert>}
            <Button fullWidth size="md" leftSection={<IconPlayerPlayFilled size={16} />} onClick={() => p.start()}>Start game</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function Game() {
  const p = usePlay();
  const app = useApp();
  const tree = p.tree;
  useTree(tree);
  useOpenings((s) => s.loaded);
  const flipped = p.opponent !== "human" && p.humanColor === "black";
  const top: Color = flipped ? "white" : "black";
  const bottom: Color = flipped ? "black" : "white";
  const live = tree.last;
  const balance = materialBalance(live.fen);
  const atEnd = tree.current === live;
  const movable = p.phase === "playing" && atEnd && !p.thinking ? (p.opponent === "human" ? "both" : p.humanColor) : undefined;
  const name = (c: Color) => (p.opponent === "human" ? (c === "white" ? "White" : "Black") : c === p.humanColor ? "You" : p.opponentName);
  const detail = (c: Color) => (p.opponent !== "human" && c !== p.humanColor && p.opponentElo ? String(Math.round(p.opponentElo)) : undefined);
  // Your own Castle Online picture, when you have one, beside "You".
  const myGuest = useOnline((s) => s.profile?.id);
  const strip = (c: Color) => (
    <PlayerStrip name={name(c)} guest={p.opponent !== "human" && c === p.humanColor ? myGuest : undefined} color={c} detail={detail(c)} clock={hasClock(p) ? p.clocks[c] : undefined} active={p.phase === "playing" && live.turn === c}
      material={c === "white" ? Math.max(0, balance) : Math.max(0, -balance)} />
  );
  void hasClock;
  const opening = openingFor(tree, live);

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className={"boardrow" + (app.settings.blindfold && p.phase === "playing" ? " blindfold" : "")}>
          <Board fen={tree.fen} rules={tree.rules} chess960={tree.chess960} orientation={bottom} movable={movable} lastMove={tree.current.lastMove} onMove={(m) => p.humanMove(m)}
            hint={atEnd ? p.hint?.square : undefined} arrows={atEnd && p.hint?.arrow ? [{ from: p.hint.arrow[0], to: p.hint.arrow[1], color: "green" }] : undefined} />
        </div>
        {strip(bottom)}
      </div>
      <div className="sidecol">
        <Panel>
          {p.outcome ? (
            <>
              <Text fw={800} size="xl" ff="ui-rounded, system-ui"><IconFlag size={20} style={{ verticalAlign: -3 }} /> {p.outcome.result}</Text>
              <Text c="dimmed">{p.outcome.reason}</Text>
            </>
          ) : p.thinking ? (
            <>
              <Text fw={700}><IconBrain size={16} style={{ verticalAlign: -3 }} /> {p.opponentName} is thinking</Text>
              <Text size="xs" c="dimmed">{p.detail || " "}</Text>
            </>
          ) : (
            <>
              <Text fw={700}>{live.turn === "white" ? "White" : "Black"} to move</Text>
              <Text size="xs" c="red">{tree.posAt(live).isCheck() ? "Check" : " "}</Text>
            </>
          )}
          {opening && <Text size="xs" c="dimmed" mt={4} truncate>{opening.name}</Text>}
          {tree.rules !== "chess" && <Text size="xs" c="dimmed">{variantName(tree.rules)}</Text>}
        </Panel>
        {p.persona && <CoachChat />}
        <Panel grow pad={false}><MoveList tree={tree} editable={false} /></Panel>
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <NavBar tree={tree} />
          {p.phase === "finished" ? (
            <>
              <Button fullWidth size="sm" onClick={() => app.openGame(tree.clone())}>Analyse game</Button>
              <Group grow>
                <Button variant="default" leftSection={<IconRotate size={14} />} onClick={() => p.start()}>Rematch</Button>
                <Button variant="default" onClick={() => p.backToSetup()}>New game</Button>
              </Group>
            </>
          ) : (
            <Group grow>
              <Button variant="default" leftSection={<IconArrowBackUp size={14} />} disabled={p.thinking || !tree.mainline.length} onClick={() => p.takeBack()}>Take back</Button>
              <Button variant="default" color="red" leftSection={<IconFlag size={14} />} onClick={() => p.resign()}>Resign</Button>
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}
