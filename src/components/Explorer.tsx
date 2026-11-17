import { Button, SegmentedControl, Text } from "@mantine/core";
import { IconBolt, IconCrown, IconEqual, IconShieldX } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { GameTree, pieceCount } from "../lib/chess";
import { ExplorerMove } from "../lib/db";
import { explorer, ExplorerSource, lichessToken, tablebase, Tablebase, verdictText } from "../lib/lichess";
import { Sound } from "../lib/sound";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import { Empty, ResultBar } from "./common";

export const compact = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e4 ? Math.round(n / 1e3) + "k" : String(n));

export function ExplorerRows({ moves, onPlay }: { moves: ExplorerMove[]; onPlay: (san: string) => void }) {
  return (
    <>
      {moves.map((m) => (
        <div key={m.san} className="listrow" onClick={() => onPlay(m.san)}>
          <Text fw={700} w={52} ff="ui-rounded, system-ui">{m.san}</Text>
          <Text size="xs" c="dimmed" w={42} ta="right">{compact(m.white + m.draws + m.black)}</Text>
          <ResultBar white={m.white} draws={m.draws} black={m.black} />
        </div>
      ))}
    </>
  );
}

/** What was played from the position on the board, in the library or on Lichess. */
export function ExplorerPanel({ tree }: { tree: GameTree }) {
  useTree(tree);
  const go = useApp((s) => s.go);
  const libraryRevision = useApp((s) => s.libraryRevision);
  const [source, setSource] = useState<ExplorerSource>(load("explorerSource", "library"));
  const [moves, setMoves] = useState<ExplorerMove[]>();
  const [error, setError] = useState<string>();
  const [needsToken, setNeedsToken] = useState(false);
  const fen = tree.fen;

  useEffect(() => {
    let live = true;
    setError(undefined);
    const timer = setTimeout(async () => {
      if ((source === "lichess" || source === "masters") && !(await lichessToken())) {
        if (live) { setNeedsToken(true); setMoves([]); }
        return;
      }
      setNeedsToken(false);
      explorer(source, fen)
        .then((m) => live && setMoves(m))
        .catch((e) => live && (setError(e.message), setMoves([])));
    }, source === "library" ? 0 : 250);
    return () => { live = false; clearTimeout(timer); };
  }, [fen, source, libraryRevision]);

  const play = (san: string) => {
    const node = tree.playSan(san);
    if (node) Sound.forSan(node.san);
  };
  const total = (moves ?? []).reduce((a, m) => a + m.white + m.draws + m.black, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "8px 12px" }}>
        <SegmentedControl fullWidth value={source} onChange={(v) => { setSource(v as ExplorerSource); save("explorerSource", v); }}
          data={[{ value: "library", label: "Library" }, { value: "castle", label: "Castle Online" }, { value: "lichess", label: "Lichess" }, { value: "masters", label: "Masters" }]} />
      </div>
      <div style={{ flex: 1, overflowY: "auto" }}>
        {tree.rules !== "chess" ? (
          <Empty title="Standard chess only">The explorer does not cover variants.</Empty>
        ) : needsToken ? (
          <Empty icon={<IconBolt size={28} />} title="Sign in to Lichess">
            The Lichess and Masters explorers need a Lichess account.
            <div><Button mt="sm" variant="light" onClick={() => go("lichess")}>Open the Lichess page</Button></div>
          </Empty>
        ) : error ? (
          <Empty title="Explorer unavailable">{error}</Empty>
        ) : !moves ? null : moves.length ? (
          <ExplorerRows moves={moves} onPlay={play} />
        ) : (
          <Empty title="No games here">{source === "library" ? "No game in your library reached this position." : source === "castle" ? "No Castle Online game has reached this position yet." : "This position has not been played."}</Empty>
        )}
      </div>
      {source === "library" && total > 0 && (
        <div style={{ padding: 8 }}>
          <Button fullWidth variant="light" onClick={() => go("library", { kind: "position", payload: fen })}>Show games with this position</Button>
        </div>
      )}
    </div>
  );
}

const tint = (v: string) => (v.includes("win") ? "#51cf66" : v.includes("loss") ? "#ff6b6b" : "#aaa");

/** Perfect play from the endgame tablebases, for seven pieces or fewer. */
export function TablebasePanel({ tree }: { tree: GameTree }) {
  useTree(tree);
  const [data, setData] = useState<Tablebase>();
  const [error, setError] = useState<string>();
  const fen = tree.fen;
  const pieces = pieceCount(fen);
  const supported = tree.rules === "chess" || tree.rules === "atomic" || tree.rules === "antichess";

  useEffect(() => {
    if (pieces > 7 || !supported) return;
    let live = true;
    setError(undefined);
    const t = setTimeout(() => {
      tablebase(fen, tree.rules === "chess" ? "standard" : tree.rules)
        .then((d) => live && setData(d))
        .catch((e) => live && setError(e.message));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [fen, pieces, supported, tree.rules]);

  if (!supported) return <Empty title="No tablebase">There is no tablebase for this variant.</Empty>;
  if (pieces > 7) return <Empty title="Too many pieces">Tablebases cover positions with seven pieces or fewer. This one has {pieces}.</Empty>;
  if (error) return <Empty title="Tablebase unavailable">{error}</Empty>;
  if (!data) return null;
  const Icon = data.verdict.includes("win") ? IconCrown : data.verdict.includes("loss") ? IconShieldX : IconEqual;
  return (
    <div>
      <div className="row" style={{ padding: "10px 12px", color: tint(data.verdict) }}>
        <Icon size={18} />
        <Text fw={700}>{verdictText(data.verdict)}</Text>
        <span style={{ flex: 1 }} />
        {data.dtm != null && <Text size="xs" c="dimmed">Mate in {Math.ceil(Math.abs(data.dtm) / 2)}</Text>}
      </div>
      {data.moves.map((m) => (
        <div key={m.uci} className="listrow" onClick={() => tree.play(m.uci)}>
          <Text fw={700} w={60} ff="ui-rounded, system-ui">{m.san}</Text>
          <Text size="xs" fw={600} style={{ color: tint(m.verdict), flex: 1 }}>{verdictText(m.verdict).split(",")[0]}</Text>
          {m.dtz != null && <Text size="xs" c="dimmed">DTZ {Math.abs(m.dtz)}</Text>}
          {m.dtm != null && <Text size="xs" c="dimmed" w={58} ta="right">DTM {Math.abs(m.dtm)}</Text>}
        </div>
      ))}
    </div>
  );
}
