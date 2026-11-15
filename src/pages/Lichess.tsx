import { Alert, Anchor, Button, Group, NumberInput, PasswordInput, SegmentedControl, Select, Switch, Text, TextInput } from "@mantine/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { IconBolt, IconFlag } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { arenas, Arena, arenaStandings, ArenaStanding, joinArena, withdrawArena } from "../lib/lichess";
import { Board, MiniBoard } from "../components/Board";
import { MoveList, Panel, PlayerStrip } from "../components/common";
import { Color, fenOf, materialBalance, VARIANTS } from "../lib/chess";
import { useLichess } from "../lib/lichess";
import { useApp, useTree } from "../lib/store";

const TOKEN_URL = "https://lichess.org/account/oauth/token/create?" + ["board:play", "challenge:read", "challenge:write", "tournament:write", "study:read", "study:write"].map((s) => `scopes[]=${s}`).join("&") + "&description=Castle";
const LICHESS_VARIANTS = [{ value: "standard", label: "Standard" }, { value: "chess960", label: "Chess960" }, { value: "crazyhouse", label: "Crazyhouse" }, { value: "atomic", label: "Atomic" }, { value: "kingOfTheHill", label: "King of the Hill" }, { value: "threeCheck", label: "Three-check" }, { value: "antichess", label: "Antichess" }, { value: "horde", label: "Horde" }, { value: "racingKings", label: "Racing Kings" }];
void VARIANTS;

export default function LichessPage() {
  const l = useLichess();
  return l.state === "online" ? <Session /> : <SignIn />;
}

