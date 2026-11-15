import { Button, Group, Select, Text, TextInput } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Bar, BarChart } from "recharts";
import { call } from "../lib/storage";
import { db, GameRow } from "../lib/db";
import { reviewRecords } from "../lib/batch";
import { useApp } from "../lib/store";
import { Empty, ResultBar, Stat } from "./common";

const tip = { contentStyle: { background: "var(--bg-panel)", border: "1px solid var(--border)", fontSize: 12 }, cursor: { fill: "#8881" } };

interface EventRow {
  event: string;
  site: string;
  first: string;
  last: string;
  games: number;
  players: number;
}

/** Expected score from a rating difference, and its inverse for performance ratings. */
const dpFor = (p: number) => (p <= 0 ? -800 : p >= 1 ? 800 : Math.round(-400 * Math.log10(1 / p - 1)));

export function EventsView() {
  const [text, setText] = useState("");
  const [events, setEvents] = useState<EventRow[]>([]);
  const [selected, setSelected] = useState<string>();
  const revision = useApp((s) => s.libraryRevision);
  useEffect(() => { call<EventRow[]>("db_events", { text }).then(setEvents).catch(() => {}); }, [text, revision]);
  return (
    <div className="page">
      <div style={{ width: 300, flex: "none", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
        <div style={{ padding: 10 }}><TextInput placeholder="Filter events" value={text} onChange={(e) => setText(e.currentTarget.value)} /></div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {events.map((e) => (
            <div key={e.event} className={"listrow" + (selected === e.event ? " on" : "")} onClick={() => setSelected(e.event)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={600} truncate>{e.event}</Text>
                <Text size="xs" c="dimmed">{e.games} games · {e.players} players · {e.first === e.last ? e.first : `${e.first} – ${e.last}`}</Text>
              </div>
            </div>
          ))}
          {!events.length && <Text size="sm" c="dimmed" p={12}>No events.</Text>}
        </div>
      </div>
      {selected ? <Crosstable event={selected} /> : <Empty title="Pick an event">See its crosstable, standings and performance ratings.</Empty>}
    </div>
  );
}

function Crosstable({ event }: { event: string }) {
  const [games, setGames] = useState<GameRow[]>([]);
  useEffect(() => { db.query({ event, limit: 5000, sort: "date" }).then((r) => setGames(r.rows)).catch(() => {}); }, [event]);
  const table = useMemo(() => {
    const players = new Map<string, { name: string; elo?: number; points: number; games: number; oppElo: number[]; results: Map<string, string[]> }>();
    const get = (name: string, elo?: number) => {
      if (!players.has(name)) players.set(name, { name, elo, points: 0, games: 0, oppElo: [], results: new Map() });
      const p = players.get(name)!;
      if (elo) p.elo = elo;
      return p;
    };
    for (const g of games) {
      if (g.result === "*") continue;
      const w = get(g.white, g.white_elo), b = get(g.black, g.black_elo);
      const ws = g.result === "1-0" ? 1 : g.result === "0-1" ? 0 : 0.5;
      w.points += ws; b.points += 1 - ws; w.games++; b.games++;
      if (g.black_elo) w.oppElo.push(g.black_elo);
      if (g.white_elo) b.oppElo.push(g.white_elo);
      const mark = (s: number) => (s === 1 ? "1" : s === 0 ? "0" : "½");
      w.results.set(b.name, [...(w.results.get(b.name) ?? []), mark(ws)]);
      b.results.set(w.name, [...(b.results.get(w.name) ?? []), mark(1 - ws)]);
    }
    const list = [...players.values()].sort((a, b) => b.points - a.points || (b.elo ?? 0) - (a.elo ?? 0));
    return list.map((p) => {
      const avg = p.oppElo.length ? p.oppElo.reduce((a, b) => a + b, 0) / p.oppElo.length : undefined;
      return { ...p, perf: avg && p.games ? Math.round(avg + dpFor(p.points / p.games)) : undefined };
    });
  }, [games]);
  const small = table.length <= 16;
  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }}>
      <Text fw={700} size="lg">{event}</Text>
      <Text size="sm" c="dimmed" mb="md">{games.length} games · {table.length} players</Text>
      <table className="data">
        <thead><tr><th>#</th><th>Player</th><th>Rating</th>{small && table.map((_, i) => <th key={i} style={{ textAlign: "center" }}>{i + 1}</th>)}<th>Points</th><th>Games</th><th>Perf.</th></tr></thead>
        <tbody>
          {table.map((p, i) => (
            <tr key={p.name} onDoubleClick={() => useApp.getState().go("library", { kind: "playerPage", payload: p.name })}>
              <td>{i + 1}</td><td><b>{p.name}</b></td><td>{p.elo ?? ""}</td>
              {small && table.map((o, j) => <td key={j} style={{ textAlign: "center", background: i === j ? "#8882" : undefined }}>{i === j ? "" : (p.results.get(o.name) ?? []).join(" ")}</td>)}
              <td><b>{p.points}</b></td><td>{p.games}</td><td>{p.perf ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Text size="xs" c="dimmed" mt={8}>Performance uses the average rating of the opponents a player met. Double-click a player for their page.</Text>
    </div>
  );
}

export function PlayersView({ initial }: { initial?: string }) {
  const [players, setPlayers] = useState<[string, number][]>([]);
  const [text, setText] = useState("");
  const [selected, setSelected] = useState<string | undefined>(initial);
  const revision = useApp((s) => s.libraryRevision);
  useEffect(() => { db.players().then(setPlayers); }, [revision]);
  const shown = players.filter(([n]) => n.toLowerCase().includes(text.toLowerCase()));
  return (
    <div className="page">
      <div style={{ width: 260, flex: "none", borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", background: "var(--bg-panel)" }}>
        <div style={{ padding: 10 }}><TextInput placeholder="Filter players" value={text} onChange={(e) => setText(e.currentTarget.value)} /></div>
        <div style={{ flex: 1, overflowY: "auto" }}>
          {shown.map(([n, c]) => (
            <div key={n} className={"listrow" + (selected === n ? " on" : "")} onClick={() => setSelected(n)}>
              <Text size="sm" style={{ flex: 1 }} truncate>{n}</Text><Text size="xs" c="dimmed">{c}</Text>
            </div>
          ))}
        </div>
      </div>
      {selected ? <PlayerPage name={selected} /> : <Empty title="Pick a player">See their rating over time, results by colour, opening and year, and their usual opponents.</Empty>}
    </div>
  );
}

function PlayerPage({ name }: { name: string }) {
  const [games, setGames] = useState<GameRow[]>([]);
  const go = useApp((s) => s.go);
  useEffect(() => { db.query({ player: name, limit: 20000, sort: "date" }).then((r) => setGames(r.rows)).catch(() => {}); }, [name]);
  const me = (g: GameRow) => g.white.toLowerCase() === name.toLowerCase();
  const score = (g: GameRow) => (g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === me(g) ? 1 : 0);
  const done = games.filter((g) => g.result !== "*");
  const rating = done.map((g, i) => ({ i, date: g.date, rating: me(g) ? g.white_elo : g.black_elo })).filter((x) => x.rating);
  const byYear = new Map<string, number[]>();
  done.forEach((g) => { const y = g.date.slice(0, 4); if (/^\d{4}$/.test(y)) byYear.set(y, [...(byYear.get(y) ?? []), score(g)]); });
  const years = [...byYear].map(([year, s]) => ({ year, games: s.length, score: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) }));
  const opps = new Map<string, number[]>();
  done.forEach((g) => { const o = me(g) ? g.black : g.white; opps.set(o, [...(opps.get(o) ?? []), score(g)]); });
  const topOpps = [...opps].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  const oppElo = done.map((g) => (me(g) ? g.black_elo : g.white_elo)).filter((x): x is number => !!x);
  const pts = done.reduce((a, g) => a + score(g), 0);
  const perf = oppElo.length ? Math.round(oppElo.reduce((a, b) => a + b, 0) / oppElo.length + dpFor(pts / done.length)) : undefined;
  const reviews = Object.values(reviewRecords()).filter((r) => r.white === name || r.black === name);
  const acc = reviews.map((r) => r.accuracy[r.white === name ? "white" : "black"]).filter((x): x is number => x !== undefined);
  const w = done.filter((g) => score(g) === 1).length, d = done.filter((g) => score(g) === 0.5).length;
  return (
    <div style={{ flex: 1, overflow: "auto", padding: 16 }} className="stagger">
      <Group justify="space-between" mb="sm">
        <Text fw={700} size="lg">{name}</Text>
        <Group gap={6}>
          <Button variant="default" onClick={() => go("library", { kind: "player", payload: name })}>Show games</Button>
          <Button variant="default" onClick={() => { localStorage.setItem("castle.accountsTab", JSON.stringify("prepare")); go("accounts"); }}>Prepare against</Button>
        </Group>
      </Group>
      <Group grow gap={10} mb="md">
        <Stat label="Games" value={done.length} />
        <Stat label="Score" value={done.length ? `${Math.round((pts / done.length) * 100)}%` : "–"} />
        <Stat label="Performance" value={perf ?? "–"} />
        <Stat label="Peak rating" value={rating.length ? Math.max(...rating.map((r) => r.rating!)) : "–"} />
        <Stat label="Avg. accuracy" value={acc.length ? `${(acc.reduce((a, b) => a + b, 0) / acc.length).toFixed(0)}%` : "–"} />
      </Group>
      <div style={{ marginBottom: 12 }}><ResultBar white={w} draws={d} black={done.length - w - d} /></div>
      <div className="card" style={{ marginBottom: 12 }}>
        <Text fw={600} mb={6}>Rating</Text>
        {rating.length < 2 ? <Text size="sm" c="dimmed">The games have no rating tags.</Text> : (
          <div style={{ height: 180 }}>
            <ResponsiveContainer>
              <LineChart data={rating}>
                <CartesianGrid stroke="#8882" vertical={false} />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b8f98" }} minTickGap={40} />
                <YAxis domain={["dataMin - 30", "dataMax + 30"]} width={40} tick={{ fontSize: 10, fill: "#8b8f98" }} />
                <Tooltip {...tip} />
                <Line dataKey="rating" stroke="var(--mantine-primary-color-filled)" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
      <Group grow align="flex-start" gap={12}>
        <div className="card">
          <Text fw={600} mb={6}>By year</Text>
          {years.length ? (
            <div style={{ height: 160 }}>
              <ResponsiveContainer><BarChart data={years}><XAxis dataKey="year" tick={{ fontSize: 10, fill: "#8b8f98" }} /><YAxis domain={[0, 100]} hide /><Tooltip {...tip} formatter={(v: number, _n, it: any) => [`${v}% in ${it.payload.games} games`, "Score"]} /><Bar dataKey="score" fill="var(--mantine-primary-color-filled)" isAnimationActive={false} radius={3} /></BarChart></ResponsiveContainer>
            </div>
          ) : <Text size="sm" c="dimmed">No dated games.</Text>}
        </div>
        <div className="card">
          <Text fw={600} mb={6}>Most played opponents</Text>
          {topOpps.map(([o, s]) => (
            <Group key={o} justify="space-between" py={2}>
              <Text size="sm" truncate style={{ flex: 1 }}>{o}</Text>
              <Text size="xs" c="dimmed">{s.reduce((a, b) => a + b, 0)} / {s.length}</Text>
            </Group>
          ))}
        </div>
      </Group>
    </div>
  );
}

export function BatchDialogBody({ count, onStart }: { count: number; onStart: (ms: number) => void }) {
  const [ms, setMs] = useState("250");
  return (
    <>
      <Text size="sm">Reviews {count} game{count === 1 ? "" : "s"} in the background with your default engine. Evaluations and move marks are saved into each game, and the results feed the trends on the Progress page.</Text>
      <Select mt="sm" label="Time per position" value={ms} onChange={(v) => v && setMs(v)}
        data={[{ value: "100", label: "Quick (0.1 s)" }, { value: "250", label: "Normal (0.25 s)" }, { value: "600", label: "Thorough (0.6 s)" }, { value: "1500", label: "Overnight (1.5 s)" }]} />
      <Text size="xs" c="dimmed" mt={6}>About {Math.max(1, Math.round((count * 80 * parseInt(ms, 10)) / 60000))} minutes. Positions already in the analysis cache are skipped.</Text>
      <Group justify="flex-end" mt="md"><Button onClick={() => onStart(parseInt(ms, 10))}>Start review</Button></Group>
    </>
  );
}
