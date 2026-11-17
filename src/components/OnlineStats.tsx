import { Group, Loader, Modal, Progress, Select, Table, Text } from "@mantine/core";
import { useEffect, useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { GameTree } from "../lib/chess";
import { CATEGORY_LABELS, StatGame, useOnline } from "../lib/online";
import { openingFor, useOpenings } from "../lib/openings";

/** Your online games at a glance: rating over time per category, colours, endings and openings. */
export function OnlineStats({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const o = useOnline();
  const book = useOpenings((s) => s.loaded);
  const [games, setGames] = useState<StatGame[]>();
  const [error, setError] = useState<string>();
  const [category, setCategory] = useState<string>("all");

  useEffect(() => {
    if (!opened) return;
    useOpenings.getState().load();
    setGames(undefined);
    o.loadStats().then(setGames).catch((e) => setError(e.message));
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  const played = useMemo(() => [...new Set((games ?? []).map((g) => g.category).filter(Boolean) as string[])], [games]);
  const list = useMemo(() => (games ?? []).filter((g) => category === "all" || g.category === category), [games, category]);
  const ratingCategory = category !== "all" ? category : played[0];
  const chart = useMemo(() => (games ?? []).filter((g) => g.rated && g.after != null && g.category === ratingCategory)
    .map((g, i) => ({ n: i + 1, rating: g.after, date: new Date(g.at).toLocaleDateString() })), [games, ratingCategory]);

  const record = (gs: StatGame[]) => ({
    games: gs.length, wins: gs.filter((g) => g.score === 1).length, draws: gs.filter((g) => g.score === 0.5).length,
    losses: gs.filter((g) => g.score === 0).length, pct: gs.length ? Math.round((gs.reduce((t, g) => t + g.score, 0) / gs.length) * 100) : 0,
  });
  const all = record(list), white = record(list.filter((g) => g.color === "white")), black = record(list.filter((g) => g.color === "black"));
  const endings = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of list) m.set(g.reason ?? "other", (m.get(g.reason ?? "other") ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [list]);
  // Openings: the deepest named position each game reached, from the side you played.
  const openings = useMemo(() => {
    if (!book) return [];
    const m = new Map<string, { name: string; color: string; games: number; score: number }>();
    for (const g of list) {
      if (g.variant !== "chess" || !g.moves.length) continue;
      const tree = new GameTree();
      for (const u of g.moves) if (!tree.play(u)) break;
      const name = openingFor(tree, tree.last)?.name;
      if (!name) continue;
      const key = `${name}|${g.color}`;
      const cur = m.get(key) ?? { name, color: g.color, games: 0, score: 0 };
      m.set(key, { ...cur, games: cur.games + 1, score: cur.score + g.score });
    }
    return [...m.values()].sort((a, b) => b.games - a.games).slice(0, 12);
  }, [list, book]);

  const row = (label: string, r: ReturnType<typeof record>) => (
    <div style={{ flex: 1 }}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fw={800} fz={22} ff="ui-rounded, system-ui">{r.games ? `${r.pct}%` : "–"}</Text>
      <Text size="xs" c="dimmed">{r.wins} won · {r.draws} drawn · {r.losses} lost</Text>
      <Progress.Root mt={4} size="sm">
        <Progress.Section value={r.games ? (r.wins / r.games) * 100 : 0} color="teal" />
        <Progress.Section value={r.games ? (r.draws / r.games) * 100 : 0} color="gray" />
        <Progress.Section value={r.games ? (r.losses / r.games) * 100 : 0} color="red" />
      </Progress.Root>
    </div>
  );

  return (
    <Modal opened={opened} onClose={onClose} size="xl" title={<Text fw={800}>Your online games</Text>}>
      {error ? <Text c="red" size="sm">{error}</Text> : !games ? <Loader size="sm" /> : !games.length ? (
        <Text size="sm" c="dimmed">Finished online games appear here once you've played some.</Text>
      ) : (
        <>
          <Select size="xs" w={220} value={category} allowDeselect={false} onChange={(v) => v && setCategory(v)}
            data={[{ value: "all", label: "All categories" }, ...played.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))]} />
          <Group mt="md" align="flex-start" gap="lg">
            {row(`All ${all.games} games`, all)}
            {row("As White", white)}
            {row("As Black", black)}
          </Group>
          <Text fw={700} size="sm" mt="lg">{CATEGORY_LABELS[ratingCategory ?? ""] ?? "Rating"} rating</Text>
          {chart.length > 1 ? (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                  <XAxis dataKey="n" tick={{ fontSize: 11 }} />
                  <YAxis domain={["dataMin - 30", "dataMax + 30"]} tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v) => [v as number, "Rating"]} labelFormatter={(n) => chart[Number(n) - 1]?.date ?? ""} />
                  <Line type="monotone" dataKey="rating" stroke="var(--mantine-primary-color-filled)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          ) : <Text size="xs" c="dimmed">Play a couple of rated games in this category to see a graph.</Text>}
          <Group mt="lg" align="flex-start" gap="xl">
            <div style={{ flex: 2, minWidth: 280 }}>
              <Text fw={700} size="sm" mb={4}>Openings</Text>
              {openings.length ? (
                <Table fz="xs" verticalSpacing={3}>
                  <Table.Tbody>
                    {openings.map((x) => (
                      <Table.Tr key={x.name + x.color}>
                        <Table.Td>{x.name}</Table.Td>
                        <Table.Td c="dimmed">as {x.color}</Table.Td>
                        <Table.Td ta="right">{x.games}</Table.Td>
                        <Table.Td ta="right" fw={700}>{Math.round((x.score / x.games) * 100)}%</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              ) : <Text size="xs" c="dimmed">{book ? "No named openings yet (standard chess games only)." : "Loading the opening book…"}</Text>}
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Text fw={700} size="sm" mb={4}>How games ended</Text>
              {endings.map(([reason, n]) => (
                <Group key={reason} justify="space-between"><Text size="xs">{reason}</Text><Text size="xs" fw={700}>{n}</Text></Group>
              ))}
            </div>
          </Group>
        </>
      )}
    </Modal>
  );
}
