import { ActionIcon, Button, Checkbox, Group, Menu, Modal, Progress, Select, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  IconBookmark, IconChartBar, IconCopy, IconCrosshair, IconDownload, IconFilter, IconFolder, IconFolderPlus, IconInbox, IconSearch,
  IconTag, IconTrash, IconUpload, IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip as ChartTip, XAxis, YAxis } from "recharts";
import { Empty, ResultBar } from "../components/common";
import { PositionEditor } from "../components/Editor";
import { db, GameFilter, GameRow, PlayerRecord, PlayerStats } from "../lib/db";
import { isTauri, load, save } from "../lib/storage";
import { useApp } from "../lib/store";
import { BatchDialogBody, EventsView, PlayersView } from "../components/LibraryViews";
import { useBatch } from "../lib/batch";
import { usePacks } from "../lib/packs";
import { call } from "../lib/storage";
import { SegmentedControl } from "@mantine/core";

interface Smart {
  name: string;
  filter: GameFilter;
}

const say = (message: string) => notifications.show({ message, autoClose: 2500 });
const COLUMNS: [string, string][] = [["white", "White"], ["black", "Black"], ["result", "Result"], ["date", "Date"], ["event", "Event"], ["eco", "ECO"], ["plies", "Moves"]];

export default function LibraryPage() {
  const [view, setView] = useState<string>(load("libraryView", "games"));
  const [player, setPlayer] = useState<string>();
  const app = useApp();
  useEffect(() => {
    const p = app.takeIntent("playerPage") as string | undefined;
    if (p) { setPlayer(p); setView("players"); }
    if (app.intent && ["position", "player", "similar"].includes(app.intent.kind)) setView("games");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.intent]);
  return (
    <>
      <div className="toolbar">
        <SegmentedControl value={view} onChange={(v) => { setView(v); save("libraryView", v); }} data={[{ value: "games", label: "Games" }, { value: "events", label: "Events" }, { value: "players", label: "Players" }]} />
      </div>
      {view === "games" && <GamesView />}
      {view === "events" && <EventsView />}
      {view === "players" && <PlayersView key={player} initial={player} />}
    </>
  );
}

