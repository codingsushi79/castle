import { Group, Select, Text } from "@mantine/core";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { activitySince, ActivityKind } from "../lib/activity";
import { reviewRecords } from "../lib/batch";
import { THEME_NAMES, usePuzzles } from "../lib/puzzles";
import { dueNodes, useRepertoire } from "../lib/repertoire";
import { load } from "../lib/storage";

const DAY = 86400000;
const tip = { contentStyle: { background: "var(--bg-panel)", border: "1px solid var(--border)", fontSize: 12 }, cursor: { fill: "#8881" } };
const LABELS: Record<ActivityKind, string> = {
  puzzle: "Puzzles", rush: "Rush puzzles", repertoire: "Repertoire reviews", endgame: "Endgames", vision: "Vision drills",
  game: "Games played", review: "Games reviewed", quiz: "Opening quizzes", calculation: "Calculation", guess: "Guess-the-move",
};

/** What the last seven days of training looked like, and what to work on next. */
export function WeeklyReport() {
  const p = usePuzzles();
  const r = useRepertoire();
  const now = Date.now();
  const week = activitySince(now - 7 * DAY);
  const before = activitySince(now - 14 * DAY).filter((a) => a.t < now - 7 * DAY);
  const count = (list: typeof week, k: ActivityKind) => list.filter((a) => a.kind === k).length;
  const rate = (list: typeof week, k: ActivityKind) => {
    const xs = list.filter((a) => a.kind === k && a.ok !== undefined);
    return xs.length ? Math.round((xs.filter((a) => a.ok).length / xs.length) * 100) : undefined;
  };
  const hist = p.stats.ratingHistory;
  const startRating = [...hist].reverse().find((h) => h.t < now - 7 * DAY)?.r ?? hist.find((h) => h.t >= now - 7 * DAY)?.r;
  const change = startRating !== undefined ? p.rating - startRating : 0;
  const days = Array.from({ length: 7 }, (_, i) => {
    const start = new Date(now - (6 - i) * DAY).setHours(0, 0, 0, 0);
    return { day: new Date(start).toLocaleDateString(undefined, { weekday: "short" }), items: week.filter((a) => a.t >= start && a.t < start + DAY).length };
  });
  const kinds = (Object.keys(LABELS) as ActivityKind[]).filter((k) => count(week, k) || count(before, k));

  // Suggestions
  const focus: string[] = [];
  const themes = Object.entries(p.stats.themes).filter(([k, v]) => v.attempts >= 5 && THEME_NAMES[k]).map(([k, v]) => ({ k, acc: v.solved / v.attempts })).sort((a, b) => a.acc - b.acc);
  if (themes[0] && themes[0].acc < 0.6) focus.push(`Puzzles on “${THEME_NAMES[themes[0].k]}”: you solve ${Math.round(themes[0].acc * 100)}% of them, your weakest theme.`);
  const due = dueNodes(r.trees.white, "white", r.cards).length + dueNodes(r.trees.black, "black", r.cards).length;
  if (due > 10) focus.push(`${due} repertoire positions are waiting for review.`);
  if (p.mistakes.length) focus.push(`${p.mistakes.length} positions from your own games are in My mistakes.`);
  const history = load<{ phases: Record<string, number>; kinds: Record<string, number> }[]>("reviewHistory", []).slice(-20);
  const kindTotals: Record<string, number> = {};
  history.forEach((h) => Object.entries(h.kinds).forEach(([k, v]) => (kindTotals[k] = (kindTotals[k] ?? 0) + v)));
  const topKind = Object.entries(kindTotals).sort((a, b) => b[1] - a[1])[0];
  if (topKind && topKind[1] >= 3) focus.push(`In your reviewed games the most frequent error is the ${topKind[0]}.`);
  if (!count(week, "endgame")) focus.push("No endgame practice this week: try one position on the Training page.");
  if (!focus.length) focus.push("A balanced week. Keep the daily plan going.");

  const arrow = (a: number, b: number) => (a > b ? `▲ ${a - b}` : a < b ? `▼ ${b - a}` : "same");
  return (
    <div className="card">
      <Group justify="space-between" mb={8}>
        <Text fw={700}>This week</Text>
        <Text size="xs" c="dimmed">{new Date(now - 6 * DAY).toLocaleDateString()} – {new Date(now).toLocaleDateString()}</Text>
      </Group>
      <Group align="flex-start" gap={18} wrap="nowrap">
        <div style={{ flex: 1 }}>
          <Text size="sm" mb={6}>
            {week.length ? `${week.length} training items over ${days.filter((d) => d.items).length} day${days.filter((d) => d.items).length === 1 ? "" : "s"}` : "Nothing recorded this week yet."}
            {startRating !== undefined && change !== 0 ? `; puzzle rating ${change > 0 ? "up" : "down"} ${Math.abs(change)} to ${p.rating}` : ""}.
          </Text>
          <table className="data" style={{ marginBottom: 8 }}>
            <thead><tr><th>Activity</th><th>This week</th><th>Week before</th><th>Success</th></tr></thead>
            <tbody>
              {kinds.map((k) => (
                <tr key={k}><td>{LABELS[k]}</td><td><b>{count(week, k)}</b></td><td>{count(before, k)} <Text span size="xs" c="dimmed">{arrow(count(week, k), count(before, k))}</Text></td><td>{rate(week, k) !== undefined ? `${rate(week, k)}%` : ""}</td></tr>
              ))}
              {!kinds.length && <tr><td colSpan={4}><Text size="sm" c="dimmed">Activity appears here as you train.</Text></td></tr>}
            </tbody>
          </table>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4}>Focus next</Text>
          {focus.map((f, i) => <Text key={i} size="sm" mb={2}>• {f}</Text>)}
        </div>
        <div style={{ width: 240, height: 140, flex: "none" }}>
          <ResponsiveContainer><BarChart data={days}><XAxis dataKey="day" tick={{ fontSize: 10, fill: "#8b8f98" }} /><Tooltip {...tip} /><Bar dataKey="items" name="Items" fill="var(--mantine-primary-color-filled)" radius={3} isAnimationActive={false} /></BarChart></ResponsiveContainer>
        </div>
      </Group>
    </div>
  );
}

