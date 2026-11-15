import { Button, Group, Text } from "@mantine/core";
import { IconBolt, IconChartLine, IconCircleCheck, IconFlame } from "@tabler/icons-react";
import { Area, AreaChart, Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Stat } from "../components/common";
import { ReviewTrends, WeeklyReport } from "../components/WeeklyReport";
import { dailyStreak, THEME_NAMES, usePuzzles } from "../lib/puzzles";
import { forecast, useRepertoire } from "../lib/repertoire";
import { load } from "../lib/storage";
import { useApp } from "../lib/store";

const tip = { contentStyle: { background: "#25262b", border: "1px solid #34363c", fontSize: 12 }, cursor: { fill: "#ffffff10" } };

export default function ProgressPage() {
  const p = usePuzzles();
  useRepertoire((s) => s.cards);
  const go = useApp((s) => s.go);
  const attempts = p.solved + p.failed;
  const history = p.stats.ratingHistory.slice(-300).map((h, i) => ({ i, rating: h.r }));
  const themes = Object.entries(p.stats.themes)
    .filter(([k, v]) => v.attempts >= 3 && THEME_NAMES[k])
    .map(([k, v]) => ({ id: k, name: THEME_NAMES[k], accuracy: Math.round((v.solved / v.attempts) * 100), attempts: v.attempts }))
    .sort((a, b) => a.accuracy - b.accuracy);
  const upcoming = forecast();
  const rush = p.stats.rushScores.slice(-30).map((score, i) => ({ i: i + 1, score }));
  const drills = load<Record<string, number>>("drillBest", {});
  const section = (title: string, body: React.ReactNode) => (
    <div className="card"><Text fw={700} mb={8}>{title}</Text>{body}</div>
  );
  const none = (text: string) => <Text c="dimmed" size="sm" ta="center" py="lg">{text}</Text>;
  const lo = Math.min(...history.map((h) => h.rating)) - 20, hi = Math.max(...history.map((h) => h.rating)) + 20;

  return (
    <div className="page scroll">
      <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 1100 }}>
        <WeeklyReport />
        <Group grow gap={12}>
          <Stat label="Puzzle rating" value={p.rating} icon={<IconChartLine size={18} />} color="var(--mantine-primary-color-filled)" />
          <Stat label="Solved first try" value={attempts ? `${Math.round((p.solved / attempts) * 100)}%` : "–"} icon={<IconCircleCheck size={18} />} color="#51cf66" />
          <Stat label="Best rush" value={Math.max(0, ...p.stats.rushScores)} icon={<IconBolt size={18} />} color="#ffa94d" />
          <Stat label="Daily streak" value={dailyStreak(p.stats)} icon={<IconFlame size={18} />} color="#ff6b6b" />
        </Group>
        {section("Puzzle rating", history.length < 2 ? none("Solve a few rated puzzles to start the graph.") : (
          <div style={{ height: 180 }}>
            <ResponsiveContainer>
              <AreaChart data={history}>
                <YAxis domain={[lo, hi]} width={40} tick={{ fill: "#8b8f98", fontSize: 11 }} />
                <XAxis dataKey="i" hide />
                <Tooltip {...tip} />
                <Area type="monotone" dataKey="rating" stroke="var(--mantine-primary-color-filled)" fill="var(--mantine-primary-color-filled)" fillOpacity={0.18} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        ))}
        {section("Accuracy by theme", !themes.length ? none("Themes appear once you have tried each at least three times.") : (
          <>
            <div style={{ height: themes.length * 24 + 10 }}>
              <ResponsiveContainer>
                <BarChart data={themes} layout="vertical" margin={{ right: 30 }}>
                  <XAxis type="number" domain={[0, 100]} hide />
                  <YAxis type="category" dataKey="name" width={140} tick={{ fill: "#b5b8bf", fontSize: 11 }} />
                  <Tooltip {...tip} formatter={(v: number, _n, item: any) => [`${v}% of ${item.payload.attempts}`, "Solved"]} />
                  <Bar dataKey="accuracy" isAnimationActive={false} radius={3}>
                    {themes.map((t) => <Cell key={t.id} fill={t.accuracy < 50 ? "#fa5252" : t.accuracy < 75 ? "#fd7e14" : "#40c057"} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {themes[0].accuracy < 75 && <Button mt={6} variant="light" onClick={() => { p.setMode("rated"); p.setTheme(themes[0].id); go("puzzles"); }}>Practise {themes[0].name}</Button>}
          </>
        ))}
        <Group grow align="stretch" gap={12}>
          {section("Repertoire reviews ahead", upcoming.every((u) => !u.count) ? none("Build a repertoire to see upcoming reviews.") : (
            <div style={{ height: 150 }}>
              <ResponsiveContainer>
                <BarChart data={upcoming}>
                  <XAxis dataKey="day" tick={{ fill: "#8b8f98", fontSize: 10 }} />
                  <Tooltip {...tip} />
                  <Bar dataKey="count" isAnimationActive={false} radius={3}>{upcoming.map((u, i) => <Cell key={i} fill={i === 0 ? "#fd7e14" : "var(--mantine-primary-color-filled)"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ))}
          {section("Puzzle rush scores", !rush.length ? none("Play a rush to record a score.") : (
            <div style={{ height: 150 }}>
              <ResponsiveContainer>
                <BarChart data={rush}><XAxis dataKey="i" hide /><Tooltip {...tip} /><Bar dataKey="score" fill="#fd7e14" isAnimationActive={false} radius={3} /></BarChart>
              </ResponsiveContainer>
            </div>
          ))}
        </Group>
        <ReviewTrends />
        {section("Training bests", Object.keys(drills).length ? (
          <Group gap={12}>{Object.entries(drills).map(([k, v]) => <Stat key={k} label={k} value={v} />)}</Group>
        ) : none("Board vision and endgame results appear here."))}
      </div>
    </div>
  );
}
