import { Button, Group, SegmentedControl, Switch, Text } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { Board } from "../components/Board";
import { Empty, EvalBar, MoveList, NavBar, Panel, PlayerStrip } from "../components/common";
import { Color, GameTree, negate, sanLine, Score, scoreText, splitPgn, turnOf } from "../lib/chess";
import { launch, resolveEngine } from "../lib/engines";
import { api, getJson, ndjson } from "../lib/lichess";
import { clockText, load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import { Engine } from "../lib/uci";

/** Evaluates whatever position is being watched with the default engine. */
function useSpectatorEngine(fen: string | undefined, enabled: boolean) {
  const [score, setScore] = useState<Score>();
  const [line, setLine] = useState("");
  const engine = useRef<Engine>();
  const starting = useRef<Promise<Engine>>();
  useEffect(() => {
    setScore(undefined);
    setLine("");
    if (!enabled || !fen) { engine.current?.stop(); return; }
    let live = true;
    const entry = resolveEngine();
    if (!entry) return;
    starting.current ??= launch(entry).then((e) => (engine.current = e));
    starting.current.then((e) => {
      if (!live) return;
      const white = turnOf(fen) === "white";
      e.search({ position: `position fen ${fen}`, go: "go movetime 4000", onInfo: (i) => { if (live && i.multipv === 1) { setScore(white ? i.score : negate(i.score)); setLine(`depth ${i.depth}  ${sanLine(fen, i.pv, "chess", 8)}`); } } });
    }).catch(() => {});
    return () => { live = false; };
  }, [fen, enabled]);
  useEffect(() => () => { engine.current?.quit(); starting.current?.then((e) => e.quit()).catch(() => {}); }, []);
  return { score, line };
}

export default function WatchPage() {
  const [tab, setTab] = useState<string>(load("watchTab", "tv"));
  const [evalOn, setEvalOn] = useState<boolean>(load("watchEval", true));
  return (
    <>
      <div className="toolbar">
        <SegmentedControl value={tab} onChange={(v) => { setTab(v); save("watchTab", v); }} data={[{ value: "tv", label: "Lichess TV" }, { value: "broadcasts", label: "Broadcasts" }]} />
        <span style={{ flex: 1 }} />
        <Switch label="Engine evaluation" checked={evalOn} onChange={(e) => { setEvalOn(e.currentTarget.checked); save("watchEval", e.currentTarget.checked); }} />
      </div>
      {tab === "tv" ? <Tv evalOn={evalOn} /> : <Broadcasts evalOn={evalOn} />}
    </>
  );
}

const CHANNELS = ["best", "bullet", "blitz", "rapid", "classical", "chess960", "bot", "computer"];

function Tv({ evalOn }: { evalOn: boolean }) {
  const [channel, setChannel] = useState<string>(load("tvChannel", "best"));
  const [game, setGame] = useState<{ id: string; orientation: Color; players: Record<Color, { name: string; rating?: number; title?: string }> }>();
  const [fen, setFen] = useState<string>();
  const [last, setLast] = useState<[string, string]>();
  // Clock readings as the feed last sent them, and when. The side to move counts
  // down locally between updates.
  const [clocks, setClocks] = useState<{ white?: number; black?: number; at: number }>({ at: Date.now() });
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(t); }, []);
  const [error, setError] = useState<string>();
  const { score, line } = useSpectatorEngine(fen, evalOn);
  const app = useApp();

  useEffect(() => {
    const abort = new AbortController();
    setError(undefined);
    setFen(undefined);
    setGame(undefined);
    setLast(undefined);
    setClocks({ at: Date.now() });
    const url = channel === "best" ? "https://lichess.org/api/tv/feed" : `https://lichess.org/api/tv/${channel}/feed`;
    ndjson(url, (o) => {
      if (o.t === "featured") {
        const players: any = {};
        for (const p of o.d.players) players[p.color] = { name: p.user?.name ?? "?", rating: p.rating, title: p.user?.title };
        setGame({ id: o.d.id, orientation: o.d.orientation, players });
        setFen(o.d.fen.includes(" ") ? o.d.fen : `${o.d.fen} w - - 0 1`);
        setLast(undefined);
        // A new featured game: take its clocks, never the previous game's.
        const seconds = (c: Color) => o.d.players.find((p: any) => p.color === c)?.seconds;
        setClocks({ white: seconds("white"), black: seconds("black"), at: Date.now() });
      } else if (o.t === "fen") {
        // The feed gives the placement and side to move only.
        setFen(o.d.fen.split(" ").length >= 2 ? `${o.d.fen} - - 0 1` : `${o.d.fen} w - - 0 1`);
        if (o.d.lm) setLast([o.d.lm.slice(0, 2), o.d.lm.slice(2, 4)]);
        setClocks({ white: o.d.wc, black: o.d.bc, at: Date.now() });
      }
    }, { signal: abort.signal, auth: false }).catch((e) => e.name !== "AbortError" && setError(e.message));
    return () => abort.abort();
  }, [channel]);

  const o = game?.orientation ?? "white";
  const top: Color = o === "white" ? "black" : "white";
  const shownClock = (c: Color) => {
    const base = clocks[c];
    if (base === undefined) return undefined;
    // Count down only once both sides have moved, as Lichess does.
    const running = !!fen && turnOf(fen) === c && !!last;
    return running ? Math.max(0, base - (Date.now() - clocks.at) / 1000) : base;
  };
  const strip = (c: Color) => <PlayerStrip name={`${game?.players[c].title ? game.players[c].title + " " : ""}${game?.players[c].name ?? "…"}`} color={c} detail={game?.players[c].rating ? String(game.players[c].rating) : undefined} clock={shownClock(c)} active={!!fen && turnOf(fen) === c} />;
  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow">
          {evalOn && <EvalBar score={score} flipped={o === "black"} />}
          <Board fen={fen ?? "8/8/8/8/8/8/8/8 w - - 0 1"} orientation={o} lastMove={last} />
        </div>
        {strip(o)}
      </div>
      <div className="sidecol">
        <Panel title="Channel">
          <Group gap={6}>{CHANNELS.map((c) => <Button key={c} variant={c === channel ? "filled" : "default"} tt="capitalize" onClick={() => { setChannel(c); save("tvChannel", c); }}>{c === "best" ? "Top rated" : c}</Button>)}</Group>
        </Panel>
        {evalOn && <Panel title="Engine">{score ? <><Text fw={800} size="lg" ff="ui-rounded, system-ui">{scoreText(score)}</Text><Text size="sm" c="dimmed">{line}</Text></> : <Text size="sm" c="dimmed">Waiting for a position…</Text>}</Panel>}
        {error && <Panel><Text c="red" size="sm">{error}</Text></Panel>}
        <span style={{ flex: 1 }} />
        <div style={{ padding: 12 }}>
          <Button fullWidth variant="default" disabled={!game} onClick={async () => {
            const pgn = await api(`https://lichess.org/game/export/${game!.id}`, { accept: "application/x-chess-pgn", auth: false }).then((r) => r.text()).catch(() => "");
            const t = GameTree.fromPgn(pgn);
            if (t) app.openGame(t);
          }}>Open this game in Analysis</Button>
        </div>
      </div>
    </div>
  );
}