/** Accuracy and error kinds across games reviewed in the background. */
export function ReviewTrends() {
  const records = useMemo(() => Object.values(reviewRecords()), []);
  const players = useMemo(() => {
    const c = new Map<string, number>();
    records.forEach((r) => { c.set(r.white, (c.get(r.white) ?? 0) + 1); c.set(r.black, (c.get(r.black) ?? 0) + 1); });
    return [...c].sort((a, b) => b[1] - a[1]);
  }, [records]);
  const [player, setPlayer] = useState<string | null>(load("trendPlayer", null) ?? players[0]?.[0] ?? null);
  if (!records.length) return <div className="card"><Text fw={700} mb={4}>Reviewed games</Text><Text size="sm" c="dimmed">Review games in bulk from the Library (More, Review these games) to see accuracy trends here.</Text></div>;
  const mine = records.filter((r) => r.white === player || r.black === player).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const side = (r: (typeof mine)[0]) => (r.white === player ? "white" : "black");
  const data = mine.map((r, i) => ({ i: i + 1, date: r.date, accuracy: r.accuracy[side(r)] !== undefined ? Math.round(r.accuracy[side(r)]!) : null }));
  const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x !== null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : undefined; };
  const kinds: Record<string, number> = {}, phases: Record<string, number> = {};
  mine.forEach((r) => {
    Object.entries(r.kinds[side(r)] ?? {}).forEach(([k, v]) => (kinds[k] = (kinds[k] ?? 0) + v));
    Object.entries(r.phases[side(r)] ?? {}).forEach(([k, v]) => (phases[k] = (phases[k] ?? 0) + v));
  });
  const kindData = Object.entries(kinds).map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);
  const half = Math.floor(data.length / 2);
  const early = avg(data.slice(0, half).map((d) => d.accuracy)), late = avg(data.slice(half).map((d) => d.accuracy));
  return (
    <div className="card">
      <Group justify="space-between" mb={8}>
        <Text fw={700}>Reviewed games</Text>
        <Select w={220} searchable value={player} onChange={(v) => { setPlayer(v); localStorage.setItem("castle.trendPlayer", JSON.stringify(v)); }} data={players.map(([n, c]) => ({ value: n, label: `${n} (${c})` }))} />
      </Group>
      <Text size="sm" mb={8}>
        {mine.length} reviewed games, average accuracy {avg(data.map((d) => d.accuracy)) ?? "–"}%.
        {early !== undefined && late !== undefined && data.length >= 6 ? ` Earlier half ${early}%, recent half ${late}%.` : ""}
        {Object.keys(phases).length ? ` Most errors in the ${Object.entries(phases).sort((a, b) => b[1] - a[1])[0][0]}.` : ""}
      </Text>
      <Group grow align="flex-start">
        <div style={{ height: 170 }}>
          <ResponsiveContainer>
            <LineChart data={data}><CartesianGrid stroke="#8882" vertical={false} /><XAxis dataKey="i" tick={{ fontSize: 10, fill: "#8b8f98" }} /><YAxis domain={[0, 100]} width={30} tick={{ fontSize: 10, fill: "#8b8f98" }} /><Tooltip {...tip} /><Line dataKey="accuracy" stroke="var(--mantine-primary-color-filled)" dot={{ r: 2 }} connectNulls isAnimationActive={false} /></LineChart>
          </ResponsiveContainer>
        </div>
        <div style={{ height: 170 }}>
          {kindData.length ? (
            <ResponsiveContainer>
              <BarChart data={kindData} layout="vertical"><XAxis type="number" hide /><YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11, fill: "#b5b8bf" }} /><Tooltip {...tip} /><Bar dataKey="n" name="Errors" fill="#fa5252" radius={3} isAnimationActive={false} /></BarChart>
            </ResponsiveContainer>
          ) : <Text size="sm" c="dimmed">No serious errors recorded.</Text>}
        </div>
      </Group>
    </div>
  );
}