function SignIn() {
  const l = useLichess();
  const [token, setToken] = useState("");
  const go = () => { l.signIn(token); setToken(""); };
  return (
    <div className="page" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="stagger" style={{ width: 400, textAlign: "center" }}>
        <IconBolt size={54} stroke={1.2} color="var(--mantine-primary-color-filled)" />
        <Text fw={800} fz={26}>Play on Lichess</Text>
        <Text c="dimmed" mb="md">Sign in with a personal access token to play live and correspondence games, and to use the Lichess opening explorer.</Text>
        <div className="card" style={{ textAlign: "left" }}>
          <PasswordInput size="xs" placeholder="Personal access token" value={token} onChange={(e) => setToken(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && go()} />
          <Button fullWidth mt="sm" size="md" loading={l.state === "connecting"} disabled={!token} onClick={go}>Sign in</Button>
          {l.error && <Alert color="red" mt="sm" p="xs">{l.error}</Alert>}
          <Anchor size="sm" mt="sm" display="block" onClick={() => openUrl(TOKEN_URL).catch(() => window.open(TOKEN_URL))}>Create a token on lichess.org</Anchor>
        </div>
        <Text size="xs" c="dimmed" mt="sm">The link asks for permission to play, send challenges, join arenas and read and write studies. The token is kept in your Mac's keychain.</Text>
      </div>
    </div>
  );
}

function Session() {
  const l = useLichess();
  const app = useApp();
  const tree = l.tree;
  useTree(tree);
  const [rated, setRated] = useState(false);
  const [variant, setVariant] = useState("standard");
  const [level, setLevel] = useState(3);
  const [minutes, setMinutes] = useState("10");
  const [lobbyTab, setLobbyTab] = useState("play");
  const flipped = l.myColor === "black";
  const top: Color = flipped ? "white" : "black", bottom: Color = flipped ? "black" : "white";
  const live = tree.last;
  const balance = materialBalance(live.fen);
  const atEnd = tree.current === live;
  const myTurn = l.playing && atEnd && live.turn === l.myColor;
  const shown = l.pending ? (() => { const p = tree.pos.clone(); p.play(l.pending!); return fenOf(p); })() : tree.fen;
  const strip = (c: Color) => (
    <PlayerStrip name={l.names[c]} color={c} clock={l.hasClock && l.gameId && !l.correspondence ? l.clocks[c] : undefined} active={l.playing && live.turn === c} material={c === "white" ? Math.max(0, balance) : Math.max(0, -balance)} />
  );

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow">
          <Board fen={shown} rules={tree.rules} chess960={tree.chess960} orientation={bottom} lastMove={tree.current.lastMove}
            movable={myTurn && !l.pending ? l.myColor : undefined} onMove={(m) => l.play(m)}
            premove={l.playing && atEnd && live.turn !== l.myColor && !l.correspondence ? { color: l.myColor, onSet: (a, b) => l.setPremove([a, b]), onUnset: () => l.setPremove(undefined) } : undefined} />
        </div>
        {strip(bottom)}
        {l.pending && <Group grow><Button variant="default" onClick={() => l.cancelPending()}>Cancel</Button><Button onClick={() => l.confirmPending()}>Confirm move</Button></Group>}
      </div>
      <div className="sidecol">
        <div className="toolbar">
          <Text size="sm" fw={600}>{l.username}</Text>
          <span style={{ flex: 1 }} />
          <Switch label="Confirm moves" checked={l.confirm} onChange={(e) => l.setConfirm(e.currentTarget.checked)} />
          <Button variant="default" onClick={() => l.signOut()}>Sign out</Button>
        </div>
        {l.result && <Panel><Text fw={700}><IconFlag size={15} style={{ verticalAlign: -2 }} /> {l.result}</Text></Panel>}
        {l.error && <Alert color="red" m={12} p="xs">{l.error}</Alert>}
        {l.playing ? (
          <>
            <Panel grow pad={false}><MoveList tree={tree} editable={false} /></Panel>
            <div style={{ padding: 12 }}>
              <Group grow>
                <Button variant="default" onClick={() => l.offerDraw()}>Draw</Button>
                <Button variant="default" disabled={tree.mainline.length > 1} onClick={() => l.abort()}>Abort</Button>
                <Button variant="default" color="red" onClick={() => l.resign()}>Resign</Button>
              </Group>
              {l.correspondence && <Button fullWidth mt={8} variant="subtle" color="gray" onClick={() => useLichess.setState({ playing: false })}>Back to the lobby</Button>}
            </div>
          </>
        ) : (
          <>
            <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
              <SegmentedControl fullWidth value={lobbyTab} onChange={setLobbyTab}
                data={[{ value: "play", label: "Play" }, { value: "challenge", label: `Challenges${l.incoming.length ? ` (${l.incoming.length})` : ""}` }, { value: "arenas", label: "Arenas" }]} />
            </div>
            {lobbyTab === "challenge" && <Challenges />}
            {lobbyTab === "arenas" && <Arenas />}
            {lobbyTab === "play" && <>
            {l.ratings.length > 0 && (
              <Panel>
                <Group gap={6} grow>
                  {l.ratings.map((r) => (
                    <div key={r.name} className="stat" style={{ alignItems: "center" }} title={`${r.games} games`}><b style={{ fontSize: 15 }}>{r.rating}</b><small>{r.name}</small></div>
                  ))}
                </Group>
              </Panel>
            )}
            <Panel title="Find an opponent" right={<Switch label="Rated" checked={rated} onChange={(e) => setRated(e.currentTarget.checked)} />}>
              <Select value={variant} onChange={(v) => v && setVariant(v)} data={LICHESS_VARIANTS} mb={8} />
              <Text size="xs" c="dimmed" mb={4}>Live</Text>
              <Group gap={6} grow>
                {[[10, 0], [10, 5], [15, 10], [30, 0], [30, 20]].map(([m, i]) => (
                  <Button key={`${m}+${i}`} variant="default" px={4} disabled={l.seeking} onClick={() => l.seek({ minutes: m, increment: i, rated, variant })}>{m}+{i}</Button>
                ))}
              </Group>
              <Text size="xs" c="dimmed" mt={8} mb={4}>Correspondence (days per move)</Text>
              <Group gap={6} grow>
                {[1, 2, 3, 7, 14].map((d) => <Button key={d} variant="default" px={4} onClick={() => l.seek({ days: d, rated, variant })}>{d}</Button>)}
              </Group>
              {l.seeking && <Group mt={8}><Text size="sm" c="dimmed" style={{ flex: 1 }}>Looking for an opponent…</Text><Button variant="default" onClick={() => l.cancelSeek()}>Cancel</Button></Group>}
              <Text size="xs" c="dimmed" mt={8}>Lichess allows rapid, classical and correspondence pairings from outside apps, not blitz or bullet.</Text>
            </Panel>
            <Panel title="Play the Lichess computer">
              <Group grow>
                <NumberInput label="Level (1 to 8)" min={1} max={8} value={level} onChange={(v) => typeof v === "number" && setLevel(v)} />
                <Select label="Minutes each" value={minutes} onChange={(v) => v && setMinutes(v)} data={["5", "10", "15", "30"]} />
              </Group>
              <Button fullWidth mt={8} variant="light" onClick={() => l.challengeComputer(level, parseInt(minutes, 10), 0, variant)}>Start game</Button>
            </Panel>
            <Panel grow pad={false} title={`Your games in progress (${l.ongoing.length})`}>
              {l.ongoing.length ? l.ongoing.map((g) => (
                <div key={g.id} className="listrow" onClick={() => l.open(g.id)}>
                  <MiniBoard fen={g.fen} orientation={g.color} size={64} />
                  <div style={{ flex: 1 }}>
                    <Text size="sm" fw={600}>{g.opponent}</Text>
                    <Text size="xs" c="dimmed">{g.speed}{g.secondsLeft ? ` · ${g.secondsLeft > 86400 ? Math.round(g.secondsLeft / 86400) + " days" : Math.round(g.secondsLeft / 3600) + " hours"} left` : ""}</Text>
                  </div>
                  {g.myTurn && <Text size="xs" fw={700} c="orange">Your move</Text>}
                </div>
              )) : <Text size="sm" c="dimmed" p={12}>Correspondence games you start appear here. The sidebar badge counts the ones waiting for your move.</Text>}
            </Panel>
            {l.gameId && tree.mainline.length > 0 && <div style={{ padding: 12 }}><Button fullWidth variant="default" onClick={() => app.openGame(tree.clone())}>Analyse last game</Button></div>}
            </>}
          </>
        )}
      </div>
    </div>
  );
}

