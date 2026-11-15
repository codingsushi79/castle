import { Button, Group, SegmentedControl, Select, Text, TextInput } from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Color, GameTree, GNode, turnOf } from "../lib/chess";
import { db, GameRow } from "../lib/db";
import { ndjson } from "../lib/lichess";
import { useRepertoire } from "../lib/repertoire";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import { Board } from "./Board";
import { Empty, MoveList, NavBar, PlayerStrip } from "./common";
import { tabTitle } from "../pages/Analysis";

/** The right half of the split view: another board, the library, the repertoire or live games. */
export function SplitPane({ main }: { main: GameTree }) {
  const [mode, setMode] = useState<string>(load("splitMode", "repertoire"));
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="toolbar">
        <SegmentedControl fullWidth style={{ flex: 1 }} value={mode} onChange={(v) => { setMode(v); save("splitMode", v); }}
          data={[{ value: "repertoire", label: "Repertoire" }, { value: "tab", label: "Other tab" }, { value: "library", label: "Library" }, { value: "tv", label: "Live" }]} />
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {mode === "repertoire" && <RepertoireCompare main={main} />}
        {mode === "tab" && <OtherTab main={main} />}
        {mode === "library" && <LibraryBrowser />}
        {mode === "tv" && <MiniTv />}
      </div>
    </div>
  );
}

function Viewer({ tree, orientation = "white", footer }: { tree: GameTree; orientation?: Color; footer?: React.ReactNode }) {
  useTree(tree);
  return (
    <>
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, flex: "none", height: "min(56%, 460px)" }}>
        <div className="boardrow"><Board fen={tree.fen} rules={tree.rules} orientation={orientation} lastMove={tree.current.lastMove} movable="both" onMove={(m) => tree.play(m)} /></div>
        <Group justify="center"><NavBar tree={tree} /></Group>
      </div>
      <div style={{ flex: 1, minHeight: 0, borderTop: "1px solid var(--border)" }}><MoveList tree={tree} /></div>
      {footer}
    </>
  );
}

function OtherTab({ main }: { main: GameTree }) {
  const tabs = useApp((s) => s.tabs).filter((t) => t.tree !== main);
  const [id, setId] = useState<number | undefined>(tabs[0]?.id);
  const tab = tabs.find((t) => t.id === id) ?? tabs[0];
  if (!tab) {
    return <Empty title="Only one tab is open">Open another analysis tab with the + button to compare two boards side by side.<Group justify="center" mt="sm"><Button variant="light" onClick={() => useApp.getState().newTab()}>New tab</Button></Group></Empty>;
  }
  return (
    <>
      <div style={{ padding: "8px 10px 0" }}><Select value={String(tab.id)} onChange={(v) => v && setId(parseInt(v, 10))} data={tabs.map((t) => ({ value: String(t.id), label: tabTitle(t.tree) }))} /></div>
      <Viewer tree={tab.tree} />
    </>
  );
}

function LibraryBrowser() {
  const [text, setText] = useState("");
  const [rows, setRows] = useState<GameRow[]>([]);
  const [tree, setTree] = useState<GameTree>();
  const revision = useApp((s) => s.libraryRevision);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => db.query({ text, limit: 200 }).then((r) => live && setRows(r.rows)).catch(() => {}), 150);
    return () => { live = false; clearTimeout(t); };
  }, [text, revision]);
  if (tree) {
    return <Viewer tree={tree} footer={
      <Group p={8} gap={6} grow>
        <Button variant="default" onClick={() => setTree(undefined)}>Back to the list</Button>
        <Button variant="light" leftSection={<IconExternalLink size={14} />} onClick={() => useApp.getState().newTab(tree.clone())}>Open as a tab</Button>
      </Group>
    } />;
  }
  return (
    <>
      <div style={{ padding: 10 }}><TextInput placeholder="Search players, events, openings" value={text} onChange={(e) => setText(e.currentTarget.value)} /></div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {rows.map((r) => (
          <div key={r.id} className="listrow" onClick={async () => { const t = GameTree.fromPgn(await db.get(r.id)); if (t) { t.toStart(); setTree(t); } }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Text size="sm" truncate>{r.white} – {r.black}</Text>
              <Text size="xs" c="dimmed" truncate>{[r.date, r.event, r.opening].filter(Boolean).join(" · ")}</Text>
            </div>
            <Text size="xs" fw={700}>{r.result}</Text>
          </div>
        ))}
      </div>
    </>
  );
}

