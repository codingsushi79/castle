import { Alert, Badge, Button, Group, SegmentedControl, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconBroadcast, IconEye, IconFlag, IconHandStop, IconPlugConnected, IconRefresh, IconSend, IconSwords, IconTrophy, IconUsers } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Board } from "../components/Board";
import { MoveList, Panel, PlayerStrip } from "../components/common";
import { Color, uciOf, positionOf } from "../lib/chess";
import { GameView, shownClocks, useOnline } from "../lib/online";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";

const PRESETS: [number, number, string][] = [[1, 0, "Bullet"], [3, 2, "Blitz"], [5, 0, "Blitz"], [10, 0, "Rapid"], [15, 10, "Rapid"], [30, 0, "Classical"]];
const tc = (minutes: number, increment: number) => `${minutes < 1 ? minutes.toFixed(1) : minutes}+${increment}`;

export default function OnlinePage() {
  const o = useOnline();
  useEffect(() => { if (!o.ready) o.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return o.game ? <GameScreen /> : <Lobby />;
}

function Lobby() {
  const o = useOnline();
  const app = useApp();
  const [preset, setPreset] = useState<number>(load("onlinePreset", 2));
  const [color, setColor] = useState("random");
  const [rated, setRated] = useState<boolean>(load("onlineRated", true));
  const [isPublic, setPublic] = useState(true);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<string>(load("onlineTab", "live"));

  useEffect(() => {
    if (!o.ready) return;
    o.refreshLobby();
    const t = setInterval(o.refreshLobby, 4000);
    return () => clearInterval(t);
  }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try { await f(); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); }
  };
  const p = o.profile;
  const listGame = (g: GameView, action: "watch" | "analyse") => (
    <div key={g.id} className="listrow" onClick={() => (action === "watch" ? o.watch(g.id) : app.openGame(o.toTree(g)))}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" truncate><b>{g.white.name}</b> {g.white.rating ?? ""} – <b>{g.black.name}</b> {g.black.rating ?? ""}</Text>
        <Text size="xs" c="dimmed">{tc(g.minutes, g.increment)} · {g.rated ? "rated" : "casual"} · {g.ply} plies{g.result ? ` · ${g.result === "aborted" ? "aborted" : `${g.result} by ${g.reason}`}` : ""}</Text>
      </div>
      {action === "watch" ? <IconEye size={16} /> : <Text size="xs" c="dimmed">Analyse</Text>}
    </div>
  );

  return (
    <div className="page scroll">
      <div style={{ maxWidth: 1000, width: "100%", margin: "0 auto" }}>
        <Group mb="md" align="center">
          <IconBroadcast size={28} color="var(--mantine-primary-color-filled)" />
          <div style={{ flex: 1 }}>
            <Text fw={800} fz={22}>Castle Online</Text>
            <Text size="sm" c="dimmed">Play anyone with Castle. No account, no password: you are a guest, and your rating stays on this computer, sealed so it can't be edited.</Text>
          </div>
          <Button variant="default" leftSection={<IconRefresh size={14} />} onClick={() => o.refreshLobby()}>Refresh</Button>
        </Group>
        {o.error && <Alert color="orange" mb="md" withCloseButton onClose={() => useOnline.setState({ error: undefined })}>{o.error}</Alert>}

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", marginBottom: 16 }}>
          <div className="card">
            <Text fw={700} mb={6}>You</Text>
            <TextInput label="Name shown to opponents" value={o.name} maxLength={24} onChange={(e) => o.setName(e.currentTarget.value)} />
            {p ? (
              <Group mt="sm" gap="lg">
                <div><Text fz={28} fw={800} ff="ui-rounded, system-ui">{p.rating}</Text><Text size="xs" c="dimmed">rating{p.games < 10 ? " (provisional)" : ""}</Text></div>
                <div><Text fw={700}>{p.wins} / {p.draws} / {p.losses}</Text><Text size="xs" c="dimmed">won / drawn / lost</Text></div>
                <div><Text fw={700}>{p.peak}</Text><Text size="xs" c="dimmed">peak</Text></div>
              </Group>
            ) : <Text size="sm" c="dimmed" mt="sm">{o.error ? "Offline." : "Connecting…"}</Text>}
          </div>

          <div className="card">
            <Text fw={700} mb={6}>New game</Text>
            <Group gap={6}>
              {PRESETS.map(([m, i, label], k) => (
                <Button key={k} size="xs" variant={preset === k ? "filled" : "default"} onClick={() => { setPreset(k); save("onlinePreset", k); }}>
                  {tc(m, i)} <Text span size="xs" c={preset === k ? undefined : "dimmed"} ml={4}>{label}</Text>
                </Button>
              ))}
            </Group>
            <SegmentedControl mt="sm" size="xs" fullWidth value={color} onChange={setColor} data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }]} />
            <Group mt="sm" gap="lg">
              <Switch size="xs" label="Rated" checked={rated} onChange={(e) => { setRated(e.currentTarget.checked); save("onlineRated", e.currentTarget.checked); }} />
              <Tooltip label="Off: only someone with the code can join"><Switch size="xs" label="Listed in the lobby" checked={isPublic} onChange={(e) => setPublic(e.currentTarget.checked)} /></Tooltip>
            </Group>
            <Button mt="sm" fullWidth loading={busy} disabled={!o.ready} leftSection={<IconSwords size={15} />}
              onClick={() => run(() => o.create({ minutes: PRESETS[preset][0], increment: PRESETS[preset][1], color, rated, public: isPublic }))}>Create game</Button>
            <Group mt="sm" gap={6} wrap="nowrap">
              <TextInput style={{ flex: 1 }} placeholder="Join with a code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && code && run(() => o.join(code))} />
              <Button variant="default" disabled={!code || !o.ready} loading={busy} onClick={() => run(() => o.join(code))}>Join</Button>
            </Group>
          </div>
        </div>

        <Panel title={<><IconUsers size={13} /> Waiting for an opponent</>} pad={false}>
          {o.open.length ? o.open.map((s) => (
            <div key={s.id} className="listrow">
              <div style={{ flex: 1 }}>
                <Text size="sm"><b>{s.name}</b> {s.rating}</Text>
                <Text size="xs" c="dimmed">{tc(s.minutes, s.increment)} · {s.rated ? "rated" : "casual"} · {s.color === "random" ? "random colours" : `plays ${s.color}`}</Text>
              </div>
              <Button size="xs" disabled={!o.ready} onClick={() => run(() => o.join(s.code))}>Play</Button>
            </div>
          )) : <Text size="sm" c="dimmed" p={12}>Nobody is waiting. Create a game and it shows up here for others.</Text>}
        </Panel>

        <div style={{ marginTop: 12 }}>
          <SegmentedControl value={tab} onChange={(v) => { setTab(v); save("onlineTab", v); }} data={[{ value: "live", label: `Watch live (${o.live.length})` }, { value: "recent", label: "Just finished" }, { value: "mine", label: "My games" }, { value: "top", label: "Leaderboard" }]} />
          <Panel pad={false}>
            {tab === "live" && (o.live.length ? o.live.map((g) => listGame(g, "watch")) : <Text size="sm" c="dimmed" p={12}>No games are being played right now.</Text>)}
            {tab === "recent" && (o.recent.length ? o.recent.map((g) => listGame(g, "analyse")) : <Text size="sm" c="dimmed" p={12}>No finished games yet.</Text>)}
            {tab === "mine" && (o.history.length ? o.history.map((g) => listGame(g, "analyse")) : <Text size="sm" c="dimmed" p={12}>Your finished games appear here.</Text>)}
            {tab === "top" && (o.leaders.length ? o.leaders.map((l, i) => (
              <div key={l.guest} className="listrow">
                <Text w={28} fw={700} c="dimmed">{i + 1}</Text>
                {i === 0 && <IconTrophy size={15} color="gold" />}
                <Text size="sm" style={{ flex: 1 }} fw={l.guest === p?.id ? 800 : 500}>{l.name}{l.guest === p?.id ? " (you)" : ""}</Text>
                <Text size="xs" c="dimmed">{l.games} games</Text>
                <Text fw={700} w={48} ta="right">{l.rating}</Text>
              </div>
            )) : <Text size="sm" c="dimmed" p={12}>No rated games yet.</Text>)}
          </Panel>
        </div>
      </div>
    </div>
  );
}