function Challenges() {
  const l = useLichess();
  const [user, setUser] = useState("");
  const [mode, setMode] = useState("live");
  const [minutes, setMinutes] = useState(10);
  const [increment, setIncrement] = useState(5);
  const [days, setDays] = useState("3");
  const [color, setColor] = useState("random");
  const [variant, setVariant] = useState("standard");
  const [rated, setRated] = useState(false);
  return (
    <>
      {l.incoming.length > 0 && (
        <Panel title="Challenges for you" pad={false}>
          {l.incoming.map((c) => (
            <div key={c.id} className="listrow">
              <div style={{ flex: 1 }}>
                <Text size="sm" fw={600}>{c.from}</Text>
                <Text size="xs" c="dimmed">{c.variant} · {c.timeControl} · {c.rated ? "rated" : "casual"} · you play {c.color === "random" ? "either colour" : c.color === "white" ? "Black" : "White"}</Text>
              </div>
              <Button onClick={() => l.answer(c.id, true)}>Accept</Button>
              <Button variant="default" onClick={() => l.answer(c.id, false)}>Decline</Button>
            </div>
          ))}
        </Panel>
      )}
      <Panel title="Challenge a friend">
        <TextInput placeholder="Lichess username" value={user} onChange={(e) => setUser(e.currentTarget.value)} />
        <SegmentedControl mt={8} fullWidth value={mode} onChange={setMode} data={[{ value: "live", label: "Live" }, { value: "corr", label: "Correspondence" }]} />
        {mode === "live" ? (
          <Group grow mt={8}>
            <NumberInput label="Minutes" min={0.25} max={180} step={1} value={minutes} onChange={(v) => typeof v === "number" && setMinutes(v)} />
            <NumberInput label="Increment" min={0} max={180} value={increment} onChange={(v) => typeof v === "number" && setIncrement(v)} />
          </Group>
        ) : (
          <Select mt={8} label="Days per move" value={days} onChange={(v) => v && setDays(v)} data={["1", "2", "3", "5", "7", "10", "14"]} />
        )}
        <Group grow mt={8}>
          <Select label="You play" value={color} onChange={(v) => v && setColor(v)} data={[{ value: "random", label: "Random" }, { value: "white", label: "White" }, { value: "black", label: "Black" }]} />
          <Select label="Variant" value={variant} onChange={(v) => v && setVariant(v)} data={LICHESS_VARIANTS} />
        </Group>
        <Switch mt={10} label="Rated" checked={rated} onChange={(e) => setRated(e.currentTarget.checked)} />
        <Button fullWidth mt={10} disabled={!/^[\w-]{2,30}$/.test(user.trim())}
          onClick={() => l.challenge(user, mode === "live" ? { minutes, increment, rated, color, variant } : { days: parseInt(days, 10), rated, color, variant })}>
          Send challenge
        </Button>
        <Text size="xs" c="dimmed" mt={6}>When your friend accepts, the game opens here. Blitz and bullet games against friends are allowed.</Text>
      </Panel>
      {l.outgoing.length > 0 && (
        <Panel title="Waiting for an answer" pad={false}>
          {l.outgoing.map((c) => (
            <div key={c.id} className="listrow">
              <div style={{ flex: 1 }}><Text size="sm" fw={600}>{c.to}</Text><Text size="xs" c="dimmed">{c.variant} · {c.timeControl}</Text></div>
              <Button variant="default" onClick={() => l.cancelChallenge(c.id)}>Cancel</Button>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}

function Arenas() {
  const [list, setList] = useState<Arena[]>();
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<{ arena: Arena; standings: ArenaStanding[]; me?: { rank: number; score: number } }>();
  const [error, setError] = useState<string>();
  useEffect(() => { arenas().then(setList).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    const load = () => arenaStandings(selected).then((d) => live && setDetail(d)).catch((e) => live && setError(e.message));
    load();
    const t = setInterval(load, 10000);
    return () => { live = false; clearInterval(t); };
  }, [selected]);
  const playable = (a: Arena) => ["Rapid", "Classical"].includes(a.speed) || a.minutes >= 8;
  const when = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (selected && detail) {
    const a = detail.arena;
    return (
      <>
        <Panel title={a.name} right={<Button variant="subtle" color="gray" onClick={() => { setSelected(undefined); setDetail(undefined); }}>All arenas</Button>}>
          <Text size="sm">{a.minutes}+{a.increment} · {a.variant} · {a.rated ? "rated" : "casual"} · {a.players} players</Text>
          <Text size="xs" c="dimmed">{a.status === "started" ? `Ends at ${when(a.finishes)}` : a.status === "created" ? `Starts at ${when(a.starts)}` : "Finished"}</Text>
          {detail.me && <Text size="sm" fw={600} mt={4}>You are #{detail.me.rank} with {detail.me.score} points</Text>}
          <Group grow mt={8}>
            {detail.me ? <Button variant="default" onClick={() => withdrawArena(a.id).then(() => setSelected(a.id))}>Pause or withdraw</Button>
              : <Button disabled={a.status === "finished"} onClick={() => joinArena(a.id).catch((e) => setError(e.message)).then(() => setSelected(a.id))}>Join</Button>}
          </Group>
          {!playable(a) && <Text size="xs" c="orange" mt={6}>Lichess may refuse blitz and bullet pairings from outside apps. Rapid and classical arenas work best.</Text>}
          {error && <Text size="xs" c="red" mt={4}>{error}</Text>}
        </Panel>
        <Panel grow pad={false} title="Standings">
          {detail.standings.map((p) => (
            <div key={p.rank} className="listrow">
              <Text size="xs" c="dimmed" w={24} ta="right">{p.rank}</Text>
              <Text size="sm" style={{ flex: 1 }}>{p.name} <Text span size="xs" c="dimmed">{p.rating}</Text></Text>
              <Text size="sm" fw={700} c={p.fire ? "orange" : undefined}>{p.score}</Text>
            </div>
          ))}
        </Panel>
      </>
    );
  }
  return (
    <Panel grow pad={false} title="Arenas on Lichess">
      {error && <Text size="xs" c="red" p={12}>{error}</Text>}
      {!list ? <Text size="sm" c="dimmed" p={12}>Loading…</Text> : list.map((a) => (
        <div key={a.id} className="listrow" onClick={() => setSelected(a.id)} style={{ opacity: playable(a) ? 1 : 0.6 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" fw={600} truncate>{a.name}</Text>
            <Text size="xs" c="dimmed">{a.minutes}+{a.increment} · {a.variant} · {a.players} players · {a.status === "started" ? "now" : `starts ${when(a.starts)}`}</Text>
          </div>
          {a.status === "started" && <Text size="xs" fw={700} c="red">LIVE</Text>}
        </div>
      ))}
    </Panel>
  );
}
