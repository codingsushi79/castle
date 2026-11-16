import { Alert, Button, Group, PasswordInput, SegmentedControl, Switch, Text, TextInput } from "@mantine/core";
import { IconEye, IconFlag, IconRefresh, IconSend, IconWorld } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Board } from "../components/Board";
import { Empty, Panel, PlayerStrip } from "../components/common";
import { Color, fenOf, materialBalance, positionOf, turnOf } from "../lib/chess";
import { useFics } from "../lib/fics";
import { useApp } from "../lib/store";
import { load } from "../lib/storage";

export default function FicsPage() {
  const f = useFics();
  return f.state === "online" ? <Session /> : <Login />;
}

/** The keychain login is tried once per launch, the first time this page opens. */
let triedKeychain = false;

function Login() {
  const f = useFics();
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const busy = f.state !== "disconnected";
  const connect = () => { f.connect(f.guest ? "" : password, !f.guest && remember); setPassword(""); };
  useEffect(() => {
    if (triedKeychain) return;
    triedKeychain = true;
    if (!load("ficsGuest", true)) f.quickConnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="page" style={{ alignItems: "center", justifyContent: "center" }}>
      <div className="stagger" style={{ width: 380, textAlign: "center" }}>
        <IconWorld size={54} stroke={1.2} color="var(--mantine-primary-color-filled)" />
        <Text fw={800} fz={26}>Free Internet Chess Server</Text>
        <Text c="dimmed" mb="md">Play and watch live games on freechess.org, free of charge since 1995.</Text>
        <div className="card" style={{ textAlign: "left" }}>
          <SegmentedControl fullWidth value={f.guest ? "guest" : "account"} onChange={(v) => f.set({ guest: v === "guest" })} data={[{ value: "guest", label: "Guest" }, { value: "account", label: "FICS account" }]} />
          {f.guest ? <Text size="sm" c="dimmed" mt="sm">Guests can play unrated games and watch anything.</Text> : (
            <>
              <TextInput mt="sm" placeholder="Username" value={f.username} onChange={(e) => f.set({ username: e.currentTarget.value })} />
              <PasswordInput size="xs" mt={6} placeholder="Password" value={password} onChange={(e) => setPassword(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && connect()} />
              <Switch size="xs" mt={8} label="Remember me (keychain)" checked={remember} onChange={(e) => setRemember(e.currentTarget.checked)} />
              {f.saved && (
                <Group gap={6} mt={8}>
                  <Button size="xs" variant="light" loading={busy} onClick={() => f.quickConnect()}>Log in as {f.username}</Button>
                  <Button size="xs" variant="subtle" color="gray" onClick={() => f.forget()}>Forget</Button>
                </Group>
              )}
            </>
          )}
          <Button fullWidth mt="sm" size="md" loading={busy} disabled={!f.guest && (!f.username || !password)} onClick={connect}>Connect</Button>
          {f.error && <Alert color="red" mt="sm" p="xs">{f.error}</Alert>}
        </div>
        <Text size="xs" c="dimmed" mt="sm">The connection is plain telnet, as FICS requires. With Remember me on, the password is kept in your system keychain and Castle logs in by itself next time.</Text>
      </div>
    </div>
  );
}

function Session() {
  const f = useFics();
  const app = useApp();
  const [tab, setTab] = useState("seek");
  const [command, setCommand] = useState("");
  const [rated, setRated] = useState(false);
  const consoleEl = useRef<HTMLDivElement>(null);
  useEffect(() => { consoleEl.current?.scrollTo(0, 1e9); }, [f.console.length, tab]);

  const g = f.game;
  const turn = turnOf(f.fen);
  const mine: Color | undefined = g && Math.abs(g.relation) === 1 ? (g.relation === 1 ? turn : turn === "white" ? "black" : "white") : undefined;
  const shownFen = f.pending ? (() => { const p = positionOf(f.fen).clone(); p.play(f.pending!); return fenOf(p); })() : f.fen;
  const top: Color = f.flipped ? "white" : "black";
  const bottom: Color = f.flipped ? "black" : "white";
  const balance = materialBalance(f.fen);
  const strip = (c: Color) => (
    <PlayerStrip name={g ? (c === "white" ? g.white : g.black) : c === "white" ? "White" : "Black"} color={c} clock={g?.clocks[c]} active={!!g?.running && turn === c} material={c === "white" ? Math.max(0, balance) : Math.max(0, -balance)} />
  );
  const send = () => { f.send(command); setCommand(""); };

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow">
          <Board fen={shownFen} orientation={bottom} lastMove={f.lastMove} movable={g?.relation === 1 && !f.pending ? turn : undefined} onMove={(m) => f.play(m)}
            premove={g?.relation === -1 && mine ? { color: mine, onSet: (a, b) => f.set({ premove: [a, b] }), onUnset: () => f.set({ premove: undefined }) } : undefined} />
        </div>
        {strip(bottom)}
        {f.pending && (
          <Group grow><Button variant="default" onClick={() => f.set({ pending: undefined })}>Cancel</Button><Button onClick={() => f.confirmPending()}>Confirm move</Button></Group>
        )}
      </div>
      <div className="sidecol">
        <div className="toolbar">
          <Text size="sm" fw={600}>{f.handle}</Text>
          <span style={{ flex: 1 }} />
          <Switch label="Confirm moves" checked={f.confirm} onChange={(e) => f.set({ confirm: e.currentTarget.checked })} />
          <Button variant="default" onClick={() => f.disconnect()}>Disconnect</Button>
        </div>
        {f.result && <Panel><Text fw={700}><IconFlag size={15} style={{ verticalAlign: -2 }} /> {f.result}</Text></Panel>}
        <div style={{ padding: "8px 12px" }}>
          <SegmentedControl fullWidth value={tab} onChange={setTab} data={[{ value: "seek", label: "Find a game" }, { value: "console", label: "Console" }]} />
        </div>
        {tab === "seek" ? (
          <>
            <Panel title="Quick pairing" right={<Switch label="Rated" checked={rated} onChange={(e) => setRated(e.currentTarget.checked)} />}>
              <Group gap={6} grow>
                {[[1, 0], [3, 0], [5, 0], [10, 5], [15, 10]].map(([m, i]) => (
                  <Button key={m} variant="default" onClick={() => f.send(`seek ${m} ${i} ${rated ? "rated" : "unrated"}`)}>{m}+{i}</Button>
                ))}
              </Group>
            </Panel>
            <Panel grow pad={false} title="Open challenges" right={<IconRefresh size={14} style={{ cursor: "pointer" }} onClick={() => f.refreshSeeks()} />}>
              {f.seeks.length ? f.seeks.map((s) => (
                <div key={s.id} className="listrow">
                  <div style={{ flex: 1 }}>
                    <Text size="sm" fw={600}>{s.name}</Text>
                    <Text size="xs" c="dimmed">{s.rating} · {s.type} · {s.rated ? "rated" : "casual"}</Text>
                  </div>
                  <Text size="sm">{s.time}+{s.increment}</Text>
                  <Button variant="light" onClick={() => f.send(`play ${s.id}`)}>Play</Button>
                </div>
              )) : <Empty title="No open challenges">Post a quick pairing above, or refresh.</Empty>}
            </Panel>
          </>
        ) : (
          <>
            <div className="console" ref={consoleEl}>
              {f.console.map((l, i) => <div key={i} className={l.kind === "sent" ? "sent" : l.kind === "sys" ? "sys" : ""}>{l.kind === "sent" ? "› " : ""}{l.text}</div>)}
            </div>
            <Group gap={6} p={8} wrap="nowrap">
              <TextInput style={{ flex: 1 }} ff="monospace" placeholder="games, observe 12, tell 50 hello" value={command} onChange={(e) => setCommand(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
              <Button px={8} onClick={send} disabled={!command}><IconSend size={14} /></Button>
            </Group>
          </>
        )}
        <div style={{ padding: 12 }}>
          {g && Math.abs(g.relation) === 1 ? (
            <Group grow>
              <Button variant="default" onClick={() => f.send("draw")}>Draw</Button>
              <Button variant="default" onClick={() => f.send("abort")}>Abort</Button>
              <Button variant="default" color="red" onClick={() => f.send("resign")}>Resign</Button>
            </Group>
          ) : (
            <Group grow>
              {g && <Button variant="default" onClick={() => app.openGame(f.record.clone())}>Analyse</Button>}
              <Button variant="default" leftSection={<IconEye size={14} />} onClick={() => f.send("observe /b")}>Watch top blitz</Button>
            </Group>
          )}
        </div>
      </div>
    </div>
  );
}
