import { ActionIcon, Alert, Badge, Button, Collapse, Group, Loader, NumberInput, Progress, SegmentedControl, Select, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import {
  IconBolt, IconBroadcast, IconCheck, IconEye, IconFlag, IconHandStop, IconPlugConnected, IconPlus, IconPuzzle, IconRefresh, IconSearch, IconSend,
  IconSwords, IconTrophy, IconUserPlus, IconUsers, IconWifiOff, IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Board } from "../components/Board";
import { MoveList, Panel, PlayerStrip } from "../components/common";
import { useBattle } from "../lib/battle";
import { Color, GameTree, positionOf, uciOf } from "../lib/chess";
import { launch, resolveEngine } from "../lib/engines";
import {
  ABANDON_MS, ARENA_BREAK_MS, ArenaInfo, Challenge, GameView, ONLINE_VARIANTS, OnlineVariant, ratingWindow, REACTIONS, rulesOfVariant, shownClocks, tc, useOnline, variantLabel,
} from "../lib/online";
import { usePlay } from "../lib/play";
import { usePuzzles } from "../lib/puzzles";
import { mistakePuzzles, reviewGame, ReviewSummary, summarise } from "../lib/review";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import type { Engine } from "../lib/uci";

const PRESETS: [number, number, string][] = [[1, 0, "Bullet"], [3, 2, "Blitz"], [5, 0, "Blitz"], [10, 0, "Rapid"], [15, 10, "Rapid"], [30, 0, "Classical"]];
const other = (c: Color): Color => (c === "white" ? "black" : "white");
const minutesLeft = (ms: number) => (ms < 60_000 ? "under a minute" : `${Math.round(ms / 60_000)} min`);

/** Castle Online now lives on the Play page; the old page id still leads there. */
export default function OnlinePage() {
  const go = useApp((s) => s.go);
  useEffect(() => {
    if (usePlay.getState().phase === "setup") usePlay.getState().patch({ opponent: "online" });
    go("play");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <></>;
}

/** Accept or decline buttons for one incoming challenge. */
export function ChallengeCard({ c, onAccept }: { c: Challenge; onAccept?: () => void }) {
  const o = useOnline();
  return (
    <Alert color="teal" p="xs" icon={<IconSwords size={16} />} title={`${c.name}${c.rating ? ` (${c.rating})` : ""} challenges you`}>
      <Text size="sm">{tc(c.minutes, c.increment)} · {variantLabel(c.variant)} · {c.rated ? "rated" : "casual"}</Text>
      <Group gap={6} mt={6}>
        <Button size="xs" leftSection={<IconCheck size={13} />} onClick={() => { onAccept?.(); o.answer(c, true); }}>Accept</Button>
        <Button size="xs" variant="default" onClick={() => o.answer(c, false)}>Decline</Button>
      </Group>
    </Alert>
  );
}

/** The Play page's sidebar when the opponent is "Online": queue, friends, arenas, lobby. */
export function OnlinePanels() {
  const o = useOnline();
  const app = useApp();
  const [preset, setPreset] = useState<number>(load("onlinePreset", 2));
  const [variant, setVariant] = useState<OnlineVariant>(load("onlineVariant", "chess"));
  const [color, setColor] = useState("random");
  const [rated, setRated] = useState<boolean>(load("onlineRated", true));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [tab, setTab] = useState<string>(load("onlineTab", "open"));
  const [newArena, setNewArena] = useState(false);

  useEffect(() => { if (!o.ready) o.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!o.ready) return;
    o.refreshLobby();
    o.refreshArenas();
    const t = setInterval(o.refreshLobby, 4000);
    const a = setInterval(o.refreshArenas, 15000);
    return () => { clearInterval(t); clearInterval(a); };
  }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(undefined); }
  };
  const [minutes, increment] = PRESETS[preset];
  const p = o.profile;
  const listGame = (g: GameView, action: "watch" | "analyse") => (
    <div key={g.id} className="listrow" onClick={() => (action === "watch" ? o.watch(g.id) : app.openGame(o.toTree(g)))}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" truncate><b>{g.white.name}</b> {g.white.rating ?? ""} – <b>{g.black.name}</b> {g.black.rating ?? ""}</Text>
        <Text size="xs" c="dimmed">{tc(g.minutes, g.increment)}{g.variant && g.variant !== "chess" ? ` · ${variantLabel(g.variant)}` : ""} · {g.arena ? "arena" : g.rated ? "rated" : "casual"} · {g.ply} plies{g.result ? ` · ${g.result === "aborted" ? "aborted" : `${g.result} by ${g.reason}`}` : ""}</Text>
      </div>
      {action === "watch" ? <IconEye size={16} /> : <Text size="xs" c="dimmed">Analyse</Text>}
    </div>
  );
  const openBattle = (code: string) => run("battle", async () => {
    await useBattle.getState().join(code);
    usePuzzles.getState().setMode("battle");
    app.go("puzzles");
  });

  return (
    <>
      {o.error && (
        <div style={{ padding: "10px 12px 0" }}>
          <Alert color="orange" p="xs" withCloseButton onClose={() => useOnline.setState({ error: undefined })}>
            <Text size="sm">{o.error}</Text>
            {!o.ready && <Button mt={6} size="xs" variant="light" color="orange" leftSection={<IconRefresh size={13} />} onClick={() => { useOnline.setState({ error: undefined }); o.start(); }}>Try again</Button>}
          </Alert>
        </div>
      )}
      {o.incoming.length > 0 && <div style={{ padding: "10px 12px 0", display: "grid", gap: 6 }}>{o.incoming.map((c) => <ChallengeCard key={c.id} c={c} />)}</div>}
      {o.arena && <ArenaPanel />}

      <Panel title="You" right={p && <Text size="xs" c="dimmed">{p.wins} won · {p.draws} drawn · {p.losses} lost</Text>}>
        <Group gap="md" wrap="nowrap" align="flex-end">
          <TextInput style={{ flex: 1 }} size="xs" label="Name shown to opponents" value={o.name} maxLength={24} onChange={(e) => o.setName(e.currentTarget.value)} />
          {p ? (
            <div style={{ textAlign: "right" }}>
              <Text fz={24} fw={800} ff="ui-rounded, system-ui" lh={1}>{p.rating}</Text>
              <Text size="xs" c="dimmed">{p.games < 10 ? "provisional" : `peak ${p.peak}`}</Text>
            </div>
          ) : <Text size="sm" c="dimmed">{o.error ? "Offline" : "Connecting…"}</Text>}
        </Group>
      </Panel>

      <Panel title={<><IconBolt size={13} /> Quick pairing</>}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
          {PRESETS.map(([m, i, label], k) => (
            <Button key={k} size="sm" h={46} variant={preset === k ? "filled" : "default"} onClick={() => { setPreset(k); save("onlinePreset", k); }}>
              <div style={{ lineHeight: 1.15 }}>
                <div>{tc(m, i)}</div>
                <Text span size="xs" c={preset === k ? undefined : "dimmed"}>{label}</Text>
              </div>
            </Button>
          ))}
        </div>
        <Group mt="sm" gap="md" align="flex-end" wrap="nowrap">
          <Select style={{ flex: 1 }} size="xs" label="Variant" value={variant} data={ONLINE_VARIANTS} allowDeselect={false}
            onChange={(v) => { if (v) { setVariant(v as OnlineVariant); save("onlineVariant", v); } }} />
          <Switch mb={6} size="xs" label="Rated" checked={rated} onChange={(e) => { setRated(e.currentTarget.checked); save("onlineRated", e.currentTarget.checked); }} />
        </Group>
        <Button mt="sm" fullWidth size="md" loading={busy === "queue"} disabled={!o.ready} leftSection={<IconSearch size={16} />}
          onClick={() => run("queue", () => o.quickPair({ minutes, increment, rated, variant }))}>Find an opponent</Button>
        <Text size="xs" c="dimmed" mt={6}>Pairs you with someone near your rating for {tc(minutes, increment)} {variantLabel(variant)}. The range widens the longer you wait.</Text>
      </Panel>

      <Panel title={<><IconUsers size={13} /> Play a friend</>}>
        <SegmentedControl size="xs" fullWidth value={color} onChange={setColor} data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }]} />
        <Button mt="sm" fullWidth variant="light" loading={busy === "create"} disabled={!o.ready} leftSection={<IconSwords size={15} />}
          onClick={() => run("create", () => o.create({ minutes, increment, color, rated, public: false, variant }))}>Create a game with a code</Button>
        <Group mt="sm" gap={6} wrap="nowrap">
          <TextInput style={{ flex: 1 }} size="xs" placeholder="Join with a code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && code && run("join", () => o.join(code))} />
          <Button size="xs" variant="default" disabled={!code || !o.ready} loading={busy === "join"} onClick={() => run("join", () => o.join(code))}>Join</Button>
        </Group>
        <Text size="xs" fw={600} mt="md" mb={4}>Friends</Text>
        {o.friends.length ? o.friends.map((f) => (
          <Group key={f.id} gap={8} wrap="nowrap" py={3}>
            <Tooltip label={o.presence[f.id] ? "Online now" : "Offline"}><span className={"presence" + (o.presence[f.id] ? " on" : "")} /></Tooltip>
            <Text size="sm" style={{ flex: 1 }} truncate>{f.name}</Text>
            <Button size="compact-xs" variant="light" disabled={!o.ready} loading={busy === `ch-${f.id}`}
              onClick={() => run(`ch-${f.id}`, () => o.challenge(f, { minutes, increment, rated, variant, color }))}>Challenge</Button>
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.removeFriend(f.id)}><IconX size={13} /></ActionIcon>
          </Group>
        )) : <Text size="xs" c="dimmed">Add opponents as friends from a game or the leaderboard, then challenge them here with the time control above.</Text>}
      </Panel>

      {!o.arena && (
        <Panel title={<><IconTrophy size={13} /> Arenas</>} pad={false}
          right={<Tooltip label="Make an arena"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setNewArena(!newArena)}><IconPlus size={14} /></ActionIcon></Tooltip>}>
          <Collapse in={newArena}><NewArena onDone={() => setNewArena(false)} /></Collapse>
          {o.arenas.filter((a) => a.status !== "finished").map((a) => <ArenaRow key={a.id} a={a} />)}
          {!o.arenas.some((a) => a.status !== "finished") && <Text size="sm" c="dimmed" p={12}>{o.ready ? "Loading arenas…" : "Arenas appear once you are connected."}</Text>}
          <Text size="xs" c="dimmed" px={12} pb={10} pt={4}>Play as many games as you can before the arena ends. Win 2, draw 1; after two wins in a row, points double.</Text>
        </Panel>
      )}

      <Panel title={<><IconBroadcast size={13} /> Lobby</>} pad={false} right={<Tooltip label="Refresh"><span className="pressable" onClick={() => o.refreshLobby()}><IconRefresh size={13} /></span></Tooltip>}>
        <div style={{ padding: "8px 12px" }}>
          <SegmentedControl size="xs" fullWidth value={tab} onChange={(v) => { setTab(v); save("onlineTab", v); }}
            data={[{ value: "open", label: `Seeks (${o.open.length + o.battles.length})` }, { value: "live", label: `Live (${o.live.length})` }, { value: "mine", label: "Mine" }, { value: "top", label: "Top" }]} />
        </div>
        {tab === "open" && (o.open.length || o.battles.length ? (
          <>
            {o.open.map((s) => (
              <div key={s.id} className="listrow">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" truncate><b>{s.name}</b> {s.rating}</Text>
                  <Text size="xs" c="dimmed">{tc(s.minutes, s.increment)}{s.variant && s.variant !== "chess" ? ` · ${variantLabel(s.variant)}` : ""} · {s.rated ? "rated" : "casual"} · {s.color === "random" ? "random colours" : `plays ${s.color}`}</Text>
                </div>
                <Button size="xs" disabled={!o.ready} onClick={() => run("join", () => o.join(s.code))}>Play</Button>
              </div>
            ))}
            {o.battles.map((b) => (
              <div key={b.id} className="listrow">
                <IconPuzzle size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" truncate><b>{b.name}</b></Text>
                  <Text size="xs" c="dimmed">Puzzle battle · {b.minutes} min</Text>
                </div>
                <Button size="xs" variant="light" disabled={!o.ready} loading={busy === "battle"} onClick={() => openBattle(b.code)}>Battle</Button>
              </div>
            ))}
          </>
        ) : <Text size="sm" c="dimmed" p={12}>Nobody is waiting. Find an opponent and you show up here for others.</Text>)}
        {tab === "live" && (o.live.length ? o.live.map((g) => listGame(g, "watch")) : <Text size="sm" c="dimmed" p={12}>No games are being played right now.</Text>)}
        {tab === "mine" && (o.history.length ? o.history.map((g) => listGame(g, "analyse")) : <Text size="sm" c="dimmed" p={12}>Your finished games appear here.</Text>)}
        {tab === "top" && (o.leaders.length ? o.leaders.map((l, i) => (
          <div key={l.guest} className="listrow">
            <Text w={24} fw={700} c="dimmed">{i + 1}</Text>
            {i === 0 && <IconTrophy size={15} color="gold" />}
            <Text size="sm" style={{ flex: 1 }} truncate fw={l.guest === p?.id ? 800 : 500}>{l.name}{l.guest === p?.id ? " (you)" : ""}</Text>
            <Text size="xs" c="dimmed">{l.games} games</Text>
            <Text fw={700} w={44} ta="right">{l.rating}</Text>
            {l.guest !== p?.id && !o.friends.some((f) => f.id === l.guest) && (
              <Tooltip label="Add as a friend"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.addFriend({ id: l.guest, name: l.name })}><IconUserPlus size={13} /></ActionIcon></Tooltip>
            )}
          </div>
        )) : <Text size="sm" c="dimmed" p={12}>No rated games yet.</Text>)}
      </Panel>

      <Panel title="Options">
        <Switch size="xs" label="Confirm each move before it is sent" checked={o.confirmMoves} onChange={(e) => o.setOption({ confirmMoves: e.currentTarget.checked })} />
        <Switch mt={8} size="xs" label="Review my games when they end" checked={o.autoReview} onChange={(e) => o.setOption({ autoReview: e.currentTarget.checked })} />
        <Text size="xs" c="dimmed" mt={6}>Premoves: while your opponent thinks, make your next move; it plays the moment it becomes legal. Right-click to cancel.</Text>
      </Panel>
      <Text size="xs" c="dimmed" p={12}>No account needed: you play as a guest, and your rating stays on this computer, sealed so it can't be edited.</Text>
    </>
  );
}

