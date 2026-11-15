import { ActionIcon, Alert, Button, Group, NumberInput, Progress, SegmentedControl, Select, Switch, Text } from "@mantine/core";
import { IconEqual, IconPlayerPlayFilled, IconPlayerStopFilled, IconPlus, IconTrash, IconTriangleFilled, IconTriangleInvertedFilled } from "@tabler/icons-react";
import { Board } from "../components/Board";
import { Empty, EvalBar, Panel, PlayerStrip, ResultBar } from "../components/common";
import { materialBalance } from "../lib/chess";
import { db } from "../lib/db";
import { available, entryOf, useEngines } from "../lib/engines";
import { eloEstimate, sprt, standings, TournamentMode, useMatches } from "../lib/matches";
import { useApp, useTree } from "../lib/store";

const fmt = (p: number) => (Number.isInteger(p) ? String(p) : p.toFixed(1));

export default function MatchesPage() {
  const m = useMatches();
  const app = useApp();
  useEngines((s) => s.engines);
  useTree(m.tree);
  const list = available().map((e) => ({ value: e.id, label: e.name }));
  const name = (i: number) => m.names[i] ?? entryOf(m.entrants[i])?.name ?? "Engine";
  const balance = materialBalance(m.tree.fen);
  const two = m.mode === "match" || m.mode === "sprt";
  const elo = eloEstimate(m.records);
  const test = m.mode === "sprt" ? sprt(m.records, m.elo0, m.elo1) : undefined;
  const table = standings(m.names.length ? m.names : m.entrants.map((_, i) => name(i)), m.records);

  return (
    <div className="page">
      <div className="boardcol">
        <PlayerStrip name={name(m.black)} color="black" active={m.running && m.tree.current.turn === "black"} material={Math.max(0, -balance)} />
        <div className="boardrow">
          <EvalBar score={m.score} />
          <Board fen={m.tree.fen} lastMove={m.tree.current.lastMove} />
        </div>
        <PlayerStrip name={name(m.white)} color="white" active={m.running && m.tree.current.turn === "white"} material={Math.max(0, balance)} />
      </div>
      <div className="sidecol wide">
        {!m.running && (
          <Panel title="Setup">
            <SegmentedControl fullWidth value={m.mode} onChange={(v) => m.patch({ mode: v as TournamentMode })}
              data={[{ value: "match", label: "Match" }, { value: "roundrobin", label: "Round robin" }, { value: "gauntlet", label: "Gauntlet" }, { value: "sprt", label: "SPRT" }]} />
            <Text size="xs" c="dimmed" mt={6}>
              {{ match: "Two engines play a series, swapping colours.", roundrobin: "Every engine plays every other.", gauntlet: "The first engine plays each of the others.", sprt: "Plays until it is statistically clear whether the first engine is stronger. The standard test for an engine change." }[m.mode]}
            </Text>
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
              {(two ? m.entrants.slice(0, 2) : m.entrants).map((id, i) => (
                <Group key={i} gap={6} wrap="nowrap">
                  <Text size="xs" c="dimmed" w={14}>{i + 1}</Text>
                  <Select style={{ flex: 1 }} value={id} data={list} onChange={(v) => v && m.patch({ entrants: m.entrants.map((x, j) => (j === i ? v : x)) })} />
                  {!two && m.entrants.length > 2 && <ActionIcon variant="subtle" color="gray" onClick={() => m.patch({ entrants: m.entrants.filter((_, j) => j !== i) })}><IconTrash size={14} /></ActionIcon>}
                </Group>
              ))}
              {!two && m.entrants.length < 10 && <Button variant="default" leftSection={<IconPlus size={14} />} onClick={() => m.patch({ entrants: [...m.entrants, list[0]?.value ?? "wasabi"] })}>Add engine</Button>}
            </div>
            <Group mt={10} grow>
              {m.mode === "sprt" ? (
                <>
                  <NumberInput label="Elo0" value={m.elo0} onChange={(v) => typeof v === "number" && m.patch({ elo0: v })} />
                  <NumberInput label="Elo1" value={m.elo1} onChange={(v) => typeof v === "number" && m.patch({ elo1: v })} />
                </>
              ) : (
                <NumberInput label="Rounds (2 games each)" min={1} max={500} value={m.rounds} onChange={(v) => typeof v === "number" && m.patch({ rounds: v })} />
              )}
              <Select label="Time per move" value={String(m.moveTimeMs)} onChange={(v) => v && m.patch({ moveTimeMs: parseInt(v, 10) })}
                data={[50, 100, 200, 500, 1000, 3000].map((ms) => ({ value: String(ms), label: ms < 1000 ? `${ms} ms` : `${ms / 1000} s` }))} />
            </Group>
            <Switch mt={10} label="Start from varied openings" checked={m.useOpenings} onChange={(e) => m.patch({ useOpenings: e.currentTarget.checked })} />
            <Switch mt={6} label="Save games to the Library" checked={m.saveGames} onChange={(e) => m.patch({ saveGames: e.currentTarget.checked })} />
            <Text size="xs" c="dimmed" mt={6}>Each engine uses one thread. Every opening is played twice with colours swapped.</Text>
          </Panel>
        )}
        {m.running && (
          <Panel>
            <Group justify="space-between"><Text size="sm" truncate>{m.opening}</Text><Text size="xs" c="dimmed">Depth {m.depth}</Text></Group>
            {m.total > 0 && <><Progress mt={6} size="sm" value={(m.records.length / m.total) * 100} /><Text size="xs" c="dimmed" mt={2}>Game {m.records.length + 1} of {m.total}</Text></>}
          </Panel>
        )}
        {m.error && <Alert color="red" m={12} p="xs">{m.error}</Alert>}
        <Panel title="Standings">
          {two && m.records.length > 0 ? (
            <>
              <Group justify="space-between" align="flex-end">
                <div><Text fw={700} truncate maw={150}>{name(0)}</Text><Text fw={800} fz={30} lh={1} ff="ui-rounded, system-ui">{fmt(table.find((t) => t.index === 0)?.points ?? 0)}</Text></div>
                <div style={{ textAlign: "right" }}><Text fw={700} truncate maw={150}>{name(1)}</Text><Text fw={800} fz={30} lh={1} ff="ui-rounded, system-ui">{fmt(table.find((t) => t.index === 1)?.points ?? 0)}</Text></div>
              </Group>
              {elo && <div style={{ marginTop: 8 }}><ResultBar white={elo.w} draws={elo.d} black={elo.l} /></div>}
              {elo && <Group justify="space-between" mt={4}><Text size="xs">+{elo.w} ={elo.d} −{elo.l}</Text><Text size="xs" fw={600}>{elo.diff >= 0 ? "+" : ""}{elo.diff.toFixed(0)} ± {elo.margin.toFixed(0)} Elo</Text></Group>}
              {test && (
                <div style={{ marginTop: 8 }}>
                  <Progress size="sm" value={((test.llr - test.lower) / (test.upper - test.lower)) * 100} color={test.llr >= 0 ? "green" : "red"} />
                  <Text size="xs" c="dimmed" mt={2}>LLR {test.llr.toFixed(2)} (stops at {test.lower.toFixed(2)} or {test.upper.toFixed(2)})</Text>
                </div>
              )}
              {m.verdict && <Text mt={6} fw={700} c="green">{m.verdict}</Text>}
            </>
          ) : m.records.length > 0 ? (
            <table className="data">
              <thead><tr><th>#</th><th>Engine</th><th>Pts</th><th>Played</th><th>+ = −</th></tr></thead>
              <tbody>{table.map((t, i) => <tr key={t.index}><td>{i + 1}</td><td>{t.name}</td><td><b>{fmt(t.points)}</b></td><td>{t.played}</td><td>{t.wins} {t.draws} {t.losses}</td></tr>)}</tbody>
            </table>
          ) : <Text size="sm" c="dimmed">No games played yet.</Text>}
        </Panel>
        <Panel grow pad={false} title={`Games (${m.records.length})`}>
          {m.records.length ? [...m.records].reverse().map((r) => {
            const first = r.white === 0 ? r.result === "1-0" : r.black === 0 ? r.result === "0-1" : undefined;
            const drawn = r.result === "1/2-1/2";
            return (
              <div key={r.number} className="listrow" onDoubleClick={() => app.openGame(r.tree.clone())} title="Double-click to analyse">
                <Text size="xs" c="dimmed" w={22} ta="right">{r.number}</Text>
                {drawn ? <IconEqual size={12} color="#888" /> : first === undefined ? <span style={{ width: 12 }} /> : first ? <IconTriangleFilled size={10} color="#51cf66" /> : <IconTriangleInvertedFilled size={10} color="#ff6b6b" />}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" truncate>{m.names[r.white]} – {m.names[r.black]}</Text>
                  <Text size="xs" c="dimmed" truncate>{r.opening} · {Math.ceil(r.plies / 2)} moves · {r.reason}</Text>
                </div>
                <Text size="sm" fw={700}>{r.result}</Text>
              </div>
            );
          }) : <Empty title="No games yet">Finished games appear here. Double-click one to analyse it.</Empty>}
        </Panel>
        <div style={{ padding: 12, display: "flex", gap: 8 }}>
          <Button style={{ flex: 1 }} size="md" color={m.running ? "red" : undefined} leftSection={m.running ? <IconPlayerStopFilled size={16} /> : <IconPlayerPlayFilled size={16} />}
            onClick={() => (m.running ? m.stop() : m.start())} disabled={!list.length}>{m.running ? "Stop" : m.records.length ? "Start again" : "Start"}</Button>
          {!m.running && m.records.length > 0 && <Button size="md" variant="default" onClick={() => Promise.all(m.records.map((r) => db.importText(r.tree.toPgn(), "Engine games", true)))}>Save all</Button>}
        </div>
      </div>
    </div>
  );
}
