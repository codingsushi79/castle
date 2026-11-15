import { Kbd, Modal, Text } from "@mantine/core";
import { Spotlight, spotlight, SpotlightActionData, SpotlightActionGroupData } from "@mantine/spotlight";
import "@mantine/spotlight/styles.css";
import { IconBook, IconChess, IconCommand, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { GameTree, tryPosition } from "../lib/chess";
import { db, GameRow } from "../lib/db";
import { useOpenings } from "../lib/openings";
import { hasAction, prettyCombo, runAction, SHORTCUTS, useShortcuts } from "../lib/shortcuts";
import { useApp } from "../lib/store";

/** ⌘K: every action, page and game in one search box. */
export function CommandPalette() {
  const [query, setQuery] = useState("");
  const [games, setGames] = useState<GameRow[]>([]);
  const keysFor = useShortcuts((s) => s.keysFor);
  const book = useOpenings();

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setGames([]);
    let live = true;
    const t = setTimeout(() => db.query({ text: q, limit: 8 }).then((r) => live && setGames(r.rows)).catch(() => {}), 120);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const actions = useMemo((): (SpotlightActionData | SpotlightActionGroupData)[] => {
    const q = query.trim();
    const groups: SpotlightActionGroupData[] = [];
    // A FEN typed or pasted straight in.
    if (q.includes("/") && tryPosition(q)) {
      groups.push({ group: "Position", actions: [{ id: "fen", label: "Analyse this position", description: q, leftSection: <IconChess size={18} />, onClick: () => useApp.getState().openGame(new GameTree(q)) }] });
    }
    const commands = SHORTCUTS.filter((d) => d.id !== "palette" && (hasAction(d.id) || d.id.startsWith("go.")))
      .map((d) => ({ id: d.id, label: d.label, description: d.group, keywords: [d.group], leftSection: <IconCommand size={18} />, rightSection: keysFor(d.id) ? <Kbd size="xs">{prettyCombo(keysFor(d.id))}</Kbd> : undefined, onClick: () => runAction(d.id) }));
    groups.push({ group: "Commands", actions: commands });
    if (games.length) {
      groups.push({
        group: "Games",
        actions: games.map((g) => ({ id: `game-${g.id}`, label: `${g.white} – ${g.black}`, description: [g.result, g.date, g.event, g.opening].filter(Boolean).join(" · "), keywords: [q], leftSection: <IconSearch size={18} />, onClick: () => db.open(g.id) })),
      });
    }
    if (q.length >= 3 && book.loaded) {
      const hits = book.all.filter((o) => o.name.toLowerCase().includes(q.toLowerCase())).slice(0, 6);
      if (hits.length) {
        groups.push({
          group: "Openings",
          actions: hits.map((o, i) => ({ id: `op-${i}-${o.eco}-${o.name}`, label: o.name, description: `${o.eco} · ${o.sans.join(" ")}`, keywords: [q], leftSection: <IconBook size={18} />, onClick: () => {
            const t = new GameTree();
            o.moves.forEach((m) => t.play(m));
            t.headers.set("Opening", o.name);
            useApp.getState().openGame(t);
            t.toEnd();
          } })),
        });
      }
    }
    return groups;
  }, [query, games, keysFor, book.loaded, book.all]);

  return (
    <Spotlight actions={actions} query={query} onQueryChange={setQuery} shortcut={null} limit={40} highlightQuery
      nothingFound="Nothing found" searchProps={{ leftSection: <IconSearch size={18} />, placeholder: "Search commands, games, openings, or paste a FEN" }}
      scrollable maxHeight={460} />
  );
}

export const openPalette = () => spotlight.open();

export function CheatSheet({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const keysFor = useShortcuts((s) => s.keysFor);
  const groups = [...new Set(SHORTCUTS.map((d) => d.group))];
  return (
    <Modal opened={opened} onClose={onClose} size={720} title={<Text fw={700}>Keyboard shortcuts</Text>}>
      <div style={{ columns: 2, columnGap: 28 }}>
        {groups.map((g) => (
          <div key={g} style={{ breakInside: "avoid", marginBottom: 14 }}>
            <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={4}>{g}</Text>
            {SHORTCUTS.filter((d) => d.group === g && keysFor(d.id)).map((d) => (
              <div key={d.id} className="row" style={{ justifyContent: "space-between", padding: "2px 0" }}>
                <Text size="sm">{d.label}</Text>
                <Kbd size="xs">{prettyCombo(keysFor(d.id))}</Kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
      <Text size="xs" c="dimmed">Change any of these in Settings, Keyboard.</Text>
    </Modal>
  );
}
