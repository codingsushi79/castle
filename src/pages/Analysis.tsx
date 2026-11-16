import { ActionIcon, Button, Group, Menu, Progress, SegmentedControl, Select, Text, TextInput, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  IconCloud, IconCopy, IconCpu, IconFolderOpen, IconLayoutGrid, IconMinus, IconPlayerPauseFilled, IconPlayerPlayFilled,
  IconPlus, IconPrinter, IconLayoutColumns, IconGitBranch, IconChevronDown, IconChevronRight, IconBolt, IconShare2, IconShieldExclamation, IconTarget, IconX, IconClipboard, IconCrosshair, IconEraser, IconArrowUpRight, IconArrowDownRight, IconUsersGroup,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AutoArrow, Board } from "../components/Board";
import { EvalBar, EvalChart, MoveList, NavBar, Panel } from "../components/common";
import { paint, Placement, PlacementBar } from "../components/Placement";
import { ExplorerPanel, TablebasePanel } from "../components/Explorer";
import { consensus, useAnalysis } from "../lib/analysis";
import { Color, GameTree, GNode, moveFromUci, NAGS, sanLine, scoreText, splitPgn, tryPosition, variantName, winPercent } from "../lib/chess";
import { makeSan } from "chessops/san";
import { db } from "../lib/db";
import { available, launch, resolveEngine, useEngines } from "../lib/engines";
import { copyBoardImage, saveBoardImage, saveGameGif } from "../lib/export";
import { cloudEval, CloudEval } from "../lib/lichess";
import { openingFor, useOpenings } from "../lib/openings";
import { usePuzzles } from "../lib/puzzles";
import { useRepertoire } from "../lib/repertoire";
import { mistakePuzzles, Report, reviewGame, ReviewSummary, summarise, writeReport } from "../lib/review";
import { Sound } from "../lib/sound";
import { call, copyText, load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import { useAction } from "../lib/shortcuts";
import { addToStudy, myStudies, studyPgn, useLichess } from "../lib/lichess";
import { SplitPane } from "../components/SplitPane";
import { ComparePanel } from "../components/Compare";
import { Modal, Loader } from "@mantine/core";
import { Engine } from "../lib/uci";

const say = (message: string) => notifications.show({ message, autoClose: 1800 });

export function tabTitle(tree: GameTree): string {
  if (!tree.root.children.length) return tree.isStandardStart ? "New board" : variantName(tree.rules, tree.chess960) === "Standard" ? "Position" : variantName(tree.rules, tree.chess960);
  const clean = (v: string, d: string) => (!v || v === "?" ? d : v);
  const w = clean(tree.tag("White"), "White"), b = clean(tree.tag("Black"), "Black");
  return w === "White" && b === "Black" ? "Analysis" : `${w.split(",")[0]} – ${b.split(",")[0]}`;
}

export async function openPgnFile() {
  const path = await openDialog({ filters: [{ name: "PGN", extensions: ["pgn", "txt"] }] });
  if (typeof path !== "string") return;
  const text = await call<string>("read_text", { path });
  const games = splitPgn(text);
  if (games.length === 1) {
    const tree = GameTree.fromPgn(games[0]);
    if (tree) useApp.getState().openGame(tree);
  } else if (games.length > 1) {
    const r = await db.importText(text, "", true);
    say(`Imported ${r.added} games into the Library`);
    useApp.getState().go("library");
  }
}

export async function pasteGame() {
  const text = (await navigator.clipboard.readText().catch(() => "")).trim();
  if (!text) return;
  if (text.includes("/") && tryPosition(text)) return useApp.getState().openGame(new GameTree(text));
  const tree = GameTree.fromPgn(text);
  if (tree && tree.root.children.length) useApp.getState().openGame(tree);
  else say("The clipboard has no FEN or PGN");
}

export default function AnalysisPage() {
  const { tabs, active, selectTab, closeTab, newTab } = useApp();
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  const [split, setSplit] = useState<boolean>(load("analysisSplit", false));
  const [width, setWidth] = useState<number>(load("analysisSplitWidth", 460));
  useAction("analysis.split", () => setSplit((v) => { save("analysisSplit", !v); return !v; }));
  return (
    <>
      <div className="tabs">
        {tabs.map((t) => (
          <TabLabel key={t.id} tree={t.tree} on={t.id === tab.id} onSelect={() => selectTab(t.id)} onClose={() => closeTab(t.id)} />
        ))}
        <div className="tab add" onClick={() => newTab()}><IconPlus size={14} /></div>
        <span style={{ flex: 1 }} />
        <div className={"tab" + (split ? " on" : "")} onClick={() => { save("analysisSplit", !split); setSplit(!split); }} title="Split view  ⌘\\">
          <IconLayoutColumns size={14} /> Split
        </div>
      </div>
      {split ? (
        <div className="split">
          <div className="left"><AnalysisBoard key={tab.id} tree={tab.tree} compact /></div>
          <div className="handle" onMouseDown={(e) => {
            const start = e.clientX, w0 = width;
            const move = (ev: MouseEvent) => setWidth(Math.max(300, Math.min(window.innerWidth - 700, w0 - (ev.clientX - start))));
            const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); setWidth((w) => { save("analysisSplitWidth", w); return w; }); };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }} />
          <div className="right" style={{ width }}><SplitPane main={tab.tree} /></div>
        </div>
      ) : (
        <AnalysisBoard key={tab.id} tree={tab.tree} />
      )}
    </>
  );
}

