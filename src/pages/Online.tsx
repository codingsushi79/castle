import { Alert, Badge, Button, Group, Loader, SegmentedControl, Switch, Text, TextInput, Tooltip } from "@mantine/core";
import { IconBolt, IconBroadcast, IconEye, IconFlag, IconHandStop, IconPlugConnected, IconRefresh, IconSearch, IconSend, IconSwords, IconTrophy, IconUsers } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Board } from "../components/Board";
import { MoveList, Panel, PlayerStrip } from "../components/common";
import { Color, uciOf, positionOf } from "../lib/chess";
import { GameView, shownClocks, useOnline } from "../lib/online";
import { usePlay } from "../lib/play";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";

const PRESETS: [number, number, string][] = [[1, 0, "Bullet"], [3, 2, "Blitz"], [5, 0, "Blitz"], [10, 0, "Rapid"], [15, 10, "Rapid"], [30, 0, "Classical"]];
const tc = (minutes: number, increment: number) => `${minutes < 1 ? minutes.toFixed(1) : minutes}+${increment}`;

/** Castle Online now lives on the Play page; the old page id still leads there. */
export default function OnlinePage() {
  const go = useApp((s) => s.go);
  useEffect(() => {
    if (usePlay.getState().phase === "setup") usePlay.getState().patch({ opponent: "online" });
    go("play");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <></>;
}

/** The Play page's sidebar when the opponent is "Online": queue, friends, lobby. */
export function OnlinePanels() {
  const o = useOnline();
  const app = useApp();
  const [preset, setPreset] = useState<number>(load("onlinePreset", 2));
  const [color, setColor] = useState("random");
  const [rated, setRated] = useState<boolean>(load("onlineRated", true));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [tab, setTab] = useState<string>(load("onlineTab", "open"));

  useEffect(() => { if (!o.ready) o.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!o.ready) return;
    o.refreshLobby();
    const t = setInterval(o.refreshLobby, 4000);
    return () => clearInterval(t);
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
        <Text size="xs" c="dimmed">{tc(g.minutes, g.increment)} · {g.rated ? "rated" : "casual"} · {g.ply} plies{g.result ? ` · ${g.result === "aborted" ? "aborted" : `${g.result} by ${g.reason}`}` : ""}</Text>
      </div>
      {action === "watch" ? <IconEye size={16} /> : <Text size="xs" c="dimmed">Analyse</Text>}
    </div>
  );

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
        <Switch mt="sm" size="xs" label="Rated" checked={rated} onChange={(e) => { setRated(e.currentTarget.checked); save("onlineRated", e.currentTarget.checked); }} />
        <Button mt="sm" fullWidth size="md" loading={busy === "queue"} disabled={!o.ready} leftSection={<IconSearch size={16} />}
          onClick={() => run("queue", () => o.quickPair({ minutes, increment, rated }))}>Find an opponent</Button>
        <Text size="xs" c="dimmed" mt={6}>Joins someone waiting for {tc(minutes, increment)}, or puts you in the queue until someone is.</Text>
      </Panel>

      <Panel title={<><IconUsers size={13} /> Play a friend</>}>
        <SegmentedControl size="xs" fullWidth value={color} onChange={setColor} data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }]} />
        <Button mt="sm" fullWidth variant="light" loading={busy === "create"} disabled={!o.ready} leftSection={<IconSwords size={15} />}
          onClick={() => run("create", () => o.create({ minutes, increment, color, rated, public: false }))}>Create a private {tc(minutes, increment)} game</Button>
        <Group mt="sm" gap={6} wrap="nowrap">
          <TextInput style={{ flex: 1 }} size="xs" placeholder="Join with a code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && code && run("join", () => o.join(code))} />
          <Button size="xs" variant="default" disabled={!code || !o.ready} loading={busy === "join"} onClick={() => run("join", () => o.join(code))}>Join</Button>
        </Group>
      </Panel>

      <Panel title={<><IconBroadcast size={13} /> Lobby</>} pad={false} right={<Tooltip label="Refresh"><span className="pressable" onClick={() => o.refreshLobby()}><IconRefresh size={13} /></span></Tooltip>}>
        <div style={{ padding: "8px 12px" }}>
          <SegmentedControl size="xs" fullWidth value={tab} onChange={(v) => { setTab(v); save("onlineTab", v); }}
            data={[{ value: "open", label: `Seeks (${o.open.length})` }, { value: "live", label: `Live (${o.live.length})` }, { value: "mine", label: "Mine" }, { value: "top", label: "Top" }]} />
        </div>
        {tab === "open" && (o.open.length ? o.open.map((s) => (
          <div key={s.id} className="listrow">
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" truncate><b>{s.name}</b> {s.rating}</Text>
              <Text size="xs" c="dimmed">{tc(s.minutes, s.increment)} · {s.rated ? "rated" : "casual"} · {s.color === "random" ? "random colours" : `plays ${s.color}`}</Text>
            </div>
            <Button size="xs" disabled={!o.ready} onClick={() => run("join", () => o.join(s.code))}>Play</Button>
          </div>
        )) : <Text size="sm" c="dimmed" p={12}>Nobody is waiting. Find an opponent and you show up here for others.</Text>)}
        {tab === "live" && (o.live.length ? o.live.map((g) => listGame(g, "watch")) : <Text size="sm" c="dimmed" p={12}>No games are being played right now.</Text>)}
        {tab === "mine" && (o.history.length ? o.history.map((g) => listGame(g, "analyse")) : <Text size="sm" c="dimmed" p={12}>Your finished games appear here.</Text>)}
        {tab === "top" && (o.leaders.length ? o.leaders.map((l, i) => (
          <div key={l.guest} className="listrow">
            <Text w={24} fw={700} c="dimmed">{i + 1}</Text>
            {i === 0 && <IconTrophy size={15} color="gold" />}
            <Text size="sm" style={{ flex: 1 }} truncate fw={l.guest === p?.id ? 800 : 500}>{l.name}{l.guest === p?.id ? " (you)" : ""}</Text>
            <Text size="xs" c="dimmed">{l.games} games</Text>
            <Text fw={700} w={44} ta="right">{l.rating}</Text>
          </div>
        )) : <Text size="sm" c="dimmed" p={12}>No rated games yet.</Text>)}
      </Panel>
      <Text size="xs" c="dimmed" p={12}>No account needed: you play as a guest, and your rating stays on this computer, sealed so it can't be edited.</Text>
    </>
  );
}