function ArenaRow({ a }: { a: ArenaInfo }) {
  const o = useOnline();
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  return (
    <div className="listrow" style={{ cursor: "default" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={600} truncate>{a.name}</Text>
        <Text size="xs" c="dimmed">
          {tc(a.minutes, a.increment)}{a.variant !== "chess" ? ` · ${variantLabel(a.variant)}` : ""} · {a.status === "running" ? `ends in ${minutesLeft(a.endsAt - now)}` : `starts in ${minutesLeft(a.startsAt - now)}`} · {a.players ?? 0} playing{a.leader ? ` · ${a.leader} leads` : ""}
        </Text>
      </div>
      {a.status === "running" && <Badge size="xs" color="green" variant="light">Live</Badge>}
      <Button size="xs" variant={a.status === "running" ? "filled" : "default"} loading={busy} disabled={!o.ready}
        onClick={async () => { setBusy(true); try { await o.joinArena(a.id); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); } }}>Join</Button>
    </div>
  );
}

function NewArena({ onDone }: { onDone: () => void }) {
  const o = useOnline();
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState(1);
  const [variant, setVariant] = useState<OnlineVariant>("chess");
  const [startsIn, setStartsIn] = useState<number>(5);
  const [duration, setDuration] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <TextInput size="xs" label="Name" placeholder={`${o.name}'s arena`} value={title} maxLength={40} onChange={(e) => setTitle(e.currentTarget.value)} />
      <Group grow mt={6}>
        <Select size="xs" label="Time" value={String(preset)} allowDeselect={false} onChange={(v) => v && setPreset(Number(v))} data={PRESETS.map(([m, i, l], k) => ({ value: String(k), label: `${tc(m, i)} ${l}` }))} />
        <Select size="xs" label="Variant" value={variant} allowDeselect={false} onChange={(v) => v && setVariant(v as OnlineVariant)} data={ONLINE_VARIANTS} />
      </Group>
      <Group grow mt={6}>
        <NumberInput size="xs" label="Starts in (min)" min={0} max={120} value={startsIn} onChange={(v) => setStartsIn(Number(v) || 0)} />
        <NumberInput size="xs" label="Lasts (min)" min={10} max={180} value={duration} onChange={(v) => setDuration(Number(v) || 30)} />
      </Group>
      <Button mt={8} size="xs" fullWidth loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await o.createArena({ title, minutes: PRESETS[preset][0], increment: PRESETS[preset][1], variant, startsIn, duration });
          onDone();
        } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); }
      }}>Create and join</Button>
    </div>
  );
}

