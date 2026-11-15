import { ActionIcon, Button, Group, SegmentedControl, Select, Text, TextInput } from "@mantine/core";
import { IconBolt, IconDownload, IconChess, IconRefresh, IconSwords, IconTrash, IconUserPlus } from "@tabler/icons-react";
import { useEffect, useMemo, useState } from "react";
import { Board } from "../components/Board";
import { Empty, NavBar, Panel, ResultBar } from "../components/common";
import { ExplorerRows } from "../components/Explorer";
import { Color, GameTree, START_FEN } from "../lib/chess";
import { db, ExplorerMove } from "../lib/db";
import { api, getJson } from "../lib/lichess";
import { openingFor, useOpenings } from "../lib/openings";
import { useRepertoire } from "../lib/repertoire";
import { load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";

interface Account {
  site: "lichess" | "chesscom";
  username: string;
}
const idOf = (a: Account) => `${a.site}-${a.username.toLowerCase()}`;

export default function AccountsPage() {
  const [tab, setTab] = useState<string>(load("accountsTab", "accounts"));
  const [accounts, setAccounts] = useState<Account[]>(load("accounts", []));
  const update = (list: Account[]) => { setAccounts(list); save("accounts", list); };
  return (
    <>
      <div className="toolbar">
        <SegmentedControl value={tab} onChange={(v) => { setTab(v); save("accountsTab", v); }} data={[{ value: "accounts", label: "Accounts" }, { value: "prepare", label: "Prepare against a player" }]} />
      </div>
      {tab === "accounts" ? <AccountList accounts={accounts} update={update} /> : <Prepare />}
    </>
  );
}

function AccountList({ accounts, update }: { accounts: Account[]; update: (a: Account[]) => void }) {
  const app = useApp();
  const revision = useApp((s) => s.libraryRevision);
  const [site, setSite] = useState<Account["site"]>("lichess");
  const [username, setUsername] = useState("");
  const [max, setMax] = useState<string>(load("accountMax", "200"));
  const [ratings, setRatings] = useState<Record<string, { label: string; rating: number; games: number }[]>>({});
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});

  const refresh = async (a: Account) => {
    try {
      const list: { label: string; rating: number; games: number }[] = [];
      if (a.site === "lichess") {
        const d = await getJson(`https://lichess.org/api/user/${a.username}`, { auth: false });
        for (const k of ["bullet", "blitz", "rapid", "classical", "correspondence", "puzzle"]) if (d.perfs?.[k]?.games) list.push({ label: k[0].toUpperCase() + k.slice(1), rating: d.perfs[k].rating, games: d.perfs[k].games });
      } else {
        const d = await getJson(`https://api.chess.com/pub/player/${a.username.toLowerCase()}/stats`, { auth: false });
        for (const [k, label] of [["chess_bullet", "Bullet"], ["chess_blitz", "Blitz"], ["chess_rapid", "Rapid"], ["chess_daily", "Daily"]]) {
          const p = d[k];
          if (p?.last?.rating) list.push({ label, rating: p.last.rating, games: (p.record?.win ?? 0) + (p.record?.loss ?? 0) + (p.record?.draw ?? 0) });
        }
      }
      setRatings((r) => ({ ...r, [idOf(a)]: list }));
    } catch (e: any) {
      setStatus((s) => ({ ...s, [idOf(a)]: `Could not load ratings: ${e.message}` }));
    }
  };

  useEffect(() => { accounts.forEach(refresh); /* eslint-disable-next-line */ }, []);
  useEffect(() => {
    accounts.forEach((a) => db.query({ player: a.username, limit: 1 }).then((r) => setCounts((c) => ({ ...c, [idOf(a)]: r.total }))).catch(() => {}));
  }, [accounts, revision]);

  const add = () => {
    const name = username.trim();
    if (!/^[\w-]+$/.test(name) || accounts.some((a) => idOf(a) === idOf({ site, username: name }))) return;
    const a = { site, username: name };
    update([...accounts, a]);
    setUsername("");
    refresh(a);
  };

  const download = async (a: Account) => {
    const id = idOf(a);
    setBusy((b) => ({ ...b, [id]: true }));
    setStatus((s) => ({ ...s, [id]: "Downloading…" }));
    try {
      let pgn = "";
      const limit = parseInt(max, 10);
      if (a.site === "lichess") {
        pgn = await api(`https://lichess.org/api/games/user/${a.username}?max=${limit}&opening=true&clocks=false&evals=false`, { accept: "application/x-chess-pgn" }).then((r) => r.text());
      } else {
        const archives: string[] = (await getJson(`https://api.chess.com/pub/player/${a.username.toLowerCase()}/games/archives`, { auth: false })).archives ?? [];
        let count = 0;
        for (const url of archives.reverse()) {
          if (count >= limit) break;
          const text = await api(`${url}/pgn`, { auth: false }).then((r) => r.text());
          count += text.split("[Event ").length - 1;
          pgn += text + "\n\n";
          setStatus((s) => ({ ...s, [id]: `Downloading… ${count} games` }));
        }
      }
      const r = await db.importText(pgn, a.site === "lichess" ? "Lichess" : "Chess.com", true);
      setStatus((s) => ({ ...s, [id]: r.added ? `Added ${r.added} new game${r.added === 1 ? "" : "s"}.` : "Already up to date." }));
    } catch (e: any) {
      setStatus((s) => ({ ...s, [id]: `Download failed: ${e.message}` }));
    }
    setBusy((b) => ({ ...b, [id]: false }));
  };

  return (
    <div className="page scroll">
      <div className="card" style={{ marginBottom: 14 }}>
        <Group>
          <Select w={130} value={site} onChange={(v) => v && setSite(v as Account["site"])} data={[{ value: "lichess", label: "Lichess" }, { value: "chesscom", label: "Chess.com" }]} />
          <TextInput w={220} placeholder="Username" value={username} onChange={(e) => setUsername(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          <Button leftSection={<IconUserPlus size={14} />} disabled={!username.trim()} onClick={add}>Add account</Button>
          <span style={{ flex: 1 }} />
          <Select w={190} value={max} onChange={(v) => { if (v) { setMax(v); save("accountMax", v); } }} data={["50", "200", "500", "1000", "3000"].map((n) => ({ value: n, label: `Latest ${n} games` }))} />
        </Group>
        <Text size="xs" c="dimmed" mt={6}>Add your own accounts, or an opponent's, to pull their public games into the Library. No password is needed.</Text>
      </div>
      {accounts.length ? (
        <div className="grid stagger">
          {accounts.map((a) => {
            const id = idOf(a);
            return (
              <div key={id} className="card">
                <Group gap={10} wrap="nowrap" mb={10}>
                  {a.site === "lichess" ? <IconBolt size={26} color="var(--mantine-primary-color-filled)" /> : <IconChess size={26} color="var(--mantine-primary-color-filled)" />}
                  <div style={{ flex: 1 }}>
                    <Text fw={700}>{a.username}</Text>
                    <Text size="xs" c="dimmed">{a.site === "lichess" ? "Lichess" : "Chess.com"} · {(counts[id] ?? 0).toLocaleString()} games in Library</Text>
                  </div>
                  <ActionIcon variant="subtle" color="gray" onClick={() => refresh(a)}><IconRefresh size={15} /></ActionIcon>
                  <ActionIcon variant="subtle" color="red" onClick={() => update(accounts.filter((x) => idOf(x) !== id))}><IconTrash size={15} /></ActionIcon>
                </Group>
                <Group gap={6} grow mih={44}>
                  {(ratings[id] ?? []).map((r) => <div key={r.label} className="stat" style={{ alignItems: "center" }} title={`${r.games} games`}><b style={{ fontSize: 15 }}>{r.rating}</b><small>{r.label}</small></div>)}
                  {!(ratings[id] ?? []).length && <Text size="sm" c="dimmed">No ratings yet</Text>}
                </Group>
                <Group gap={6} mt={10}>
                  <Button variant="light" leftSection={<IconDownload size={14} />} loading={busy[id]} onClick={() => download(a)}>Download games</Button>
                  <Button variant="default" onClick={() => app.go("library", { kind: "player", payload: a.username })}>Show games</Button>
                </Group>
                {status[id] && <Text size="xs" c="dimmed" mt={6}>{status[id]}</Text>}
              </div>
            );
          })}
        </div>
      ) : (
        <Empty icon={<IconUserPlus size={34} />} title="No accounts">Add a Lichess or Chess.com username to see ratings and download games into the Library.</Empty>
      )}
    </div>
  );
}

interface Weak {
  line: string[];
  san: string;
  games: number;
  score: number;
}

/** What a player in the library plays, where they leave the book and where they score badly. */
function Prepare() {
  const revision = useApp((s) => s.libraryRevision);
  useOpenings((s) => s.loaded);
  const [players, setPlayers] = useState<[string, number][]>([]);
  const [player, setPlayer] = useState<string>();
  const [color, setColor] = useState<Color>("white");
  const tree = useMemo(() => new GameTree(), [player, color]); // eslint-disable-line react-hooks/exhaustive-deps
  useTree(tree);
  const [moves, setMoves] = useState<ExplorerMove[]>([]);
  const [weak, setWeak] = useState<Weak[]>();
  const [scanning, setScanning] = useState(false);
  const [note, setNote] = useState("");
  const repertoire = useRepertoire();

  useEffect(() => { db.players().then(setPlayers); }, [revision]);
  useEffect(() => { if (player) db.explorer(tree.fen, player, color).then(setMoves); else setMoves([]); }, [tree.fen, player, color, revision]);
  useEffect(() => setWeak(undefined), [player, color]);

  const theirMove = tree.current.turn === color;
  const opening = openingFor(tree);
  const total = moves.reduce((a, m) => a + m.white + m.draws + m.black, 0);
  const their = (m: ExplorerMove) => (color === "white" ? m.white : m.black) + m.draws / 2;

  /** Walks the player's opening tree looking for moves of theirs that score badly. */
  const scan = async () => {
    if (!player) return;
    setScanning(true);
    const found: Weak[] = [];
    const walker = new GameTree();
    const queue: string[][] = [[]];
    let visited = 0;
    while (queue.length && visited < 220) {
      const line = queue.shift()!;
      walker.toStart();
      if (!line.every((san) => walker.playSan(san))) continue;
      visited++;
      const list = await db.explorer(walker.fen, player, color);
      const isTheirs = walker.current.turn === color;
      for (const m of list) {
        const games = m.white + m.draws + m.black;
        if (games < 3) continue;
        if (isTheirs) {
          const score = their(m) / games;
          if (score <= 0.38) found.push({ line, san: m.san, games, score });
        }
        if (line.length < 13) queue.push([...line, m.san]);
      }
    }
    found.sort((a, b) => a.score - b.score || b.games - a.games);
    setWeak(found.slice(0, 15));
    setScanning(false);
  };

  const addToRepertoire = () => {
    const mine: Color = color === "white" ? "black" : "white";
    const copy = new GameTree();
    for (const n of tree.path(tree.current)) copy.playSan(n.san);
    repertoire.importTree(copy, mine);
    setNote(`Line added to your ${mine === "white" ? "White" : "Black"} repertoire.`);
    setTimeout(() => setNote(""), 2500);
  };

  return (
    <div className="page">
      <div className="boardcol">
        <div className="boardrow">
          <Board fen={tree.fen} orientation={color === "white" ? "black" : "white"} movable="both" lastMove={tree.current.lastMove} onMove={(m) => tree.play(m)} />
        </div>
        <Group justify="center"><NavBar tree={tree} /></Group>
      </div>
      <div className="sidecol wide">
        <Panel title="Opponent">
          <Select searchable placeholder="Choose a player from your library" value={player ?? null} onChange={(v) => setPlayer(v ?? undefined)} data={players.map(([n, c]) => ({ value: n, label: `${n} (${c} games)` }))} />
          <SegmentedControl mt={8} fullWidth value={color} onChange={(v) => setColor(v as Color)} data={[{ value: "white", label: "When they are White" }, { value: "black", label: "When they are Black" }]} />
          {!players.length && <Text size="xs" c="dimmed" mt={6}>Download the opponent's games on the Accounts tab first.</Text>}
        </Panel>
        {player ? (
          <>
            <Panel grow pad={false} title={`${theirMove ? `${player} plays` : "Replies they have faced"} · ${total} games`} right={<Text size="xs" c="dimmed" truncate maw={160}>{opening?.name ?? (tree.fen === START_FEN ? "" : "Out of book")}</Text>}>
              {moves.length ? <ExplorerRows moves={moves} onPlay={(san) => tree.playSan(san)} /> : <Empty title="No more games">{player} has not reached this position as {color === "white" ? "White" : "Black"}.</Empty>}
            </Panel>
            <Panel title="Where they score badly" right={<Button variant="light" loading={scanning} onClick={scan}>{weak ? "Scan again" : "Scan"}</Button>}>
              {!weak ? <Text size="sm" c="dimmed">Searches their first dozen moves for choices that have gone wrong at least three times.</Text> : weak.length ? (
                <div style={{ maxHeight: 190, overflowY: "auto", margin: "0 -12px" }}>
                  {weak.map((w, i) => (
                    <div key={i} className="listrow" onClick={() => { tree.toStart(); [...w.line, w.san].forEach((s) => tree.playSan(s)); }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="sm" fw={600} truncate>{[...w.line, w.san].map((s, j) => (j % 2 === 0 ? `${j / 2 + 1}.${s}` : s)).join(" ")}</Text>
                        <Text size="xs" c="dimmed">scores {Math.round(w.score * 100)}% in {w.games} games</Text>
                      </div>
                      <div style={{ width: 70 }}><ResultBar white={Math.round(w.score * w.games)} draws={0} black={Math.round((1 - w.score) * w.games)} /></div>
                    </div>
                  ))}
                </div>
              ) : <Text size="sm" c="dimmed">No clear weak spots in the games you have.</Text>}
            </Panel>
            <div style={{ padding: 12 }}>
              <Button fullWidth leftSection={<IconSwords size={15} />} disabled={!tree.current.parent} onClick={addToRepertoire}>Add this line to my repertoire</Button>
              {note && <Text size="xs" c="green" mt={4}>{note}</Text>}
            </div>
          </>
        ) : <Empty icon={<IconSwords size={34} />} title="Prepare for an opponent">Pick a player to see what they play, where they leave theory and which of their lines keep losing.</Empty>}
      </div>
    </div>
  );
}