/** An online game being played or watched. */
export function OnlineGame() {
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
  const queued = !!o.queue && g.status === "waiting";
  const resultText = g.status === "finished" ? (g.result === "aborted" ? "Game aborted" : `${g.result} · ${g.reason}`) : queued ? "Looking for an opponent…" : g.status === "waiting" ? `Share the code ${g.code}` : g.running ? `${turn === "white" ? "White" : "Black"} to move` : "White to move; the clock starts after the first move";

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
          <Group gap={8} wrap="nowrap">{queued && <Loader size="xs" />}<Text fw={700}>{resultText}</Text></Group>
          {queued ? <Text size="sm" c="dimmed">In the queue for {tc(o.queue!.minutes, o.queue!.increment)} {o.queue!.rated ? "rated" : "casual"}. The game starts as soon as someone is paired with you.</Text>
            : g.status === "waiting" && <Text size="sm" c="dimmed">{g.public ? "Anyone in the lobby can take it." : "Only someone with the code can join."} It starts as soon as they join.</Text>}
          {o.error && <Text size="xs" c="red" mt={4}>{o.error}</Text>}
          {seat && (
            <Group gap={6} mt={8}>
              {g.status === "waiting" && <Button size="xs" variant="default" onClick={() => o.leaveQueue()}>{queued ? "Leave queue" : "Cancel"}</Button>}
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
          <Button variant="default" style={{ flex: 1 }} disabled={!!seat && g.status === "playing"} onClick={() => (seat && g.status === "waiting" ? o.leaveQueue() : o.leave())}>Back</Button>
        </div>
      </div>
    </div>
  );
}