/** Standings and status for the arena this player is in. */
function ArenaPanel() {
  const o = useOnline();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const a = o.arena!;
  const now = Date.now();
  const me = a.players.find((x) => x.guest === o.profile?.id);
  const status = now < a.info.startsAt ? `Starts in ${clock(a.info.startsAt - now)}`
    : now >= a.info.endsAt ? "The arena is over"
    : a.paused ? "Paused: you won't be paired" : a.status === "seated" ? "In a game" : "Waiting for a pairing…";
  return (
    <Panel title={<><IconTrophy size={13} /> {a.info.name}</>} right={<Text size="xs" c="dimmed">{now < a.info.endsAt && now >= a.info.startsAt ? `${clock(a.info.endsAt - now)} left` : ""}</Text>}>
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Group gap={6}>{!a.paused && now >= a.info.startsAt && now < a.info.endsAt && a.status !== "seated" && <Loader size="xs" />}<Text fw={700} size="sm">{status}</Text></Group>
          <Text size="xs" c="dimmed">{tc(a.info.minutes, a.info.increment)}{a.info.variant !== "chess" ? ` · ${variantLabel(a.info.variant)}` : ""}{me ? ` · you: ${me.score} pts from ${me.games} games${me.streak >= 2 ? " 🔥" : ""}` : ""}</Text>
        </div>
        <Group gap={4} wrap="nowrap">
          {now < a.info.endsAt && <Button size="compact-xs" variant="default" onClick={() => o.pauseArena()}>{a.paused ? "Resume" : "Pause"}</Button>}
          <Button size="compact-xs" variant="default" color="red" onClick={() => o.leaveArena()}>Leave</Button>
        </Group>
      </Group>
      <div style={{ marginTop: 8, maxHeight: 180, overflowY: "auto" }}>
        {a.players.slice(0, 30).map((x, i) => (
          <Group key={x.guest} gap={8} wrap="nowrap" py={2} style={{ fontWeight: x.guest === o.profile?.id ? 800 : undefined }}>
            <Text size="xs" w={18} c="dimmed">{i + 1}</Text>
            <span className={"presence" + (x.active ? " on" : "")} />
            <Text size="sm" style={{ flex: 1 }} truncate>{x.name}{x.streak >= 2 ? " 🔥" : ""}</Text>
            {x.playing && <IconSwords size={12} />}
            <Text size="xs" c="dimmed">{x.games}g</Text>
            <Text size="sm" fw={700} w={30} ta="right">{x.score}</Text>
          </Group>
        ))}
        {!a.players.length && <Text size="xs" c="dimmed">Nobody has joined yet.</Text>}
      </div>
    </Panel>
  );
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

/** Reviews a finished game with the default engine and turns its mistakes into puzzles. */
function useAutoReview(g: GameView, mine: Color | undefined) {
  const o = useOnline();
  const [state, setState] = useState<{ progress: number; summary?: ReviewSummary; tree?: GameTree; added?: number; error?: string }>();
  useEffect(() => {
    setState(undefined);
    if (!mine || !o.autoReview || g.status !== "finished" || g.result === "aborted" || g.moves.length < 8) return;
    if (rulesOfVariant(g.variant) !== "chess") return; // The default engine may not play the variant.
    const entry = resolveEngine();
    if (!entry) return;
    let cancelled = false;
    let engine: Engine | undefined;
    (async () => {
      const tree = o.toTree(g);
      setState({ progress: 0 });
      engine = await launch(entry);
      const done = await reviewGame(tree, engine, 150, (d, n) => !cancelled && setState({ progress: (d / n) * 100 }), () => cancelled);
      engine.quit();
      engine = undefined;
      if (!done || cancelled) return;
      const summary = summarise(tree);
      const added = usePuzzles.getState().addMistakes(mistakePuzzles(tree, mine));
      setState({ progress: 100, summary, tree, added });
    })().catch((e) => !cancelled && setState({ progress: 0, error: e.message }));
    return () => { cancelled = true; engine?.quit(); };
  }, [g.id, g.status, o.autoReview]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

interface Floating { id: number; emoji: string; left: number }

/** An online game being played or watched. */
export function OnlineGame() {
  const o = useOnline();
  const app = useApp();
  const g = o.game!;
  const seat = o.seat?.id === g.id ? o.seat : undefined;
  const [flipped, setFlipped] = useState(false);
  const [message, setMessage] = useState("");
  const [roomMessage, setRoomMessage] = useState("");
  const [chatTab, setChatTab] = useState<string>(seat ? "players" : "room");
  const [pending, setPending] = useState<string>();
  const [floating, setFloating] = useState<Floating[]>([]);
  const seenRoom = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(t); }, []);
  useEffect(() => { setPending(undefined); }, [g.ply, g.id]);
  const tree = useMemo(() => { const t = o.toTree(g); t.toEnd(); return t; }, [g.id, g.ply, g.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useTree(tree);
  const review = useAutoReview(g, seat?.color);

  // New reactions float up over the board.
  useEffect(() => {
    const fresh = o.room.filter((l) => l.kind === "react" && l.id > seenRoom.current && Date.now() - l.at < 15_000);
    if (o.room.length) seenRoom.current = Math.max(seenRoom.current, ...o.room.map((l) => l.id));
    if (!fresh.length) return;
    const add = fresh.map((l) => ({ id: l.id, emoji: l.text, left: 10 + Math.random() * 80 }));
    setFloating((f) => [...f, ...add]);
    setTimeout(() => setFloating((f) => f.filter((x) => !add.includes(x))), 2800);
  }, [o.room]);

  const mine: Color | undefined = seat?.color;
  const opponent = mine ? other(mine) : undefined;
  const bottom: Color = (mine ?? "white") === "white" ? (flipped ? "black" : "white") : flipped ? "white" : "black";
  const top: Color = other(bottom);
  const turn: Color = g.ply % 2 === 0 ? "white" : "black";
  const clocks = shownClocks(g, o.receivedAt);
  const atEnd = tree.current === tree.last;
  const canMove = !!mine && g.status === "playing" && turn === mine && atEnd && !pending;
  const canPremove = !!mine && g.status === "playing" && turn !== mine && atEnd;

  // With move confirmation on, the board shows the move waiting to be sent.
  const shown = useMemo(() => {
    if (!pending) return { fen: tree.fen, lastMove: tree.current.lastMove };
    const t = tree.clone();
    t.toEnd();
    return t.play(pending) ? { fen: t.fen, lastMove: t.current.lastMove } : { fen: tree.fen, lastMove: tree.current.lastMove };
  }, [pending, tree]);

  const sendMove = (uci: string) => (o.confirmMoves ? setPending(uci) : o.move(uci));
  useEffect(() => {
    if (!pending) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter") { o.move(pending); setPending(undefined); }
      if (e.key === "Escape") setPending(undefined);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  const strip = (c: Color) => {
    const s = g[c];
    const change = s.after != null && s.rating != null ? s.after - s.rating : undefined;
    return (
      <PlayerStrip name={s.name ?? (g.status === "waiting" ? (o.challenging ? `Waiting for ${o.challenging.name}…` : "Waiting for an opponent…") : "?")} color={c}
        detail={s.rating != null ? `${s.rating}${change !== undefined ? ` ${change >= 0 ? "+" : ""}${change}` : ""}` : undefined}
        clock={g.status === "waiting" ? undefined : clocks[c] / 1000} active={g.status === "playing" && turn === c} />
    );
  };

  const opponentOffers = g.drawOffer && g.drawOffer !== mine && g.status === "playing";
  const iOffered = g.drawOffer && g.drawOffer === mine;
  const queued = !!o.queue && g.status === "waiting";
  const range = ratingWindow(Date.now() - (o.queuedAt ?? Date.now()));
  const variant = g.variant && g.variant !== "chess" ? variantLabel(g.variant) : undefined;
  const resultText = g.status === "finished" ? (g.result === "aborted" ? "Game aborted" : `${g.result} · ${g.reason}`)
    : queued ? "Looking for an opponent…"
    : g.status === "waiting" ? (o.challenging ? `Challenge sent to ${o.challenging.name}` : `Share the code ${g.code}`)
    : g.running ? `${turn === "white" ? "White" : "Black"} to move` : "White to move; the clock starts after the first move";

  // The opponent has gone quiet: count down to when the game can be claimed.
  const away = opponent && g.status === "playing" && g.away?.[opponent] != null ? g.away[opponent]! + (Date.now() - o.receivedAt) : 0;
  const gone = away > 8000;
  const claimable = away >= ABANDON_MS && g.ply >= 2;

  const opp = opponent ? g[opponent] : undefined;
  const canFriend = !!opp?.guest && opp.guest !== o.profile?.id && !o.friends.some((f) => f.id === opp.guest);
  const arenaBreak = g.arena && o.arena?.info.id === g.arena && g.status === "finished" && seat ? Math.max(0, ARENA_BREAK_MS - (Date.now() - (o.endedAt ?? 0))) : undefined;
  const roomTalk = o.room.filter((l) => l.kind === "text");

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow" style={{ position: "relative" }}>
          <Board fen={shown.fen} rules={tree.rules} chess960={tree.chess960} orientation={bottom} lastMove={shown.lastMove} movable={canMove ? mine : undefined}
            onMove={(m) => { const pos = positionOf(tree.fen, tree.rules); sendMove(uciOf(pos, m, tree.chess960)); }}
            premove={canPremove ? { color: mine!, onSet: (a, b) => o.setPremove([a, b]), onUnset: () => o.setPremove(undefined) } : undefined} />
          <div className="reactions">{floating.map((f) => <span key={f.id} className="reaction" style={{ left: `${f.left}%` }}>{f.emoji}</span>)}</div>
        </div>
        {strip(bottom)}
      </div>
      <div className="sidecol">
        <Panel title={<>{seat ? <IconSwords size={13} /> : <IconEye size={13} />} {seat ? (g.status === "finished" ? "Finished" : g.status === "waiting" ? "Waiting" : "Playing") : "Watching"} · {tc(g.minutes, g.increment)}{variant ? ` · ${variant}` : ""} · {g.arena ? "arena" : g.rated ? "rated" : "casual"}</>}
          right={seat && (o.offline ? (
            <Badge variant="light" color="red" leftSection={<IconWifiOff size={11} />}>Reconnecting</Badge>
          ) : (
            <Tooltip label={o.link === "direct" ? "Moves go straight to your opponent" : o.link === "relay" ? "No direct connection: moves go through Castle's server" : "Connecting to your opponent…"}>
              <Badge variant="light" color={o.link === "direct" ? "green" : o.link === "relay" ? "yellow" : "gray"} leftSection={<IconPlugConnected size={11} />}>{o.link === "direct" ? "Direct" : o.link === "relay" ? "Relayed" : "Connecting"}</Badge>
            </Tooltip>
          ))}>
          <Group gap={8} wrap="nowrap">{(queued || (o.challenging && g.status === "waiting")) && <Loader size="xs" />}<Text fw={700}>{resultText}</Text></Group>
          {queued ? <Text size="sm" c="dimmed">In the queue for {tc(o.queue!.minutes, o.queue!.increment)} {variantLabel(o.queue!.variant)}, {o.queue!.rated ? "rated" : "casual"}. {range === Infinity ? "Open to any rating now." : `Looking within ±${range} of your rating.`}</Text>
            : g.status === "waiting" && !o.challenging && <Text size="sm" c="dimmed">{g.public ? "Anyone in the lobby can take it." : "Only someone with the code can join."} It starts as soon as they join.</Text>}
          {pending && (
            <Alert mt={8} p="xs" color="blue">
              <Text size="sm">Send this move?</Text>
              <Group gap={6} mt={4}>
                <Button size="xs" onClick={() => { o.move(pending); setPending(undefined); }}>Confirm ⏎</Button>
                <Button size="xs" variant="default" onClick={() => setPending(undefined)}>Take back ⎋</Button>
              </Group>
            </Alert>
          )}
          {o.premove && canPremove && <Text size="xs" c="dimmed" mt={4}>Premove {o.premove[0]}–{o.premove[1]} queued.</Text>}
          {gone && (
            <Alert mt={8} p="xs" color="orange" icon={<IconWifiOff size={16} />}>
              <Text size="sm">{opp?.name ?? "Your opponent"} has left the game.</Text>
              {claimable ? (
                <Group gap={6} mt={4}>
                  <Button size="xs" color="orange" onClick={() => o.act("claim")}>Claim victory</Button>
                  <Button size="xs" variant="default" onClick={() => o.act("claim-draw")}>Call it a draw</Button>
                </Group>
              ) : <Text size="xs" c="dimmed">{g.ply < 2 ? "If they don't move, the game is aborted." : `You can claim the game in ${Math.ceil((ABANDON_MS - away) / 1000)} s if they don't come back.`}</Text>}
            </Alert>
          )}
          {o.error && <Text size="xs" c="red" mt={4}>{o.error}</Text>}
          {seat && (
            <Group gap={6} mt={8}>
              {g.status === "waiting" && <Button size="xs" variant="default" onClick={() => o.leaveQueue()}>{queued ? "Leave queue" : o.challenging ? "Withdraw" : "Cancel"}</Button>}
              {g.status === "playing" && g.ply < 2 && <Button size="xs" variant="default" onClick={() => o.act("abort")}>Abort</Button>}
              {g.status === "playing" && g.ply >= 2 && <Button size="xs" variant="default" color="red" leftSection={<IconFlag size={13} />} onClick={() => o.act("resign")}>Resign</Button>}
              {g.status === "playing" && g.ply >= 2 && !opponentOffers && <Button size="xs" variant="default" disabled={!!iOffered} leftSection={<IconHandStop size={13} />} onClick={() => o.act("draw")}>{iOffered ? "Draw offered" : "Offer draw"}</Button>}
              {opponentOffers && <><Button size="xs" onClick={() => o.act("draw")}>Accept draw</Button><Button size="xs" variant="default" onClick={() => o.act("decline")}>Decline</Button></>}
              {g.status === "finished" && !g.arena && <Button size="xs" onClick={() => o.act("rematch")}>{g.rematch ? "Accept rematch" : "Rematch"}</Button>}
              {canFriend && g.status !== "waiting" && <Button size="xs" variant="subtle" leftSection={<IconUserPlus size={13} />} onClick={() => o.addFriend({ id: opp!.guest!, name: opp!.name ?? "Friend" })}>Add friend</Button>}
            </Group>
          )}
          {arenaBreak !== undefined && <Text size="sm" mt={6} c="dimmed">{arenaBreak > 0 ? `Next arena pairing in ${Math.ceil(arenaBreak / 1000)} s…` : "Looking for your next arena opponent…"}</Text>}
          {g.status === "finished" && seat && g.rated && g[seat.color].after != null && o.profile && (
            <Text size="sm" mt={6}>Your rating is now <b>{o.profile.rating}</b>.</Text>
          )}
        </Panel>
        {review && (
          <Panel title="Game review">
            {review.error ? <Text size="xs" c="red">{review.error}</Text> : review.progress < 100 ? (
              <>
                <Text size="xs" c="dimmed">Checking every move with the engine…</Text>
                <Progress mt={6} size="sm" value={review.progress} animated />
              </>
            ) : review.summary && mine ? (
              <>
                <Group grow>
                  {([mine, other(mine)] as Color[]).map((c) => (
                    <div key={c}>
                      <Text size="xs" c="dimmed">{c === mine ? "You" : g[c].name}</Text>
                      <Text fw={800} fz={20} ff="ui-rounded, system-ui">{review.summary!.accuracy[c] !== undefined ? `${Math.round(review.summary!.accuracy[c]!)}%` : "–"}</Text>
                      <Text size="xs" c="dimmed">{review.summary!.blunders[c]} blunders · {review.summary!.mistakes[c]} mistakes · {review.summary!.inaccuracies[c]} inaccuracies</Text>
                    </div>
                  ))}
                </Group>
                {!!review.added && <Text size="xs" mt={6}>{review.added} of your mistakes are now puzzles under Puzzles, My mistakes.</Text>}
                <Button mt={8} size="xs" variant="light" onClick={() => review.tree && app.openGame(review.tree)}>Open the review</Button>
              </>
            ) : <Text size="xs" c="dimmed">Not enough to review.</Text>}
          </Panel>
        )}
        <Panel grow pad={false} title="Moves"><MoveList tree={tree} editable={false} /></Panel>
        <Panel title={seat ? (
          <SegmentedControl size="xs" value={chatTab} onChange={setChatTab} data={[{ value: "players", label: "Opponent" }, { value: "room", label: `Spectators${roomTalk.length ? ` (${roomTalk.length})` : ""}` }]} />
        ) : "Spectators"}>
          {chatTab === "players" && seat ? (
            <>
              <div style={{ maxHeight: 130, overflowY: "auto" }} className="selectable">
                {o.chat.length ? o.chat.map((c, i) => (
                  <Text key={i} size="sm" c={c.from === "system" ? "dimmed" : undefined}>{c.from === "system" ? c.text : <><b>{c.from === mine ? "You" : g[c.from].name}:</b> {c.text}</>}</Text>
                )) : <Text size="xs" c="dimmed">{o.link === "direct" ? "Say hello. Chat goes directly to your opponent." : "Chat opens once you are connected directly."}</Text>}
              </div>
              <Group gap={6} mt={6} wrap="nowrap">
                <TextInput style={{ flex: 1 }} size="xs" placeholder="Message" disabled={o.link !== "direct"} value={message} onChange={(e) => setMessage(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { o.say(message); setMessage(""); } }} />
                <Button size="xs" variant="default" disabled={o.link !== "direct"} onClick={() => { o.say(message); setMessage(""); }}><IconSend size={13} /></Button>
              </Group>
            </>
          ) : (
            <>
              <div style={{ maxHeight: 130, overflowY: "auto" }} className="selectable">
                {roomTalk.length ? roomTalk.map((l) => <Text key={l.id} size="sm"><b>{l.name}:</b> {l.text}</Text>)
                  : <Text size="xs" c="dimmed">Anyone watching can talk here{seat ? "; your opponent can read it too" : ""}.</Text>}
              </div>
              <Group gap={6} mt={6} wrap="nowrap">
                <TextInput style={{ flex: 1 }} size="xs" placeholder="Say something to the room" maxLength={200} value={roomMessage} onChange={(e) => setRoomMessage(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { o.sayToRoom(roomMessage); setRoomMessage(""); } }} />
                <Button size="xs" variant="default" onClick={() => { o.sayToRoom(roomMessage); setRoomMessage(""); }}><IconSend size={13} /></Button>
              </Group>
            </>
          )}
          <Group gap={2} mt={6}>
            {REACTIONS.map((r) => <button key={r} className="react-button" onClick={() => o.sayToRoom(r, "react")}>{r}</button>)}
          </Group>
        </Panel>
        <div style={{ padding: 12, display: "flex", gap: 6 }}>
          <Button variant="default" style={{ flex: 1 }} onClick={() => setFlipped(!flipped)}>Flip</Button>
          <Button variant="default" style={{ flex: 1 }} disabled={!g.moves.length} onClick={() => app.openGame(o.toTree(g))}>Analyse</Button>
          <Button variant="default" style={{ flex: 1 }} disabled={!!seat && g.status === "playing"} onClick={() => (seat && g.status === "waiting" ? o.leaveQueue() : o.leave())}>Back</Button>
        </div>
      </div>
    </div>
  );
}
