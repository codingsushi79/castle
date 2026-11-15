import { Button, Group, Progress, SegmentedControl, Text } from "@mantine/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { IconBrain, IconCheck, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { Empty, MoveList, NavBar, Panel, Stat } from "../components/common";
import { ExplorerRows } from "../components/Explorer";
import { Color, GameTree, splitPgn } from "../lib/chess";
import { db, ExplorerMove } from "../lib/db";
import { openingFor, useOpenings } from "../lib/openings";
import { dueNodes, learnedCount, positions, useRepertoire } from "../lib/repertoire";
import { Sound } from "../lib/sound";
import { call } from "../lib/storage";
import { activeTree, useApp, useTree } from "../lib/store";

export default function RepertoirePage() {
  const r = useRepertoire();
  return r.training ? <Trainer /> : <Builder />;
}

function Builder() {
  const r = useRepertoire();
  const tree = r.trees[r.color];
  useTree(tree);
  useOpenings((s) => s.loaded);
  const libraryRevision = useApp((s) => s.libraryRevision);
  const [library, setLibrary] = useState<ExplorerMove[]>([]);
  const [confirm, setConfirm] = useState(false);
  const total = positions(tree, r.color).length;
  const due = dueNodes(tree, r.color, r.cards).length;
  const opening = openingFor(tree);
  const analysis = activeTree();

  useEffect(() => { db.explorer(tree.fen).then(setLibrary); }, [tree.fen, libraryRevision]);
  useEffect(() => r.saveTrees(), [tree.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const importPgn = async () => {
    const path = await openDialog({ filters: [{ name: "PGN", extensions: ["pgn"] }] });
    if (typeof path !== "string") return;
    const text = await call<string>("read_text", { path });
    for (const g of splitPgn(text)) {
      const t = GameTree.fromPgn(g);
      if (t) r.importTree(t, r.color);
    }
  };

  return (
    <div className="page">
      <div className="boardcol">
        <div className="toolbar" style={{ margin: "-14px -16px 6px" }}>
          <SegmentedControl value={r.color} onChange={(v) => r.setColor(v as Color)} data={[{ value: "white", label: "White repertoire" }, { value: "black", label: "Black repertoire" }]} />
          <span style={{ flex: 1 }} />
          <Text size="xs" c="dimmed">{opening ? `${opening.eco} ${opening.name}` : ""}</Text>
        </div>
        <div className="boardrow">
          <Board key={r.color} fen={tree.fen} orientation={r.color} movable="both" lastMove={tree.current.lastMove} shapes={tree.current.shapes}
            onShapes={(s) => { tree.current.shapes = s; tree.revision++; r.saveTrees(); }}
            onMove={(m) => { const n = tree.play(m); if (n) Sound.forSan(n.san); }} />
        </div>
        <Group justify="center"><NavBar tree={tree} /></Group>
      </div>
      <div className="sidecol">
        <Panel>
          <Group gap={8} grow>
            <Stat label="Positions" value={total} />
            <Stat label="Due" value={due} color="#ffa94d" />
            <Stat label="Learned" value={learnedCount(tree, r.color, r.cards)} />
          </Group>
        </Panel>
        <Panel grow pad={false} title="Lines">
          {tree.root.children.length ? <MoveList tree={tree} onContext={(n) => tree.delete(n)} /> : (
            <Empty title="Empty repertoire">Play moves on the board to add lines. Add several replies for the opponent and one for yourself. Right-click a move to delete it.</Empty>
          )}
        </Panel>
        {library.length > 0 && (
          <Panel title="Played in your library" pad={false}>
            <div style={{ maxHeight: 150, overflowY: "auto" }}>
              <ExplorerRows moves={library.slice(0, 8)} onPlay={(san) => tree.playSan(san)} />
            </div>
          </Panel>
        )}
        <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <Group gap={6}>
            <Button variant="default" onClick={importPgn}>Import PGN…</Button>
            <Button variant="default" disabled={!analysis.root.children.length || !analysis.isStandardStart} onClick={() => r.importTree(analysis, r.color)}>From Analysis</Button>
            <span style={{ flex: 1 }} />
            {confirm ? (
              <>
                <Button color="red" onClick={() => { r.clear(r.color); setConfirm(false); }}>Delete all lines</Button>
                <Button variant="default" onClick={() => setConfirm(false)}>Keep</Button>
              </>
            ) : (
              <Button variant="default" color="red" disabled={!tree.root.children.length} onClick={() => setConfirm(true)}><IconTrash size={14} /></Button>
            )}
          </Group>
          <Button fullWidth size="md" leftSection={<IconBrain size={16} />} disabled={!due} onClick={() => r.start()}>
            {due ? `Train ${Math.min(due, 30)} due position${due === 1 ? "" : "s"}` : "Nothing due"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Trainer() {
  const r = useRepertoire();
  const tree = r.trees[r.color];
  const [shake, setShake] = useState(0);
  useEffect(() => { if (r.status === "wrong") setShake((n) => n + 1); }, [r.status]);
  const node = r.node;
  const fen = r.status === "correct" && r.answerFen ? r.answerFen : node?.fen ?? tree.root.fen;
  const expected = node?.children.map((c) => c.san).join(" or ") ?? "";
  const [title, detail, color] = {
    asking: ["Your move", "Play the reply from your repertoire.", undefined],
    correct: ["Correct", "On to the next one.", "green"],
    wrong: ["Not in your repertoire", `You prepared ${expected}. Play it to continue.`, "red"],
    finished: ["Session complete", `${r.total} positions reviewed, ${r.misses} missed.`, "green"],
    idle: ["Ready", "", undefined],
  }[r.status] as [string, string, string | undefined];
  const opening = node ? openingFor(tree, node) : undefined;

  return (
    <div className="page">
      <div className="boardcol">
        <div className={"boardrow" + (shake ? " shake" : "")} key={shake}>
          <Board fen={fen} orientation={r.color} lastMove={r.status === "correct" ? r.answerMove : node?.lastMove}
            movable={r.status === "asking" || r.status === "wrong" ? r.color : undefined} onMove={(m) => r.attempt(m)} />
        </div>
      </div>
      <div className="sidecol">
        <Panel title="Session" right={<Text size="xs">{r.done} of {r.total}</Text>}>
          <Progress value={r.total ? (r.done / r.total) * 100 : 0} size="sm" />
        </Panel>
        <Panel>
          <Text fw={700} size="md" c={color}>{r.status === "correct" && <IconCheck size={16} style={{ verticalAlign: -3 }} />}{r.status === "wrong" && <IconX size={16} style={{ verticalAlign: -3 }} />} {title}</Text>
          <Text size="sm" c="dimmed">{detail}</Text>
          {opening && <Text size="xs" c="dimmed" mt={6}>{opening.name}</Text>}
        </Panel>
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12 }}>
          <Button fullWidth variant={r.status === "finished" ? "filled" : "default"} size="sm" onClick={() => r.stop()}>{r.status === "finished" ? "Done" : "End session"}</Button>
        </div>
      </div>
    </div>
  );
}