function GameScreen() {
  const o = useOnline();
  const app = useApp();
  const g = o.game!;
  const seat = o.seat?.id === g.id ? o.seat : undefined;
  const [flipped, setFlipped] = useState(false);
  const [message, setMessage] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(t); }, []);
  const tree = useMemo(() => { const t = o.toTree(g); t.toEnd(); return t; }, [g.id, g.ply, g.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useTree(tree);

  const mine: Color | undefined = seat?.color;
  const bottom: Color = (mine ?? "white") === "white" ? (flipped ? "black" : "white") : flipped ? "white" : "black";
  const top: Color = bottom === "white" ? "black" : "white";
  const turn: Color = g.ply % 2 === 0 ? "white" : "black";
  const clocks = shownClocks(g, o.receivedAt);
  const atEnd = tree.current === tree.last;
  const canMove = !!mine && g.status === "playing" && turn === mine && atEnd;

  const strip = (c: Color) => {
    const s = g[c];
    const change = s.after != null && s.rating != null ? s.after - s.rating : undefined;
    return (
      <PlayerStrip name={s.name ?? (g.status === "waiting" ? "Waiting for an opponent…" : "?")} color={c}
        detail={s.rating != null ? `${s.rating}${change !== undefined ? ` ${change >= 0 ? "+" : ""}${change}` : ""}` : undefined}
        clock={g.status === "waiting" ? undefined : clocks[c] / 1000} active={g.status === "playing" && turn === c} />
    );
  };

  const opponentOffers = g.drawOffer && g.drawOffer !== mine && g.status === "playing";
  const iOffered = g.drawOffer && g.drawOffer === mine;
  const resultText = g.status === "finished" ? (g.result === "aborted" ? "Game aborted" : `${g.result} · ${g.reason}`) : g.status === "waiting" ? `Share the code ${g.code}` : g.running ? `${turn === "white" ? "White" : "Black"} to move` : "White to move; the clock starts after the first move";

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow">
          <Board fen={tree.fen} orientation={bottom} lastMove={tree.current.lastMove} movable={canMove ? mine : undefined}
            onMove={(m) => { const pos = positionOf(tree.fen); o.move(uciOf(pos, m, false)); }} />
        </div>
        {strip(bottom)}
      </div>
      <div className="sidecol">
        <Panel title={<>{seat ? <IconSwords size={13} /> : <IconEye size={13} />} {seat ? (g.status === "finished" ? "Finished" : g.status === "waiting" ? "Waiting" : "Playing") : "Watching"} · {tc(g.minutes, g.increment)} · {g.rated ? "rated" : "casual"}</>}
          right={seat && (
            <Tooltip label={o.link === "direct" ? "Moves go straight to your opponent" : o.link === "relay" ? "No direct connection: moves go through Castle's server" : "Connecting to your opponent…"}>
              <Badge variant="light" color={o.link === "direct" ? "green" : o.link === "relay" ? "yellow" : "gray"} leftSection={<IconPlugConnected size={11} />}>{o.link === "direct" ? "Direct" : o.link === "relay" ? "Relayed" : "Connecting"}</Badge>
            </Tooltip>
          )}>
          <Text fw={700}>{resultText}</Text>
          {g.status === "waiting" && <Text size="sm" c="dimmed">Anyone in the lobby can take it{g.public ? "" : " if they have the code"}. It starts as soon as they join.</Text>}
          {o.error && <Text size="xs" c="red" mt={4}>{o.error}</Text>}
          {seat && (
            <Group gap={6} mt={8}>
              {g.status === "waiting" && <Button size="xs" variant="default" onClick={() => o.act("resign").then(o.leave)}>Cancel</Button>}
              {g.status === "playing" && g.ply < 2 && <Button size="xs" variant="default" onClick={() => o.act("abort")}>Abort</Button>}
              {g.status === "playing" && g.ply >= 2 && <Button size="xs" variant="default" color="red" leftSection={<IconFlag size={13} />} onClick={() => o.act("resign")}>Resign</Button>}
              {g.status === "playing" && g.ply >= 2 && !opponentOffers && <Button size="xs" variant="default" disabled={!!iOffered} leftSection={<IconHandStop size={13} />} onClick={() => o.act("draw")}>{iOffered ? "Draw offered" : "Offer draw"}</Button>}
              {opponentOffers && <><Button size="xs" onClick={() => o.act("draw")}>Accept draw</Button><Button size="xs" variant="default" onClick={() => o.act("decline")}>Decline</Button></>}
              {g.status === "finished" && <Button size="xs" onClick={() => o.act("rematch")}>{g.rematch ? "Accept rematch" : "Rematch"}</Button>}
            </Group>
          )}
          {g.status === "finished" && seat && g.rated && g[seat.color].after != null && o.profile && (
            <Text size="sm" mt={6}>Your rating is now <b>{o.profile.rating}</b>.</Text>
          )}
        </Panel>
        <Panel grow pad={false} title="Moves"><MoveList tree={tree} editable={false} /></Panel>
        {seat && (
          <Panel title="Chat">
            <div style={{ maxHeight: 140, overflowY: "auto" }} className="selectable">
              {o.chat.length ? o.chat.map((c, i) => (
                <Text key={i} size="sm" c={c.from === "system" ? "dimmed" : undefined}>{c.from === "system" ? c.text : <><b>{c.from === mine ? "You" : g[c.from].name}:</b> {c.text}</>}</Text>
              )) : <Text size="xs" c="dimmed">{o.link === "direct" ? "Say hello. Chat goes directly to your opponent." : "Chat opens once you are connected directly."}</Text>}
            </div>
            <Group gap={6} mt={6} wrap="nowrap">
              <TextInput style={{ flex: 1 }} size="xs" placeholder="Message" disabled={o.link !== "direct"} value={message} onChange={(e) => setMessage(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { o.say(message); setMessage(""); } }} />
              <Button size="xs" variant="default" disabled={o.link !== "direct"} onClick={() => { o.say(message); setMessage(""); }}><IconSend size={13} /></Button>
            </Group>
          </Panel>
        )}
        <div style={{ padding: 12, display: "flex", gap: 6 }}>
          <Button variant="default" style={{ flex: 1 }} onClick={() => setFlipped(!flipped)}>Flip</Button>
          <Button variant="default" style={{ flex: 1 }} disabled={!g.moves.length} onClick={() => app.openGame(o.toTree(g))}>Analyse</Button>
          <Button variant="default" style={{ flex: 1 }} disabled={!!seat && g.status === "playing"} onClick={() => o.leave()}>Lobby</Button>
        </div>
      </div>
    </div>
  );
}