interface Round {
  id: string;
  name: string;
  tour: string;
  ongoing: boolean;
}

function Broadcasts({ evalOn }: { evalOn: boolean }) {
  const [rounds, setRounds] = useState<Round[]>();
  const [round, setRound] = useState<Round>();
  const [games, setGames] = useState<GameTree[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState<string>();
  const app = useApp();

  useEffect(() => {
    getJson("https://lichess.org/api/broadcast/top", { auth: false })
      .then((d) => setRounds([...(d.active ?? []), ...((d.past?.currentPageResults ?? []) as any[]).slice(0, 12)].map((x: any) => ({ id: x.round?.id ?? x.lastRound?.id, name: x.round?.name ?? x.lastRound?.name ?? "", tour: x.tour.name, ongoing: !!x.round?.ongoing })).filter((r: Round) => r.id)))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!round) return;
    let live = true;
    const fetchRound = () =>
      api(`https://lichess.org/api/broadcast/round/${round.id}.pgn`, { auth: false }).then((r) => r.text()).then((text) => {
        if (!live) return;
        const trees = splitPgn(text).map((g) => GameTree.fromPgn(g)).filter((t): t is GameTree => !!t);
        trees.forEach((t) => t.toEnd());
        setGames(trees);
      }).catch((e) => live && setError(e.message));
    fetchRound();
    const timer = round.ongoing ? setInterval(fetchRound, 12000) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [round]);

  const tree = games[selected];
  if (!round) {
    return (
      <div className="page scroll">
        <Text fw={700} size="lg" mb="sm">Tournament broadcasts</Text>
        {error && <Text c="red">{error}</Text>}
        {!rounds ? <Text c="dimmed">Loading…</Text> : rounds.length ? (
          <div className="grid stagger">
            {rounds.map((r) => (
              <div key={r.id} className="card pressable" onClick={() => { setRound(r); setSelected(0); setGames([]); }}>
                <Group justify="space-between" wrap="nowrap"><Text fw={700} truncate>{r.tour}</Text>{r.ongoing && <Text size="xs" fw={700} c="red">LIVE</Text>}</Group>
                <Text size="sm" c="dimmed">{r.name}</Text>
              </div>
            ))}
          </div>
        ) : <Empty title="No broadcasts right now" />}
      </div>
    );
  }
  return (
    <div className="page">
      <div style={{ width: 250, flex: "none", borderRight: "1px solid var(--border)", background: "var(--bg-panel)", overflowY: "auto" }}>
        <div className="listrow" onClick={() => setRound(undefined)}><Text size="sm" c="dimmed">‹ All broadcasts</Text></div>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" px={12} py={6}>{round.tour} · {round.name}</Text>
        {games.map((g, i) => (
          <div key={i} className={"listrow" + (i === selected ? " on" : "")} onClick={() => setSelected(i)}>
            <div style={{ flex: 1, minWidth: 0 }}><Text size="sm" truncate>{g.tag("White")}</Text><Text size="sm" truncate>{g.tag("Black")}</Text></div>
            <Text size="xs" fw={700}>{g.result}</Text>
          </div>
        ))}
        {!games.length && <Text size="sm" c="dimmed" p={12}>Loading games…</Text>}
      </div>
      {tree ? <BroadcastGame key={selected + ":" + tree.mainline.length} tree={tree} evalOn={evalOn} onAnalyse={() => app.openGame(tree.clone())} /> : <Empty title="Pick a game" />}
    </div>
  );
}

function BroadcastGame({ tree, evalOn, onAnalyse }: { tree: GameTree; evalOn: boolean; onAnalyse: () => void }) {
  useTree(tree);
  const { score, line } = useSpectatorEngine(tree.rules === "chess" ? tree.fen : undefined, evalOn);
  const clock = (c: Color) => {
    // The clock of a side is stored on that side's last move.
    for (let n: typeof tree.current | undefined = tree.current; n && n.parent; n = n.parent) if (n.parent.turn === c && n.clock !== undefined) return n.clock;
    return undefined;
  };
  const strip = (c: Color) => <PlayerStrip name={tree.tag(c === "white" ? "White" : "Black")} color={c} detail={tree.tag(c === "white" ? "WhiteElo" : "BlackElo")} clock={clock(c)} active={tree.result === "*" && tree.last.turn === c} />;
  return (
    <>
      <div className="boardcol">
        {strip("black")}
        <div className="boardrow">
          {evalOn && <EvalBar score={score} />}
          <Board fen={tree.fen} rules={tree.rules} lastMove={tree.current.lastMove} />
        </div>
        {strip("white")}
        <Group justify="center"><NavBar tree={tree} /></Group>
      </div>
      <div className="sidecol">
        {evalOn && <Panel title="Engine">{score ? <><Text fw={800} size="lg" ff="ui-rounded, system-ui">{scoreText(score)}</Text><Text size="sm" c="dimmed">{line}</Text></> : <Text size="sm" c="dimmed">Thinking…</Text>}</Panel>}
        <Panel grow pad={false} title={`${tree.tag("Opening") || "Moves"} · ${tree.result}`}><MoveList tree={tree} editable={false} /></Panel>
        <div style={{ padding: 12 }}><Button fullWidth variant="default" onClick={onAnalyse}>Open in Analysis</Button></div>
      </div>
    </>
  );
}
void clockText;