function GamesView() {
  const app = useApp();
  const revision = useApp((s) => s.libraryRevision);
  const [filter, setFilter] = useState<GameFilter>({ sort: "id", desc: true });
  const [label, setLabel] = useState<string>();
  const [rows, setRows] = useState<GameRow[]>([]);
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(400);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number>();
  const [shelves, setShelves] = useState<{ folders: [string, number][]; tags: [string, number][] }>({ folders: [], tags: [] });
  const [smart, setSmart] = useState<Smart[]>(load("smartFilters", []));
  const [pattern, setPattern] = useState(false);
  const [stats, setStats] = useState(false);
  const [importing, setImporting] = useState<{ count: number } | undefined>();
  const [importOpts, setImportOpts] = useState<{ path: string } | undefined>();
  const [prompt, setPrompt] = useState<{ kind: "folder" | "tag" | "smart"; value: string }>();
  const [menu, setMenu] = useState<{ x: number; y: number }>();
  const [busy, setBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [packName, setPackName] = useState<string>();
  const batch = useBatch();
  const packs = usePacks();
  /** The selected games, or every game in the current list. */
  const targetIds = async () => (ids.length ? ids : (await db.query({ ...filter, limit: 5000 })).rows.map((r) => r.id));

  useEffect(() => {
    const fen = app.takeIntent("position") as string | undefined;
    if (fen) { setFilter({ sort: "id", desc: true, fen }); setLabel("Exact position"); }
    const player = app.takeIntent("player") as string | undefined;
    if (player) { setFilter({ sort: "id", desc: true, player }); setLabel(undefined); }
    const similar = app.takeIntent("similar") as { fen: string; mode: string } | undefined;
    if (similar) {
      setBusy(true);
      call<number[]>("db_similar", { fen: similar.fen, mode: similar.mode, limit: 5000 })
        .then((ids) => { setFilter({ sort: "id", desc: true, ids }); setLabel(`${similar.mode === "pawns" ? "Same pawn structure" : "Same material"}: ${ids.length.toLocaleString()} games`); })
        .catch((e) => say(String(e)))
        .finally(() => setBusy(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.intent]);

  useEffect(() => {
    let live = true;
    db.query({ ...filter, limit }).then((r) => { if (live) { setRows(r.rows); setTotal(r.total); } }).catch(() => {});
    db.shelves().then((s) => live && setShelves(s));
    return () => { live = false; };
  }, [filter, limit, revision]);

  useEffect(() => {
    if (!isTauri) return;
    const un = listen<{ count: number; added: number; skipped: number; done: boolean; error?: string }>("import-progress", (e) => {
      if (e.payload.done) {
        setImporting(undefined);
        useApp.getState().bumpLibrary();
        say(e.payload.error ? `Import failed: ${e.payload.error}` : `Imported ${e.payload.added.toLocaleString()} games${e.payload.skipped ? `, skipped ${e.payload.skipped.toLocaleString()} already present` : ""}`);
      } else setImporting({ count: e.payload.count });
    });
    return () => { un.then((f) => f()); };
  }, []);

  const patch = (p: Partial<GameFilter>) => { setFilter((f) => ({ ...f, ...p })); setLimit(400); };
  const reset = (p: Partial<GameFilter> = {}) => { setFilter({ sort: "id", desc: true, ...p }); setLabel(undefined); setSelected(new Set()); setLimit(400); };
  const ids = [...selected];

  const click = (row: GameRow, index: number, e: React.MouseEvent) => {
    if (e.shiftKey && anchor !== undefined) {
      const [a, b] = [Math.min(anchor, index), Math.max(anchor, index)];
      setSelected(new Set(rows.slice(a, b + 1).map((r) => r.id)));
    } else if (e.metaKey) {
      const next = new Set(selected);
      next.has(row.id) ? next.delete(row.id) : next.add(row.id);
      setSelected(next);
      setAnchor(index);
    } else {
      setSelected(new Set([row.id]));
      setAnchor(index);
    }
  };

  const pickImport = async () => {
    const path = await openDialog({ filters: [{ name: "PGN", extensions: ["pgn", "zst", "txt"] }] });
    if (typeof path === "string") setImportOpts({ path });
  };

  const exportGames = async () => {
    const path = await saveDialog({ defaultPath: "Games.pgn", filters: [{ name: "PGN", extensions: ["pgn"] }] });
    if (!path) return;
    const n = await db.exportTo(ids.length ? { ids } : filter, path);
    say(`Exported ${n.toLocaleString()} games`);
  };

  const active = (f?: string, t?: string) => filter.folder === f && filter.tag === t && !label && !filter.player;
  const chips: [string, () => void][] = [];
  if (label) chips.push([label, () => reset()]);
  if (filter.player) chips.push([`Player: ${filter.player}${filter.color ? ` as ${filter.color}` : ""}${filter.result ? `, ${filter.result}` : ""}`, () => patch({ player: undefined, color: undefined, result: undefined })]);
  if (filter.eco) chips.push([`Opening: ${filter.eco}`, () => patch({ eco: undefined })]);

  return (
    <div className="page">
      <div style={{ width: 210, flex: "none", borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflowY: "auto" }}>
        <div className={"listrow" + (active(undefined, undefined) ? " on" : "")} onClick={() => reset()}><IconInbox size={15} /> All games</div>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={12} pt={12} pb={4}>Folders</Text>
        {shelves.folders.filter(([f]) => f).map(([f, n]) => (
          <div key={f} className={"listrow" + (active(f, undefined) ? " on" : "")} onClick={() => reset({ folder: f })}>
            <IconFolder size={15} /> <Text size="sm" truncate style={{ flex: 1 }}>{f}</Text><Text size="xs" c="dimmed">{n.toLocaleString()}</Text>
          </div>
        ))}
        {!shelves.folders.some(([f]) => f) && <Text size="xs" c="dimmed" px={12}>Select games, then Move to folder.</Text>}
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={12} pt={12} pb={4}>Tags</Text>
        {shelves.tags.map(([t, n]) => (
          <div key={t} className={"listrow" + (active(undefined, t) ? " on" : "")} onClick={() => reset({ tag: t })}>
            <IconTag size={15} /> <Text size="sm" truncate style={{ flex: 1 }}>{t}</Text><Text size="xs" c="dimmed">{n}</Text>
          </div>
        ))}
        {!shelves.tags.length && <Text size="xs" c="dimmed" px={12}>No tags yet.</Text>}
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={12} pt={12} pb={4}>Smart filters</Text>
        {smart.map((s, i) => (
          <div key={i} className="listrow" onClick={() => { setFilter({ sort: "id", desc: true, ...s.filter }); setLabel(s.filter.fen ? s.name : undefined); }}>
            <IconBookmark size={15} /> <Text size="sm" truncate style={{ flex: 1 }}>{s.name}</Text>
            <IconX size={12} onClick={(e) => { e.stopPropagation(); const next = smart.filter((_, j) => j !== i); setSmart(next); save("smartFilters", next); }} />
          </div>
        ))}
        <div style={{ padding: "6px 12px" }}>
          <Button fullWidth variant="default" leftSection={<IconFilter size={13} />} onClick={() => setPrompt({ kind: "smart", value: "" })}>Save current filter</Button>
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div className="toolbar">
          <TextInput w={200} leftSection={<IconSearch size={14} />} placeholder="Players, events, openings" value={filter.text ?? ""} onChange={(e) => patch({ text: e.currentTarget.value })} />
          <PlayerPicker value={filter.player} onChange={(player) => patch({ player })} />
          {filter.player && (
            <>
              <Select w={100} placeholder="Colour" clearable allowDeselect value={filter.color ?? null} onChange={(v) => patch({ color: v ?? undefined })} data={[{ value: "white", label: "As White" }, { value: "black", label: "As Black" }]} />
              <Select w={90} placeholder="Result" clearable allowDeselect value={filter.result ?? null} onChange={(v) => patch({ result: v ?? undefined })} data={[{ value: "win", label: "Wins" }, { value: "loss", label: "Losses" }, { value: "draw", label: "Draws" }]} />
            </>
          )}
          <TextInput w={110} placeholder="ECO or opening" value={filter.eco ?? ""} onChange={(e) => patch({ eco: e.currentTarget.value || undefined })} />
          <span style={{ flex: 1 }} />
          <Tooltip label="Import a PGN file"><ActionIcon variant="subtle" color="gray" onClick={pickImport}><IconDownload size={17} /></ActionIcon></Tooltip>
          <Tooltip label="Export these games"><ActionIcon variant="subtle" color="gray" onClick={exportGames}><IconUpload size={17} /></ActionIcon></Tooltip>
          <Tooltip label="Search by pieces on the board"><ActionIcon variant="subtle" color="gray" onClick={() => setPattern(true)}><IconCrosshair size={17} /></ActionIcon></Tooltip>
          <Tooltip label="Player statistics"><ActionIcon variant="subtle" color="gray" onClick={() => setStats(true)}><IconChartBar size={17} /></ActionIcon></Tooltip>
          <Menu shadow="md" position="bottom-end">
            <Menu.Target><Button variant="default">More</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => setBatchOpen(true)}>Review {ids.length ? `${ids.length} selected` : "these"} games…</Menu.Item>
              <Menu.Item onClick={() => setPackName(label ?? filter.folder ?? filter.player ?? "My games")}>Make a puzzle pack…</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={async () => {
                const groups = await db.duplicates();
                if (!groups.length) return say("No duplicate games found");
                setFilter({ sort: "white", ids: groups.flatMap((g) => g.ids) });
                setLabel(`${groups.length} duplicated games`);
              }}>Find duplicates</Menu.Item>
              <Menu.Item onClick={async () => { const n = await db.mergeDuplicates(); say(n ? `Merged duplicates: removed ${n} extra copies` : "No duplicates to merge"); reset(); }}>Merge duplicates</Menu.Item>
              <Menu.Item onClick={async () => { await call("db_compact"); say("Library compacted"); }}>Compact database</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
        {(chips.length > 0 || busy) && (
          <div className="toolbar" style={{ background: "#1a9a7a1f" }}>
            {busy && <Text size="sm">Searching every game…</Text>}
            {chips.map(([text, clear]) => (
              <Button key={text} variant="light" rightSection={<IconX size={12} />} onClick={clear}>{text}</Button>
            ))}
          </div>
        )}
        {(batch.running || packs.building) && (
          <div className="toolbar" style={{ background: "#1a9a7a1f" }}>
            {batch.running && <><Text size="sm" style={{ flex: 1 }}>Reviewing game {batch.done + 1} of {batch.total}{batch.current ? `: ${batch.current}` : ""}</Text><Button variant="default" onClick={() => batch.stop()}>Stop</Button></>}
            {packs.building && <><Text size="sm" style={{ flex: 1 }}>Building “{packs.building.name}”: game {packs.building.done} of {packs.building.total}, {packs.building.found} puzzles so far</Text><Button variant="default" onClick={() => packs.cancel()}>Stop</Button></>}
          </div>
        )}
        {importing && <div style={{ padding: "6px 12px" }}><Text size="xs" mb={3}>Importing… {importing.count.toLocaleString()} games read</Text><Progress value={100} animated size="xs" /></div>}
        <div style={{ flex: 1, overflow: "auto" }} onContextMenu={(e) => { if (ids.length) { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); } }}>
          {rows.length ? (
            <table className="data">
              <thead>
                <tr>
                  {COLUMNS.map(([key, title]) => (
                    <th key={key} onClick={() => patch({ sort: key, desc: filter.sort === key ? !filter.desc : false })}>{title}{filter.sort === key ? (filter.desc ? " ↓" : " ↑") : ""}</th>
                  ))}
                  <th>Opening</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className={selected.has(r.id) ? "on" : ""} onClick={(e) => click(r, i, e)} onDoubleClick={() => db.open(r.id)}
                    onContextMenu={() => { if (!selected.has(r.id)) setSelected(new Set([r.id])); }}>
                    <td>{r.white}{r.white_elo ? <Text span c="dimmed" size="xs"> {r.white_elo}</Text> : null}</td>
                    <td>{r.black}{r.black_elo ? <Text span c="dimmed" size="xs"> {r.black_elo}</Text> : null}</td>
                    <td>{r.result}</td>
                    <td>{r.date}</td>
                    <td>{r.event}</td>
                    <td>{r.eco}</td>
                    <td>{Math.ceil(r.plies / 2)}</td>
                    <td>{r.opening || r.variant}</td>
                    <td>{r.tags.join(", ")}{r.folder ? <Text span c="dimmed" size="xs"> {r.folder}</Text> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : total === 0 && !filter.text && !label && !filter.player ? (
            <Empty icon={<IconInbox size={34} />} title="No games yet">
              Games you play are saved here automatically. Import PGN files (including large .pgn.zst databases), or download your online games from the Accounts page.
              <Group justify="center" mt="sm"><Button variant="light" onClick={pickImport}>Import PGN…</Button><Button variant="default" onClick={() => app.go("accounts")}>Open Accounts</Button></Group>
            </Empty>
          ) : (
            <Empty title="No matching games">Nothing in the library fits these filters.</Empty>
          )}
          {rows.length < total && <Group justify="center" p="sm"><Button variant="default" onClick={() => setLimit(limit + 1000)}>Show more ({(total - rows.length).toLocaleString()} left)</Button></Group>}
        </div>
        <div className="toolbar" style={{ borderTop: "1px solid var(--border)", borderBottom: 0 }}>
          <Text size="xs" c="dimmed">{total.toLocaleString()} games{ids.length ? ` · ${ids.length} selected` : ""}</Text>
          <span style={{ flex: 1 }} />
          <Button variant="default" disabled={ids.length !== 1} onClick={() => db.open(ids[0])}>Open</Button>
          <Button variant="default" disabled={!ids.length} leftSection={<IconFolderPlus size={14} />} onClick={() => setPrompt({ kind: "folder", value: "" })}>Move to folder</Button>
          <Button variant="default" disabled={!ids.length} leftSection={<IconTag size={14} />} onClick={() => setPrompt({ kind: "tag", value: "" })}>Tag</Button>
          <Button variant="default" color="red" disabled={!ids.length} leftSection={<IconTrash size={14} />} onClick={() => { db.remove(ids); setSelected(new Set()); }}>Delete</Button>
        </div>
      </div>

      <Menu opened={!!menu} onChange={(o) => !o && setMenu(undefined)} position="bottom-start">
        <Menu.Target><div style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item disabled={ids.length !== 1} onClick={() => db.open(ids[0])}>Open in Analysis</Menu.Item>
          <Menu.Item onClick={async () => { const texts = await Promise.all(ids.slice(0, 200).map((id) => db.get(id))); navigator.clipboard.writeText(texts.join("\n\n")); say("PGN copied"); }}>Copy PGN</Menu.Item>
          <Menu.Item onClick={() => setPrompt({ kind: "folder", value: "" })}>Move to folder…</Menu.Item>
          <Menu.Item onClick={() => setPrompt({ kind: "tag", value: "" })}>Add tag…</Menu.Item>
          {shelves.tags.length > 0 && <Menu.Label>Remove tag</Menu.Label>}
          {shelves.tags.slice(0, 8).map(([t]) => <Menu.Item key={t} onClick={() => db.setTags(ids, [], [t])}>{t}</Menu.Item>)}
          <Menu.Divider />
          <Menu.Item color="red" onClick={() => { db.remove(ids); setSelected(new Set()); }}>Delete</Menu.Item>
        </Menu.Dropdown>
      </Menu>

      {pattern && (
        <PositionEditor opened purpose="pattern" onClose={() => setPattern(false)} onDone={async (_fen, pat) => {
          setBusy(true);
          const hits = await db.pattern(pat).catch(() => [] as number[]);
          setBusy(false);
          setFilter({ sort: "id", desc: true, ids: hits });
          setLabel(`Pattern: ${hits.length.toLocaleString()} games`);
        }} />
      )}
      {stats && <StatsModal onClose={() => setStats(false)} initial={filter.player} onFilter={(f) => { setStats(false); reset(f); }} />}
      <Modal opened={batchOpen} onClose={() => setBatchOpen(false)} title={<Text fw={700}>Review games</Text>}>
        <BatchDialogBody count={ids.length || total} onStart={async (ms) => { setBatchOpen(false); batch.start(await targetIds(), ms); }} />
      </Modal>
      <Modal opened={packName !== undefined} onClose={() => setPackName(undefined)} title={<Text fw={700}>Make a puzzle pack</Text>}>
        <Text size="sm">Scans {ids.length || Math.min(total, 5000)} game{(ids.length || total) === 1 ? "" : "s"} for moves that threw away the game and had a single clear punishment, and turns each into a puzzle. Takes about ten seconds a game.</Text>
        <TextInput mt="sm" label="Name" value={packName ?? ""} onChange={(e) => setPackName(e.currentTarget.value)} />
        <Group justify="flex-end" mt="md"><Button disabled={!packName?.trim()} onClick={async () => { const name = packName!.trim(); setPackName(undefined); packs.build(name, await targetIds()); }}>Build pack</Button></Group>
      </Modal>
      <Modal opened={!!importOpts} onClose={() => setImportOpts(undefined)} title={<Text fw={700}>Import games</Text>}>
        <ImportForm path={importOpts?.path ?? ""} folders={shelves.folders.map(([f]) => f).filter(Boolean)} onStart={(folder, dedupe, maxPly) => {
          db.importFile(importOpts!.path, folder, dedupe, maxPly);
          setImporting({ count: 0 });
          setImportOpts(undefined);
        }} />
      </Modal>
      <Modal opened={!!prompt} onClose={() => setPrompt(undefined)} size="sm" title={<Text fw={700}>{prompt?.kind === "folder" ? "Move to folder" : prompt?.kind === "tag" ? "Add tag" : "Save filter"}</Text>}>
        <TextInput autoFocus data-autofocus placeholder={prompt?.kind === "folder" ? "Folder name (empty for none)" : prompt?.kind === "tag" ? "Tag" : "Name for this filter"} value={prompt?.value ?? ""}
          onChange={(e) => setPrompt((p) => p && { ...p, value: e.currentTarget.value })}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || !prompt) return;
            const v = prompt.value.trim();
            if (prompt.kind === "folder") db.setFolder(ids, v);
            else if (prompt.kind === "tag" && v) db.setTags(ids, [v], []);
            else if (prompt.kind === "smart" && v) {
              const { limit: _l, offset: _o, ...rest } = filter;
              const next = [...smart, { name: v, filter: rest }];
              setSmart(next);
              save("smartFilters", next);
            }
            setPrompt(undefined);
          }} />
        {prompt?.kind === "folder" && shelves.folders.some(([f]) => f) && (
          <Group gap={6} mt="sm">{shelves.folders.filter(([f]) => f).map(([f]) => <Button key={f} variant="default" onClick={() => { db.setFolder(ids, f); setPrompt(undefined); }}>{f}</Button>)}</Group>
        )}
        <Text size="xs" c="dimmed" mt="sm">Press Return to confirm.</Text>
      </Modal>
    </div>
  );
}

function ImportForm({ path, folders, onStart }: { path: string; folders: string[]; onStart: (folder: string, dedupe: boolean, maxPly: number) => void }) {
  const [folder, setFolder] = useState("");
  const [dedupe, setDedupe] = useState(true);
  const [depth, setDepth] = useState("600");
  return (
    <>
      <Text size="sm" mb="sm" style={{ wordBreak: "break-all" }}>{path.split("/").pop()}</Text>
      <TextInput label="Folder" placeholder={folders.length ? `For example: ${folders[0]}` : "Optional"} value={folder} onChange={(e) => setFolder(e.currentTarget.value)} />
      <Select mt="sm" label="Position index" value={depth} onChange={(v) => v && setDepth(v)}
        description="The index powers the explorer and position search. Indexing fewer moves keeps very large databases small and fast."
        data={[{ value: "600", label: "Every move (best for your own games)" }, { value: "60", label: "First 30 moves" }, { value: "30", label: "First 15 moves (large databases)" }, { value: "0", label: "No index (fastest import)" }]} />
      <Checkbox mt="sm" label="Skip games already in the library" checked={dedupe} onChange={(e) => setDedupe(e.currentTarget.checked)} />
      <Group justify="flex-end" mt="md"><Button onClick={() => onStart(folder.trim(), dedupe, parseInt(depth, 10))}>Import</Button></Group>
    </>
  );
}

function PlayerPicker({ value, onChange }: { value?: string; onChange: (v?: string) => void }) {
  const revision = useApp((s) => s.libraryRevision);
  const [players, setPlayers] = useState<[string, number][]>([]);
  useEffect(() => { db.players().then(setPlayers); }, [revision]);
  return <Select w={170} searchable clearable allowDeselect placeholder="Player" value={value ?? null} onChange={(v) => onChange(v ?? undefined)} data={players.map(([n, c]) => ({ value: n, label: `${n} (${c})` }))} />;
}

function StatsModal({ onClose, initial, onFilter }: { onClose: () => void; initial?: string; onFilter: (f: GameFilter) => void }) {
  const [players, setPlayers] = useState<[string, number][]>([]);
  const [name, setName] = useState(initial);
  const [stats, setStats] = useState<PlayerStats>();
  useEffect(() => { db.players().then((p) => { setPlayers(p); if (!name && p.length) setName(p[0][0]); }); /* eslint-disable-next-line */ }, []);
  useEffect(() => { if (name) db.playerStats(name).then(setStats).catch(() => {}); }, [name]);
  const data = useMemo(() => (stats?.openings ?? []).slice(0, 12).map((o) => ({ name: `${o.name.slice(0, 26)} (${o.color[0].toUpperCase()})`, Won: o.record.wins, Drawn: o.record.draws, Lost: o.record.losses, raw: o })), [stats]);
  const card = (title: string, r: PlayerRecord, color: string) => (
    <div className="card pressable" style={{ flex: 1 }} onClick={() => name && onFilter({ player: name, color })}>
      <Text size="sm" fw={600}>{title}</Text>
      <Group align="baseline" gap={6}><Text fw={800} fz={26} ff="ui-rounded, system-ui">{r.games ? Math.round(((r.wins + r.draws / 2) / r.games) * 100) + "%" : "–"}</Text><Text size="xs" c="dimmed">{r.games} games</Text></Group>
      <ResultBar white={r.wins} draws={r.draws} black={r.losses} />
      <Text size="xs" c="dimmed" mt={4}>{r.wins} won · {r.draws} drawn · {r.losses} lost</Text>
    </div>
  );
  return (
    <Modal opened onClose={onClose} size={680} title={<Text fw={700}>Player statistics</Text>}>
      <Select searchable value={name ?? null} onChange={(v) => v && setName(v)} data={players.map(([n, c]) => ({ value: n, label: `${n} (${c})` }))} mb="sm" />
      {stats && (
        <>
          <Group grow>{card("As White", stats.white, "white")}{card("As Black", stats.black, "black")}</Group>
          <Text fw={600} mt="md" mb={4}>By opening</Text>
          <div style={{ height: Math.max(120, data.length * 26 + 30) }}>
            <ResponsiveContainer>
              <BarChart data={data} layout="vertical" margin={{ left: 0, right: 10 }}>
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="name" width={210} tick={{ fill: "#b5b8bf", fontSize: 11 }} />
                <ChartTip contentStyle={{ background: "#25262b", border: "1px solid #34363c" }} cursor={{ fill: "#ffffff10" }} />
                <Bar dataKey="Won" stackId="a" fill="#40c057" isAnimationActive={false} />
                <Bar dataKey="Drawn" stackId="a" fill="#868e96" isAnimationActive={false} />
                <Bar dataKey="Lost" stackId="a" fill="#fa5252" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <Text size="xs" c="dimmed">Click a card to list those games.</Text>
        </>
      )}
    </Modal>
  );
}