/** Follows the moves on the main board through your repertoire. */
function RepertoireCompare({ main }: { main: GameTree }) {
  useTree(main);
  const rep = useRepertoire();
  const [color, setColor] = useState<Color>(load("splitRepColor", "white"));
  const tree = rep.trees[color];
  const { node, leftAt } = useMemo(() => {
    let n: GNode = tree.root;
    let left: GNode | undefined;
    if (main.root.fen !== tree.root.fen) return { node: n, leftAt: main.root };
    for (const step of main.path(main.current)) {
      const next = n.children.find((c) => c.uci === step.uci);
      if (!next) { left = step; break; }
      n = next;
    }
    return { node: n, leftAt: left };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [main.current, tree.revision, color, main]);
  const yourTurn = turnOf(node.fen) === color;
  return (
    <>
      <div style={{ padding: "8px 10px 0" }}>
        <SegmentedControl fullWidth size="xs" value={color} onChange={(v) => { setColor(v as Color); save("splitRepColor", v); }} data={[{ value: "white", label: "As White" }, { value: "black", label: "As Black" }]} />
      </div>
      <div style={{ padding: 10, height: "min(52%, 420px)", display: "flex", flex: "none" }}>
        <div className="boardrow">
          <Board fen={node.fen} orientation={color} lastMove={node.lastMove} readOnly
            arrows={node.children.map((c, i) => ({ from: c.uci!.slice(0, 2), to: c.uci!.slice(2, 4), color: i === 0 ? "green" : "paleGreen", strength: i === 0 ? 1 : 0.5 }))} />
        </div>
      </div>
      <div style={{ padding: "0 12px", flex: 1, overflowY: "auto" }}>
        {!tree.root.children.length ? (
          <Text size="sm" c="dimmed">Your {color} repertoire is empty. Build it on the Repertoire page.</Text>
        ) : leftAt ? (
          <>
            <Text fw={700} c="orange">Out of your repertoire</Text>
            <Text size="sm">{leftAt === main.root ? "This board does not start from the standard position." : `${leftAt.numberLabel} ${leftAt.san} is not in your ${color} repertoire.`}</Text>
            {node.children.length > 0 && <Text size="sm" c="dimmed" mt={4}>You prepared: {node.children.map((c) => c.san).join(", ")}</Text>}
          </>
        ) : node.children.length ? (
          <>
            <Text fw={700} c="green">In your repertoire</Text>
            <Text size="sm">{yourTurn ? "Your prepared move" : "Replies you prepared for"}: <b>{node.children.map((c) => c.san).join(", ")}</b></Text>
            {node.comment && <Text size="sm" c="dimmed" mt={4}>{node.comment}</Text>}
          </>
        ) : (
          <><Text fw={700}>End of your preparation</Text><Text size="sm" c="dimmed">The repertoire has no moves after this position.</Text></>
        )}
      </div>
    </>
  );
}

function MiniTv() {
  const [fen, setFen] = useState<string>();
  const [last, setLast] = useState<[string, string]>();
  const [players, setPlayers] = useState<Record<Color, string>>({ white: "…", black: "…" });
  const [orientation, setOrientation] = useState<Color>("white");
  const [clocks, setClocks] = useState<Record<Color, number>>({ white: 0, black: 0 });
  useEffect(() => {
    const abort = new AbortController();
    ndjson("https://lichess.org/api/tv/feed", (o) => {
      if (o.t === "featured") {
        const p: any = {};
        for (const x of o.d.players) p[x.color] = `${x.user?.title ? x.user.title + " " : ""}${x.user?.name ?? "?"} (${x.rating})`;
        setPlayers(p);
        setOrientation(o.d.orientation);
        setFen(`${o.d.fen.split(" ")[0]} w - - 0 1`);
      } else if (o.t === "fen") {
        setFen(`${o.d.fen} - - 0 1`);
        if (o.d.lm) setLast([o.d.lm.slice(0, 2), o.d.lm.slice(2, 4)]);
        setClocks({ white: o.d.wc ?? 0, black: o.d.bc ?? 0 });
      }
    }, { signal: abort.signal, auth: false }).catch(() => {});
    return () => abort.abort();
  }, []);
  const top: Color = orientation === "white" ? "black" : "white";
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
      <PlayerStrip name={players[top]} color={top} clock={clocks[top]} active={!!fen && turnOf(fen) === top} />
      <div className="boardrow"><Board fen={fen ?? "8/8/8/8/8/8/8/8 w - - 0 1"} orientation={orientation} lastMove={last} /></div>
      <PlayerStrip name={players[orientation]} color={orientation} clock={clocks[orientation]} active={!!fen && turnOf(fen) === orientation} />
      <Text size="xs" c="dimmed" ta="center">Lichess TV, top rated game</Text>
    </div>
  );
}