function TabLabel({ tree, on, onSelect, onClose }: { tree: GameTree; on: boolean; onSelect: () => void; onClose: () => void }) {
  useTree(tree);
  return (
    <div className={"tab" + (on ? " on" : "")} onClick={onSelect}>
      <IconLayoutGrid size={13} />
      {tabTitle(tree)}
      <span className="x" onClick={(e) => { e.stopPropagation(); onClose(); }}><IconX size={12} /></span>
    </div>
  );
}

function AnalysisBoard({ tree, compact }: { tree: GameTree; compact?: boolean }) {
  const revision = useTree(tree);
  const app = useApp();
  useOpenings((s) => s.loaded);
  const a = useAnalysis(tree, revision);
  const [flipped, setFlipped] = useState(false);
  const [side, setSide] = useState<string>(load("analysisSide", "moves"));
  const [placing, setPlacing] = useState<Placement>();
  const erasing = useRef(false);
  const [menu, setMenu] = useState<{ node: GNode; x: number; y: number }>();
  const [review, setReview] = useState<{ running: boolean; progress: number; summary?: ReviewSummary; report?: Report }>(() => {
    const summary = tree.mainline.some((n) => n.eval) ? summarise(tree) : undefined;
    return { running: false, progress: 0, summary };
  });
  const [cloud, setCloud] = useState<CloudEval>();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pinned, setPinned] = useState<GNode>();
  const [study, setStudy] = useState<"import" | "export">();
  const node = tree.current;
  const orientation: Color = flipped ? "black" : "white";

  useAction("board.back", () => tree.back());
  useAction("board.forward", () => tree.forward());
  useAction("board.start", () => tree.toStart());
  useAction("board.end", () => tree.toEnd());
  useAction("board.flip", () => setFlipped((f) => !f));
  useAction("board.clearDrawings", () => { if (tree.current.shapes.length) { tree.current.shapes = []; tree.touch(); } });
  useAction("engine.toggle", () => a.setRunning(!a.running));
  useAction("engine.threat", () => { if (!a.running) a.setRunning(true); a.setThreat(!a.threat); });
  useAction("analysis.review", () => !review.running && startReview());

  // Lichess's stored evaluation fills in while the local engine is off or warming up.
  useEffect(() => {
    setCloud(undefined);
    if (tree.rules !== "chess" || !load("cloudEval", true)) return;
    let live = true;
    const t = setTimeout(() => cloudEval(node.fen).then((c) => live && setCloud(c)), 350);
    return () => { live = false; clearTimeout(t); };
  }, [node.fen, tree.rules]);

  // With two or more engines running, their lines are pooled into one ranking.
  const together = useMemo(
    () => (a.running && !a.threat && a.slots.length > 1 ? consensus(node.fen, tree.rules, a.slots, a.lines) : []),
    [a.running, a.threat, a.slots, a.lines, node.fen, tree.rules],
  );

  // Every line gets an arrow of the same width; the best is the most solid and
  // the weakest of the lines shown the faintest.
  const arrows: AutoArrow[] = useMemo(() => {
    const src = a.running
      ? (together.length ? together.map((m) => m.first) : a.primary.map((l) => l.first)).slice(0, a.threat ? 1 : a.multipv)
      : cloud ? cloud.pvs.map((p) => p.moves[0]) : [];
    const moves = [...new Set(src.filter(Boolean))];
    const n = moves.length;
    return moves.map((u, i) => ({
      from: u.slice(0, 2), to: u.slice(2, 4),
      color: a.threat ? "red" : "paleBlue",
      strength: 0.7,
      opacity: n > 1 ? 0.9 - (0.7 * i) / (n - 1) : 0.9,
    }));
  }, [a.running, a.primary, a.threat, a.multipv, together, cloud]);

  const opening = openingFor(tree);

  const startReview = async () => {
    const entry = resolveEngine(a.slots[0].engineId);
    if (!entry || !tree.mainline.length) return;
    let cancelled = false;
    setReview({ running: true, progress: 0 });
    cancelReview = () => { cancelled = true; };
    let engine: Engine | undefined;
    try {
      engine = await launch(entry);
      const ok = await reviewGame(tree, engine, 350, (d, t) => setReview((r) => ({ ...r, progress: (d / t) * 100 })), () => cancelled);
      const summary = ok ? summarise(tree) : undefined;
      setReview({ running: false, progress: 100, summary, report: summary ? writeReport(tree, summary) : undefined });
      tree.touch();
      if (summary) setSide("report");
    } catch (e: any) {
      say(String(e.message ?? e));
      setReview({ running: false, progress: 0 });
    } finally {
      engine?.quit();
    }
  };

  const mistakes = review.summary ? mistakePuzzles(tree) : [];
  const report = review.report ?? (review.summary ? writeReport(tree, review.summary, undefined, false) : undefined);

  return (
    <div className="page">
      <div className="boardcol">
        <div className="toolbar" style={{ margin: "-14px -16px 6px", borderBottom: "1px solid var(--border)" }}>
          <Tooltip label="Place pieces: set up any position"><ActionIcon variant={placing ? "filled" : "subtle"} color={placing ? undefined : "gray"} onClick={() => setPlacing(placing ? undefined : { board: node.fen.split(" ")[0], turn: node.turn, tool: "move" })}><IconLayoutGrid size={17} /></ActionIcon></Tooltip>
          <Tooltip label="Open a PGN file"><ActionIcon variant="subtle" color="gray" onClick={openPgnFile}><IconFolderOpen size={17} /></ActionIcon></Tooltip>
          <Tooltip label="Paste a FEN or PGN"><ActionIcon variant="subtle" color="gray" onClick={pasteGame}><IconClipboard size={17} /></ActionIcon></Tooltip>
          <Menu shadow="md" position="bottom-start">
            <Menu.Target><Button variant="subtle" color="gray" leftSection={<IconCrosshair size={15} />}>Position</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item onClick={() => app.go("library", { kind: "position", payload: tree.fen })}>Find in Library</Menu.Item>
              <Menu.Item disabled={tree.rules !== "chess"} onClick={() => app.go("library", { kind: "similar", payload: { fen: tree.fen, mode: "pawns" } })}>Games with this pawn structure</Menu.Item>
              <Menu.Item disabled={tree.rules !== "chess"} onClick={() => app.go("library", { kind: "similar", payload: { fen: tree.fen, mode: "material" } })}>Games with the same material</Menu.Item>
              <Menu.Item onClick={() => { setPinned(node); setSide("compare"); save("analysisSide", "compare"); }}>Pin for comparison</Menu.Item>
              <Menu.Item onClick={() => app.go("play", { kind: "playFrom", payload: { fen: tree.fen, rules: tree.rules } })}>Play from here</Menu.Item>
              <Menu.Item onClick={() => app.go("training", { kind: "guess", payload: tree })} disabled={tree.mainline.length < 10}>Guess the moves of this game</Menu.Item>
              <Menu.Divider />
              <Menu.Item disabled={!tree.isStandardStart} onClick={() => { useRepertoire.getState().importTree(tree, "white"); say("Added to the White repertoire"); }}>Add lines to White repertoire</Menu.Item>
              <Menu.Item disabled={!tree.isStandardStart} onClick={() => { useRepertoire.getState().importTree(tree, "black"); say("Added to the Black repertoire"); }}>Add lines to Black repertoire</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <Menu shadow="md" position="bottom-start">
            <Menu.Target><Button variant="subtle" color="gray" leftSection={<IconShare2 size={15} />}>Share</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => { copyText(tree.fen); say("FEN copied"); }}>Copy FEN</Menu.Item>
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => { copyText(tree.toPgn()); say("PGN copied"); }}>Copy PGN</Menu.Item>
              <Menu.Item onClick={() => copyBoardImage(node.fen, orientation, node.lastMove).then(() => say("Board image copied")).catch(() => say("Could not copy the image"))}>Copy board image</Menu.Item>
              <Menu.Divider />
              <Menu.Item onClick={() => saveBoardImage(node.fen, orientation, node.lastMove)}>Save board image…</Menu.Item>
              <Menu.Item disabled={!tree.mainline.length} onClick={() => saveGameGif(tree, orientation).then((ok) => ok && say("GIF saved"))}>Save game as GIF…</Menu.Item>
              <Menu.Item onClick={async () => {
                const path = await saveDialog({ defaultPath: `${tree.tag("White", "White")} vs ${tree.tag("Black", "Black")}.pgn`, filters: [{ name: "PGN", extensions: ["pgn"] }] });
                if (path) await call("write_text", { path, text: tree.toPgn() });
              }}>Save PGN…</Menu.Item>
              <Menu.Item onClick={() => db.importText(tree.toPgn(), "", false).then(() => say("Added to the Library"))}>Add to Library</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconBolt size={14} />} onClick={() => setStudy("import")}>Open a Lichess study…</Menu.Item>
              <Menu.Item leftSection={<IconBolt size={14} />} disabled={!tree.root.children.length} onClick={() => setStudy("export")}>Add to a Lichess study…</Menu.Item>
              <Menu.Item leftSection={<IconPrinter size={14} />} disabled={!tree.mainline.length} onClick={() => printScoresheet(tree)}>Print scoresheet…</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          <span style={{ flex: 1 }} />
          <Text size="xs" c="dimmed" truncate>{opening ? `${opening.eco} ${opening.name}` : tree.tag("Opening") || (node.parent ? "" : variantName(tree.rules, tree.chess960))}</Text>
        </div>
        <div className="boardrow">
          <EvalBar score={a.score ?? cloud?.pvs[0]?.score} flipped={flipped} />
          {placing ? (
            <Board fen={`${placing.board} ${placing.turn === "white" ? "w" : "b"} - - 0 1`} orientation={orientation} free
              onPlacement={(board) => setPlacing((p) => p && { ...p, board })}
              onPaint={placing.tool === "move" ? undefined : (square, start) => setPlacing((p) => {
                if (!p) return p;
                const r = paint(p, square, start, erasing.current);
                erasing.current = r.erasing;
                return { ...p, board: r.board };
              })} />
          ) : (
            <Board fen={node.fen} rules={tree.rules} chess960={tree.chess960} orientation={orientation} movable="both" lastMove={node.lastMove}
              shapes={node.shapes} arrows={arrows}
              onShapes={(shapes) => { node.shapes = shapes; tree.revision++; }}
              onMove={(m) => { const n = tree.play(m); if (n) Sound.forSan(n.san); }} />
          )}
        </div>
        {placing ? (
          <PlacementBar p={placing} onChange={setPlacing} onCancel={() => setPlacing(undefined)} onDone={(fen) => {
            setPlacing(undefined);
            const fresh = new GameTree(fen);
            // An empty board is replaced in place; a tab with moves keeps its game and the position opens beside it.
            if (!tree.root.children.length) {
              useApp.setState((s) => ({ tabs: s.tabs.map((t) => (t.tree === tree ? { id: fresh.id, tree: fresh } : t)), active: fresh.id }));
            } else app.openGame(fresh);
          }} />
        ) : (
        <Group gap={8} justify="center">
          <NavBar tree={tree} onFlip={() => setFlipped(!flipped)} />
          <Button variant={a.threat ? "filled" : "default"} color="red" leftSection={<IconShieldExclamation size={14} />} onClick={() => { if (!a.running) a.setRunning(true); a.setThreat(!a.threat); }}>Threat</Button>
          {node.shapes.length > 0 && <Tooltip label="Shortcut: C"><Button variant="default" leftSection={<IconEraser size={14} />} onClick={() => { node.shapes = []; tree.touch(); }}>Clear drawings</Button></Tooltip>}
        </Group>
        )}
      </div>

      <div className="sidecol" style={compact ? { width: 330 } : undefined}>
        <Panel
          title={<><IconCpu size={13} /> {a.slots.length > 1 ? `${a.slots.length} engines` : "Engine"}</>}
          right={
            <Group gap={4}>
              {(a.score ?? cloud?.pvs[0]?.score) && <Text fw={800} size="md" ff="ui-rounded, system-ui">{scoreText((a.score ?? cloud!.pvs[0].score)!)}</Text>}
              <EngineMenu a={a} />
              <ActionIcon variant="filled" color={a.running ? "orange" : undefined} radius="xl" onClick={() => a.setRunning(!a.running)}>
                {a.running ? <IconPlayerPauseFilled size={14} /> : <IconPlayerPlayFilled size={14} />}
              </ActionIcon>
            </Group>
          }>
          {a.error && <Text size="xs" c="red">{a.error}</Text>}
          {a.threat && a.running && <Text size="xs" c="red" fw={600} mb={4}>{a.threatBlocked ? "No threat to show while in check" : "Showing the opponent's threat"}</Text>}
          {together.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div className="row" style={{ marginBottom: 2 }}>
                <Text size="xs" fw={700}><IconUsersGroup size={12} style={{ verticalAlign: -2 }} /> Consensus</Text>
                <Text size="xs" c="dimmed">{a.slots.length} engines pooled</Text>
              </div>
              {together.slice(0, a.multipv).map((m) => (
                <div key={m.first} className="pvline" onClick={() => tree.play(m.first)} title="Play this move">
                  <span className={"score " + (winPercent(m.score) >= 50 ? "w" : "b")}>{scoreText(m.score)}</span>
                  <span className="san"><b>{m.san}</b> <span style={{ opacity: 0.6 }}>{m.backers}/{a.slots.length} engines</span></span>
                  {Math.abs(m.shift) >= 0.5 && (
                    <Tooltip label={`${m.shift > 0 ? "Better" : "Worse"} than ${a.slots[0].name} alone thought, in winning chances`}>
                      <Text size="xs" fw={700} c={m.shift > 0 ? "teal" : "red"} style={{ flex: "none" }}>
                        {m.shift > 0 ? <IconArrowUpRight size={12} /> : <IconArrowDownRight size={12} />}{Math.abs(m.shift).toFixed(0)}%
                      </Text>
                    </Tooltip>
                  )}
                </div>
              ))}
            </div>
          )}
          {a.running ? a.slots.map((slot) => {
            const ls = a.lines[slot.key] ?? [];
            const best = ls[0];
            return (
              <div key={slot.key} style={{ marginBottom: 6 }}>
                <div className="row" style={{ marginBottom: 2 }}>
                  <Text size="xs" fw={700} truncate>{slot.name}</Text>
                  <Text size="xs" c="dimmed">{best ? `depth ${best.depth} · ${best.nps >= 1e6 ? (best.nps / 1e6).toFixed(1) + " Mn/s" : Math.round(best.nps / 1000) + " kn/s"}` : "starting…"}</Text>
                  <span style={{ flex: 1 }} />
                  {a.slots.length > 1 && <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => a.removeSlot(slot.key)}><IconMinus size={12} /></ActionIcon>}
                </div>
                {ls.map((l) => {
                  const key = `${slot.key}-${l.rank}`;
                  const open = expanded.has(key);
                  return (
                    <div key={l.rank} className={"pvline" + (open ? "" : " collapsed")}>
                      <span className={"score " + (winPercent(l.score) >= 50 ? "w" : "b")} onClick={() => !a.threat && tree.play(l.first)} title="Play the first move">{scoreText(l.score)}</span>
                      <span className="san">
                        {a.threat ? l.san : pvTokens(node.fen, l.pv, tree.rules, open ? 40 : 14).map((t, i) => t.number
                          ? <span key={i} style={{ opacity: 0.6 }}>{t.label} </span>
                          : <span key={i} className="pvtoken" title="Play the line up to here" onClick={() => playLine(tree, l.pv.slice(0, t.ply))}>{t.label} </span>)}
                      </span>
                      {!a.threat && (
                        <>
                          <Tooltip label={open ? "Collapse" : "Show the whole line"}><ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setExpanded((x) => { const n = new Set(x); n.has(key) ? n.delete(key) : n.add(key); return n; })}>{open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</ActionIcon></Tooltip>
                          <Tooltip label="Add the line as a variation"><ActionIcon size="xs" variant="subtle" color="gray" onClick={() => { addLine(tree, node, l.pv); say("Line added as a variation"); }}><IconGitBranch size={12} /></ActionIcon></Tooltip>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          }) : cloud ? (
            <>
              <Text size="xs" c="dimmed" mb={2}><IconCloud size={12} style={{ verticalAlign: -2 }} /> Lichess cloud, depth {cloud.depth}</Text>
              {cloud.pvs.map((p, i) => (
                <div key={i} className="pvline" onClick={() => tree.play(p.moves[0])}>
                  <span className={"score " + (winPercent(p.score) >= 50 ? "w" : "b")}>{scoreText(p.score)}</span>
                  <span className="san">{sanLine(node.fen, p.moves, tree.rules)}</span>
                </div>
              ))}
            </>
          ) : (
            <Text size="xs" c="dimmed">Engine off. Press play or the space bar.</Text>
          )}
        </Panel>

        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
          <SegmentedControl fullWidth value={side} onChange={(v) => { setSide(v); save("analysisSide", v); }}
            data={[{ value: "moves", label: "Moves" }, { value: "explorer", label: "Explorer" }, { value: "tablebase", label: "Tables" }, { value: "compare", label: "Compare" }, { value: "report", label: "Report" }]} />
        </div>

        {side === "moves" && (
          <>
            <Panel grow pad={false}>
              <MoveList tree={tree} onContext={(n, e) => setMenu({ node: n, x: e.clientX, y: e.clientY })} />
            </Panel>
            <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)", gap: 4 }}>
              {[3, 1, 5, 6, 2, 4].map((nag) => (
                <Button key={nag} px={7} variant={node.nag === nag ? "filled" : "default"} disabled={!node.parent} onClick={() => { node.nag = node.nag === nag ? undefined : nag; tree.touch(); }}>{NAGS[nag]}</Button>
              ))}
              <TextInput key={node.id} style={{ flex: 1 }} placeholder="Comment on this move" defaultValue={node.comment} onChange={(e) => { node.comment = e.currentTarget.value; tree.touch(); }} />
            </div>
          </>
        )}
        {side === "explorer" && <Panel grow pad={false}><ExplorerPanel tree={tree} /></Panel>}
        {side === "tablebase" && <Panel grow pad={false}><TablebasePanel tree={tree} /></Panel>}
        {side === "compare" && <Panel grow><ComparePanel tree={tree} pinned={pinned} onPin={setPinned} slots={a.slots} lines={a.lines} running={a.running} /></Panel>}
        {side === "report" && (
          <Panel grow>
            {report ? (
              <div className="selectable">
                <Text fw={700} size="md" mb={6}>{report.headline}</Text>
                {report.paragraphs.map((p, i) => <Text key={i} size="sm" mb={8}>{p}</Text>)}
                {report.keyMoments.length > 0 && <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt={10} mb={4}>Key moments</Text>}
                {report.keyMoments.map((k, i) => (
                  <div key={i} className="listrow" style={{ padding: "5px 4px", whiteSpace: "normal" }} onClick={() => tree.go(k.node)}>
                    <Text size="sm">{k.text}</Text>
                  </div>
                ))}
                {report.patterns.length > 0 && <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt={12} mb={4}>Across your games</Text>}
                {report.patterns.map((p, i) => <Text key={i} size="sm" mb={4}>{p}</Text>)}
              </div>
            ) : (
              <Text size="sm" c="dimmed">Review the game to get a written report: where it turned, the key mistakes with the better move, and the errors that repeat across your games.</Text>
            )}
          </Panel>
        )}

        <Panel title={<><IconTarget size={13} /> Game review</>}
          right={review.running ? <Button variant="default" onClick={() => cancelReview()}>Stop</Button> : <Button variant="light" disabled={!tree.mainline.length} onClick={startReview}>{review.summary ? "Again" : "Review"}</Button>}>
          {review.running && <Progress value={review.progress} size="sm" animated />}
          {review.summary && !review.running && (
            <>
              <Group grow gap={8} mb={8}>
                {(["white", "black"] as Color[]).map((c) => (
                  <div key={c}>
                    <div className="row"><span className={"dot " + c} /><Text fw={800} size="lg" ff="ui-rounded, system-ui">{review.summary!.accuracy[c]?.toFixed(1) ?? "–"}%</Text></div>
                    <Text size="xs"><span style={{ color: "#e0b83c" }}>{review.summary!.inaccuracies[c]} ?!</span>{"  "}<span style={{ color: "#ffa94d" }}>{review.summary!.mistakes[c]} ?</span>{"  "}<span style={{ color: "#ff6b6b" }}>{review.summary!.blunders[c]} ??</span></Text>
                  </div>
                ))}
              </Group>
              <EvalChart tree={tree} />
              {mistakes.length > 0 && (
                <Button fullWidth mt={8} variant="default" leftSection={<IconTarget size={14} />} onClick={() => { usePuzzles.getState().addMistakes(mistakes); usePuzzles.getState().setMode("mistakes"); app.go("puzzles"); }}>
                  Train {mistakes.length} mistake{mistakes.length === 1 ? "" : "s"}
                </Button>
              )}
            </>
          )}
          {!review.summary && !review.running && <Text size="xs" c="dimmed">Grades every move, finds blunders, draws the evaluation graph and writes a report.</Text>}
        </Panel>
      </div>

      <Menu opened={!!menu} onChange={(o) => !o && setMenu(undefined)} position="bottom-start">
        <Menu.Target><div style={{ position: "fixed", left: menu?.x ?? 0, top: menu?.y ?? 0 }} /></Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={() => menu && tree.promote(menu.node)}>Promote variation</Menu.Item>
          <Menu.Item color="red" onClick={() => menu && tree.delete(menu.node)}>Delete from here</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      {study && <StudyModal mode={study} tree={tree} onClose={() => setStudy(undefined)} />}
    </div>
  );
}

let cancelReview = () => {};

function EngineMenu({ a }: { a: ReturnType<typeof useAnalysis> }) {
  useEngines((s) => s.engines);
  const go = useApp((s) => s.go);
  const list = available();
  return (
    <Menu shadow="md" position="bottom-end" closeOnItemClick={false}>
      <Menu.Target><Button variant="subtle" color="gray" px={6}>{a.slots[0].name}</Button></Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Engine</Menu.Label>
        {list.map((e) => (
          <Menu.Item key={e.id} onClick={() => a.setEngine(a.slots[0].key, e.id)} rightSection={a.slots[0].engineId === e.id ? "✓" : undefined}>{e.name}</Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Label>Lines</Menu.Label>
        <div style={{ padding: "0 8px 6px" }}>
          <SegmentedControl fullWidth value={String(a.multipv)} onChange={(v) => a.setMultipv(parseInt(v, 10))} data={["1", "2", "3", "4", "5"]} />
        </div>
        <Menu.Divider />
        <Menu.Label>Add another engine</Menu.Label>
        {list.map((e) => <Menu.Item key={e.id} disabled={a.slots.length >= 4} onClick={() => a.addEngine(e.id)}>{e.name}</Menu.Item>)}
        <Menu.Divider />
        <Menu.Item onClick={() => go("engines")}>Manage engines…</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

/** Lays the game out as a paper scoresheet and opens the print dialog. */
export function printScoresheet(tree: GameTree) {
  const el = document.getElementById("print-area");
  if (!el) return;
  const moves = tree.mainline;
  const rows: string[] = [];
  const half = Math.ceil(Math.ceil(moves.length / 2) / 2);
  const cell = (i: number) => {
    const w = moves[i * 2], b = moves[i * 2 + 1];
    return w ? `<td class="n">${i + 1}</td><td>${w.san}${w.nag ? NAGS[w.nag] : ""}</td><td>${b ? b.san + (b.nag ? NAGS[b.nag] : "") : ""}</td>` : "<td class='n'></td><td></td><td></td>";
  };
  for (let i = 0; i < Math.max(half, 1); i++) rows.push(`<tr>${cell(i)}${cell(i + half)}</tr>`);
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
  el.innerHTML = `<h1>${esc(tree.tag("White", "White"))} – ${esc(tree.tag("Black", "Black"))}</h1>
    <div>${esc([tree.tag("Event"), tree.tag("Site"), tree.tag("Date"), tree.result].filter(Boolean).join(" · "))}</div>
    <table>${rows.join("")}</table>`;
  call("print_page").catch(() => window.print());
}

/** SAN tokens for an engine line, each knowing how many moves of the line it ends. */
function pvTokens(fen: string, pv: string[], rules: GameTree["rules"], limit: number): { label: string; ply: number; number?: boolean }[] {
  const pos = tryPosition(fen, rules)?.clone();
  if (!pos) return [];
  const out: { label: string; ply: number; number?: boolean }[] = [];
  for (let i = 0; i < Math.min(limit, pv.length); i++) {
    const m = moveFromUci(pos, pv[i]);
    if (!m) break;
    if (pos.turn === "white") out.push({ label: `${pos.fullmoves}.`, ply: i, number: true });
    else if (i === 0) out.push({ label: `${pos.fullmoves}…`, ply: i, number: true });
    out.push({ label: makeSan(pos, m), ply: i + 1 });
    pos.play(m);
  }
  return out;
}

/** Plays the moves of a line from the current position and goes to its end. */
function playLine(tree: GameTree, ucis: string[]) {
  let node = tree.current;
  for (const u of ucis) {
    const m = moveFromUci(tree.posAt(node), u);
    const next = m && tree.append(node, m);
    if (!next) break;
    node = next;
  }
  tree.go(node);
  tree.touch();
}

/** Stores a whole engine line as a variation without leaving the current move. */
function addLine(tree: GameTree, from: GNode, ucis: string[]) {
  let node = from;
  for (const u of ucis) {
    const m = moveFromUci(tree.posAt(node), u);
    const next = m && tree.append(node, m);
    if (!next) break;
    node = next;
  }
  tree.touch();
}

function StudyModal({ mode, tree, onClose }: { mode: "import" | "export"; tree: GameTree; onClose: () => void }) {
  const app = useApp();
  const lichess = useLichess();
  const [link, setLink] = useState("");
  const [studies, setStudies] = useState<{ id: string; name: string }[]>();
  const [target, setTarget] = useState<string>();
  const [name, setName] = useState(tabTitle(tree));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (mode === "export" && lichess.username) myStudies(lichess.username).then(setStudies).catch((e) => setError(e.message));
  }, [mode, lichess.username]);
  const doImport = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const games = splitPgn(await studyPgn(link));
      if (!games.length) throw new Error("The study has no chapters.");
      games.slice(0, 16).forEach((g, i) => {
        const t = GameTree.fromPgn(g);
        if (!t) return;
        t.toStart();
        if (i === 0) app.openGame(t); else app.newTab(t);
      });
      if (games.length > 16) await db.importText(games.join("\n\n"), "Lichess studies", true);
      say(games.length > 16 ? `Opened 16 chapters; all ${games.length} saved to the Library` : `Opened ${games.length} chapter${games.length === 1 ? "" : "s"}`);
      onClose();
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };
  const doExport = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await addToStudy(target, tree.toPgn(), name || "Castle");
      say("Added to the study");
      onClose();
    } catch (e: any) {
      setError(e.message.includes("authorised") ? "Your Lichess token needs the study permissions. Sign out and create a new token from the Lichess page." : e.message);
    }
    setBusy(false);
  };
  return (
    <Modal opened onClose={onClose} title={<Text fw={700}>{mode === "import" ? "Open a Lichess study" : "Add to a Lichess study"}</Text>}>
      {mode === "import" ? (
        <>
          <TextInput placeholder="https://lichess.org/study/…" value={link} onChange={(e) => setLink(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && doImport()} data-autofocus />
          <Text size="xs" c="dimmed" mt={6}>Each chapter opens in its own tab, with comments, arrows and variations. Private studies need you to be signed in on the Lichess page.</Text>
          <Group justify="flex-end" mt="md"><Button loading={busy} disabled={!link.trim()} onClick={doImport}>Open</Button></Group>
        </>
      ) : lichess.state !== "online" ? (
        <Text size="sm">Sign in on the Lichess page first.</Text>
      ) : (
        <>
          {!studies ? <Loader size="sm" /> : studies.length ? (
            <Select label="Study" placeholder="Choose one of your studies" data={studies.map((s) => ({ value: s.id, label: s.name }))} value={target ?? null} onChange={(v) => setTarget(v ?? undefined)} searchable />
          ) : <Text size="sm">You have no studies yet. Create one on lichess.org first.</Text>}
          <TextInput mt="sm" label="Chapter name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Text size="xs" c="dimmed" mt={6}>Moves, variations, comments, move marks and drawn arrows are all kept.</Text>
          <Group justify="flex-end" mt="md"><Button loading={busy} disabled={!target} onClick={doExport}>Add chapter</Button></Group>
        </>
      )}
      {error && <Text size="sm" c="red" mt="sm">{error}</Text>}
    </Modal>
  );
}
