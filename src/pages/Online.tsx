import { ActionIcon, Alert, Badge, Button, Collapse, Group, Loader, Menu, Modal, NumberInput, Progress, SegmentedControl, Select, Switch, Text, Textarea, TextInput, Tooltip } from "@mantine/core";
import {
  IconArrowBackUp, IconBan, IconBolt, IconChartLine, IconNotes, IconRobot, IconShield, IconBroadcast, IconCheck, IconCopy, IconDeviceTv, IconDots, IconEye, IconFileDownload, IconFlag, IconFlame, IconGif, IconHandStop,
  IconLink, IconMailbox, IconPlayerSkipForward, IconPlugConnected, IconPlus, IconPuzzle, IconRefresh, IconSearch, IconSend, IconShare2, IconSwords,
  IconTrophy, IconUserPlus, IconUsers, IconWifiOff, IconX,
} from "@tabler/icons-react";
import { ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Board } from "../components/Board";
import { EvalBar, MoveList, Panel, PlayerStrip } from "../components/common";
import { OnlineStats } from "../components/OnlineStats";
import { BotsPanel, openProfile, PhoneAlerts, SimulList, SimulPanel, TeamModal } from "../components/OnlineExtras";
import { Color, GameTree, GNode, materialBalance, positionOf, sanLine, scoreText, Shape, uciOf } from "../lib/chess";
import { entryOf, launch, resolveEngine } from "../lib/engines";
import {
  ABANDON_MS, ARENA_BREAK_MS, ArenaInfo, CATEGORY_LABELS, categoryOf, Challenge, Correspondence, GameView, gamesFor, ONLINE_VARIANTS, OnlineVariant,
  isBot, ratingFor, ratingWindow, REACTIONS, RoomLine, rulesOfVariant, shownClocks, SwissInfo, tc, TV_CHANNELS, useOnline, variantLabel,
} from "../lib/online";
import { usePlay } from "../lib/play";
import { usePuzzles } from "../lib/puzzles";
import { useRace } from "../lib/race";
import { checkPrep, PrepCheck, useRepertoire } from "../lib/repertoire";
import { mistakePuzzles, reviewGame, ReviewSummary, summarise } from "../lib/review";
import { copyPgn, copyShareLink, saveGif, savePgn } from "../lib/share";
import { copyText, load, save } from "../lib/storage";
import { useApp, useTree } from "../lib/store";
import type { Engine } from "../lib/uci";
import { useSpectatorEngine } from "./Watch";

const PRESETS: [number, number, string][] = [[1, 0, "Bullet"], [3, 2, "Blitz"], [5, 0, "Blitz"], [10, 0, "Rapid"], [15, 10, "Rapid"], [30, 0, "Classical"]];
const DAYS = [1, 2, 3, 5, 7, 14];
const other = (c: Color): Color => (c === "white" ? "black" : "white");
const minutesLeft = (ms: number) => (ms < 60_000 ? "under a minute" : ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 3600_000)} h`);
/** Time left on a correspondence clock: "2d 4h", "5h 12m", "14m". */
const daysLeft = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000)), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${m % 60}m` : `${m}m`;
};
const speed = (g: { minutes: number; increment: number; days?: number | null }) => (g.days ? `${g.days} day${g.days > 1 ? "s" : ""}/move` : tc(g.minutes, g.increment));
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

/** Castle Online now lives on the Play page; the old page id still leads there. */
export default function OnlinePage() {
  const go = useApp((s) => s.go);
  useEffect(() => {
    if (usePlay.getState().phase === "setup") usePlay.getState().patch({ opponent: "online" });
    go("play");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <></>;
}

/** Accept or decline buttons for one incoming challenge. */
export function ChallengeCard({ c, onAccept }: { c: Challenge; onAccept?: () => void }) {
  const o = useOnline();
  return (
    <Alert color="teal" p="xs" icon={<IconSwords size={16} />} title={`${c.name}${c.rating ? ` (${c.rating})` : ""} challenges you`}>
      <Text size="sm">{speed(c)} · {variantLabel(c.variant)} · {c.rated ? "rated" : "casual"}</Text>
      <Group gap={6} mt={6}>
        <Button size="xs" leftSection={<IconCheck size={13} />} onClick={() => { onAccept?.(); o.answer(c, true); }}>Accept</Button>
        <Button size="xs" variant="default" onClick={() => o.answer(c, false)}>Decline</Button>
      </Group>
    </Alert>
  );
}

/** Chat lines and a box to add one: a game's spectators or a tournament's players. */
function Room({ lines, onSay, placeholder, empty, height = 130 }: { lines: RoomLine[]; onSay: (t: string) => void; placeholder: string; empty: ReactNode; height?: number }) {
  const [text, setText] = useState("");
  const talk = lines.filter((l) => l.kind === "text");
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }); }, [talk.length]);
  return (
    <>
      <div style={{ maxHeight: height, overflowY: "auto" }} className="selectable">
        {talk.length ? talk.map((l) => <Text key={l.id} size="sm"><b>{l.name}:</b> {l.text}</Text>) : <Text size="xs" c="dimmed">{empty}</Text>}
        <div ref={end} />
      </div>
      <Group gap={6} mt={6} wrap="nowrap">
        <TextInput style={{ flex: 1 }} size="xs" placeholder={placeholder} maxLength={200} value={text} onChange={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { onSay(text); setText(""); } }} />
        <Button size="xs" variant="default" onClick={() => { onSay(text); setText(""); }}><IconSend size={13} /></Button>
      </Group>
    </>
  );
}

/** Your ratings, and moving them to another computer or linking them to Lichess. */
function RatingModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const o = useOnline();
  const [code, setCode] = useState<{ code: string; minutes: number }>();
  const [claim, setClaim] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const run = async (what: string, f: () => Promise<unknown>, done?: string) => {
    setBusy(what);
    setMessage(undefined);
    try { await f(); if (done) setMessage({ ok: true, text: done }); } catch (e: any) { setMessage({ ok: false, text: e.message }); } finally { setBusy(undefined); }
  };
  const p = o.profile;
  const played = Object.keys(CATEGORY_LABELS).filter((c) => gamesFor(p, c) > 0);
  return (
    <Modal opened={opened} onClose={onClose} title={<Text fw={800}>Your rating</Text>} size="md">
      {p && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 8 }}>
          {(played.length ? played : ["blitz"]).map((c) => (
            <div key={c} className="card" style={{ padding: 8 }}>
              <Text size="xs" c="dimmed">{CATEGORY_LABELS[c]}</Text>
              <Text fw={800} fz={20} ff="ui-rounded, system-ui">{ratingFor(p, c)}</Text>
              <Text size="xs" c="dimmed">{gamesFor(p, c)} games{gamesFor(p, c) < 10 ? " · provisional" : ""}</Text>
            </div>
          ))}
        </div>
      )}
      <Text fw={700} size="sm" mt="lg">Move it to another computer</Text>
      <Text size="xs" c="dimmed">Your rating lives on this computer. A code moves it to another one; this computer then starts fresh.</Text>
      {code ? (
        <Alert mt={6} p="xs" color="teal"><Text size="sm">On the other computer, enter <b style={{ fontSize: 18, letterSpacing: 2 }}>{code.code}</b> within {code.minutes} minutes.</Text></Alert>
      ) : (
        <Button mt={6} size="xs" variant="light" loading={busy === "code"} onClick={() => run("code", async () => setCode(await o.createTransfer()))}>Make a transfer code</Button>
      )}
      <Group mt={8} gap={6} wrap="nowrap">
        <TextInput style={{ flex: 1 }} size="xs" placeholder="Got a code? Enter it here" value={claim} onChange={(e) => setClaim(e.currentTarget.value.toUpperCase())} />
        <Button size="xs" variant="default" disabled={claim.length < 8} loading={busy === "claim"}
          onClick={() => run("claim", () => o.claimTransfer(claim), "Your rating is on this computer now.")}>Bring it here</Button>
      </Group>
      <Text fw={700} size="sm" mt="lg">Lichess</Text>
      <Text size="xs" c="dimmed">Link your rating to your Lichess account (signed in on the Accounts page) and you can always get it back by signing in to Lichess.</Text>
      <Group mt={6} gap={6}>
        {o.lichess ? (
          <>
            <Badge variant="light" color="teal">Linked to {o.lichess}</Badge>
            <Button size="xs" variant="subtle" color="gray" loading={busy === "unlink"} onClick={() => run("unlink", () => o.unlinkLichess())}>Unlink</Button>
          </>
        ) : <Button size="xs" variant="light" loading={busy === "link"} onClick={() => run("link", () => o.linkLichess(), "Linked.")}>Link to Lichess</Button>}
        <Button size="xs" variant="default" loading={busy === "recover"} onClick={() => run("recover", () => o.recoverLichess(), "Your rating is back.")}>Recover from Lichess</Button>
      </Group>
      {message && <Text size="sm" mt="sm" c={message.ok ? "teal" : "red"}>{message.text}</Text>}
      <PhoneAlerts />
    </Modal>
  );
}

/** The Play page's sidebar when the opponent is "Online": queue, friends, tournaments, lobby. */
export function OnlinePanels() {
  const o = useOnline();
  const app = useApp();
  const [preset, setPreset] = useState<number>(load("onlinePreset", 2));
  const [mode, setMode] = useState<string>(load("onlineMode", "live"));
  const [days, setDays] = useState<number>(load("onlineDays", 3));
  const [variant, setVariant] = useState<OnlineVariant>(load("onlineVariant", "chess"));
  const [color, setColor] = useState("random");
  const [rated, setRated] = useState<boolean>(load("onlineRated", true));
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [tab, setTab] = useState<string>(load("onlineTab", "open"));
  const [tourTab, setTourTab] = useState<string>(load("onlineTourTab", "arena"));
  const [making, setMaking] = useState(false);
  const [ratingOpen, setRatingOpen] = useState(false);
  const [statsOpen, setStatsOpen] = useState(false);

  useEffect(() => { if (!o.ready) o.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!o.ready) return;
    o.refreshLobby();
    o.refreshArenas();
    o.refreshSwisses();
    const t = setInterval(o.refreshLobby, 4000);
    const a = setInterval(() => { o.refreshArenas(); o.refreshSwisses(); }, 15000);
    return () => { clearInterval(t); clearInterval(a); };
  }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(undefined); }
  };
  const [minutes, increment] = PRESETS[preset];
  const corr = mode === "correspondence" ? days : null;
  const category = categoryOf(variant, minutes, increment, corr);
  const p = o.profile;
  const listGame = (g: GameView, action: "watch" | "analyse") => (
    <div key={g.id} className="listrow" onClick={() => (action === "watch" ? o.watch(g.id) : app.openGame(o.toTree(g)))}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" truncate><b>{g.white.name}</b> {g.white.rating ?? ""} – <b>{g.black.name}</b> {g.black.rating ?? ""}</Text>
        <Text size="xs" c="dimmed">{speed(g)}{g.variant && g.variant !== "chess" ? ` · ${variantLabel(g.variant)}` : ""} · {g.arena ? "arena" : g.swiss ? "Swiss" : g.rated ? "rated" : "casual"} · {g.ply} plies{g.result ? ` · ${g.result === "aborted" ? "aborted" : `${g.result} by ${g.reason}`}` : ""}</Text>
      </div>
      {action === "watch" ? <IconEye size={16} /> : <Text size="xs" c="dimmed">Analyse</Text>}
    </div>
  );
  const openBattle = (code: string) => run("battle", async () => {
    await useRace.getState().joinBattle(code);
    usePuzzles.getState().setMode("battle");
    app.go("puzzles");
  });
  const mine = o.correspondence;
  const myTurn = mine.filter((c) => c.myTurn).length;

  return (
    <>
      {o.error && (
        <div style={{ padding: "10px 12px 0" }}>
          <Alert color="orange" p="xs" withCloseButton onClose={() => useOnline.setState({ error: undefined })}>
            <Text size="sm">{o.error}</Text>
            {!o.ready && <Button mt={6} size="xs" variant="light" color="orange" leftSection={<IconRefresh size={13} />} onClick={() => { useOnline.setState({ error: undefined }); o.start(); }}>Try again</Button>}
          </Alert>
        </div>
      )}
      {o.banned && (
        <div style={{ padding: "10px 12px 0" }}>
          <Alert color="red" p="xs" icon={<IconShield size={16} />} title="Your Castle Online account is suspended">
            <Text size="sm">Until {new Date(o.banned.until).toLocaleString()}{o.banned.reason ? `: ${o.banned.reason}` : "."} You can finish games already started.</Text>
          </Alert>
        </div>
      )}
      {o.incoming.length > 0 && <div style={{ padding: "10px 12px 0", display: "grid", gap: 6 }}>{o.incoming.map((c) => <ChallengeCard key={c.id} c={c} />)}</div>}
      {o.arena && <ArenaPanel />}
      {o.swiss && <SwissPanel />}
      {o.simul && <SimulPanel />}

      <Panel title="You" right={p && <Group gap={2}>
        <Button size="compact-xs" variant="subtle" onClick={() => openProfile(p.id)}>Profile</Button>
        <Button size="compact-xs" variant="subtle" leftSection={<IconChartLine size={12} />} onClick={() => setStatsOpen(true)}>Stats</Button>
        <Button size="compact-xs" variant="subtle" onClick={() => setRatingOpen(true)}>Ratings &amp; transfer</Button>
      </Group>}>
        <Group gap="md" wrap="nowrap" align="flex-end">
          <TextInput style={{ flex: 1 }} size="xs" label="Name shown to opponents" value={o.name} maxLength={24} onChange={(e) => o.setName(e.currentTarget.value)} />
          {p ? (
            <Tooltip label={`${p.wins} won · ${p.draws} drawn · ${p.losses} lost overall`}>
              <div style={{ textAlign: "right" }}>
                <Text fz={24} fw={800} ff="ui-rounded, system-ui" lh={1}>{ratingFor(p, category)}</Text>
                <Text size="xs" c="dimmed">{CATEGORY_LABELS[category]}{gamesFor(p, category) < 10 ? ", provisional" : ""}</Text>
              </div>
            </Tooltip>
          ) : <Text size="sm" c="dimmed">{o.error ? "Offline" : "Connecting…"}</Text>}
        </Group>
      </Panel>
      <RatingModal opened={ratingOpen} onClose={() => setRatingOpen(false)} />
      <OnlineStats opened={statsOpen} onClose={() => setStatsOpen(false)} />

      {mine.length > 0 && (
        <Panel title={<><IconMailbox size={13} /> Correspondence {myTurn > 0 && <Badge size="xs" ml={4}>{myTurn} to move</Badge>}</>} pad={false}>
          {mine.map((c: Correspondence) => (
            <div key={c.id} className="listrow" onClick={() => o.openCorrespondence(c)}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" truncate fw={c.myTurn ? 700 : 400}>vs {c.opponent ?? "?"}{c.variant !== "chess" ? ` · ${variantLabel(c.variant)}` : ""}</Text>
                <Text size="xs" c="dimmed">Move {Math.floor(c.ply / 2) + 1} · {c.days} day{c.days > 1 ? "s" : ""}/move{c.deadline ? ` · ${daysLeft(c.deadline - Date.now())} left` : ""}</Text>
              </div>
              {c.myTurn ? <Badge size="sm">Your move</Badge> : <Text size="xs" c="dimmed">Waiting</Text>}
            </div>
          ))}
        </Panel>
      )}

      <Panel title={<><IconBolt size={13} /> Quick pairing</>}>
        <SegmentedControl size="xs" fullWidth mb="sm" value={mode} onChange={(v) => { setMode(v); save("onlineMode", v); }}
          data={[{ value: "live", label: "Live" }, { value: "correspondence", label: "Correspondence" }]} />
        {mode === "live" ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6 }}>
            {PRESETS.map(([m, i, label], k) => (
              <Button key={k} size="sm" h={46} variant={preset === k ? "filled" : "default"} onClick={() => { setPreset(k); save("onlinePreset", k); }}>
                <div style={{ lineHeight: 1.15 }}>
                  <div>{tc(m, i)}</div>
                  <Text span size="xs" c={preset === k ? undefined : "dimmed"}>{label}</Text>
                </div>
              </Button>
            ))}
          </div>
        ) : (
          <>
            <Group gap={6}>
              {DAYS.map((d) => <Button key={d} size="xs" variant={days === d ? "filled" : "default"} onClick={() => { setDays(d); save("onlineDays", d); }}>{d} day{d > 1 ? "s" : ""}</Button>)}
            </Group>
            <Text size="xs" c="dimmed" mt={4}>Per move. Castle lets you know when it's your turn, and the game waits for you between sessions.</Text>
          </>
        )}
        <Group mt="sm" gap="md" align="flex-end" wrap="nowrap">
          <Select style={{ flex: 1 }} size="xs" label="Variant" value={variant} data={ONLINE_VARIANTS} allowDeselect={false}
            onChange={(v) => { if (v) { setVariant(v as OnlineVariant); save("onlineVariant", v); } }} />
          <Switch mb={6} size="xs" label="Rated" checked={rated} onChange={(e) => { setRated(e.currentTarget.checked); save("onlineRated", e.currentTarget.checked); }} />
        </Group>
        <Button mt="sm" fullWidth size="md" loading={busy === "queue"} disabled={!o.ready} leftSection={<IconSearch size={16} />}
          onClick={() => run("queue", () => o.quickPair({ minutes, increment, rated, variant, days: corr }))}>{corr ? "Post a correspondence seek" : "Find an opponent"}</Button>
        <Text size="xs" c="dimmed" mt={6}>{corr
          ? "Joins someone looking for the same game, or lists yours in the lobby for three days."
          : `Pairs you with someone near your ${CATEGORY_LABELS[category]} rating for ${tc(minutes, increment)} ${variantLabel(variant)}. The range widens the longer you wait.`}</Text>
      </Panel>

      {!corr && <BotsPanel minutes={minutes} increment={increment} variant={variant} />}

      <Panel title={<><IconUsers size={13} /> Play a friend</>}>
        <SegmentedControl size="xs" fullWidth value={color} onChange={setColor} data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }]} />
        <Button mt="sm" fullWidth variant="light" loading={busy === "create"} disabled={!o.ready} leftSection={<IconSwords size={15} />}
          onClick={() => run("create", () => o.create({ minutes, increment, days: corr, color, rated, public: false, variant }))}>Create a game with a code</Button>
        <Group mt="sm" gap={6} wrap="nowrap">
          <TextInput style={{ flex: 1 }} size="xs" placeholder="Join with a code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && code && run("join", () => o.join(code))} />
          <Button size="xs" variant="default" disabled={!code || !o.ready} loading={busy === "join"} onClick={() => run("join", () => o.join(code))}>Join</Button>
        </Group>
        <Text size="xs" fw={600} mt="md" mb={4}>Friends</Text>
        {o.friends.length ? o.friends.map((f) => (
          <Group key={f.id} gap={8} wrap="nowrap" py={3}>
            <Tooltip label={o.presence[f.id] ? "Online now" : "Offline"}><span className={"presence" + (o.presence[f.id] ? " on" : "")} /></Tooltip>
            <Text size="sm" style={{ flex: 1 }} truncate>{f.name}</Text>
            <Button size="compact-xs" variant="light" disabled={!o.ready} loading={busy === `ch-${f.id}`}
              onClick={() => run(`ch-${f.id}`, () => o.challenge(f, { minutes, increment, days: corr, rated, variant, color }))}>Challenge</Button>
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.removeFriend(f.id)}><IconX size={13} /></ActionIcon>
          </Group>
        )) : <Text size="xs" c="dimmed">Add opponents as friends from a game or the leaderboard, then challenge them here with the settings above.</Text>}
      </Panel>

      <TeamPanel />

      {!o.arena && !o.swiss && !o.simul && (
        <Panel title={<><IconTrophy size={13} /> Tournaments</>} pad={false}
          right={tourTab === "simul" ? undefined : <Tooltip label={`Make ${tourTab === "arena" ? "an arena" : "a Swiss"}`}><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setMaking(!making)}><IconPlus size={14} /></ActionIcon></Tooltip>}>
          <div style={{ padding: "8px 12px 4px" }}>
            <SegmentedControl size="xs" fullWidth value={tourTab} onChange={(v) => { setTourTab(v); save("onlineTourTab", v); setMaking(false); }}
              data={[{ value: "arena", label: "Arenas" }, { value: "swiss", label: "Swiss" }, { value: "simul", label: "Simuls" }]} />
          </div>
          <Collapse in={making && tourTab !== "simul"}>{tourTab === "arena" ? <NewArena onDone={() => setMaking(false)} /> : <NewSwiss onDone={() => setMaking(false)} />}</Collapse>
          {tourTab === "simul" ? <SimulList /> : tourTab === "arena" ? (
            <>
              {o.arenas.filter((a) => a.status !== "finished").map((a) => <ArenaRow key={a.id} a={a} />)}
              {!o.arenas.some((a) => a.status !== "finished") && <Text size="sm" c="dimmed" p={12}>{o.ready ? "Loading arenas…" : "Arenas appear once you are connected."}</Text>}
              <Text size="xs" c="dimmed" px={12} pb={10} pt={4}>Play as many games as you can before the end. Win 2, draw 1; after two wins in a row, points double. Berserk: halve your clock for a bonus point.</Text>
            </>
          ) : (
            <>
              {o.swisses.filter((s) => s.status !== "finished").map((s) => <SwissRow key={s.id} s={s} />)}
              {!o.swisses.some((s) => s.status !== "finished") && <Text size="sm" c="dimmed" p={12}>No Swiss tournaments are coming up. Make one with +.</Text>}
              <Text size="xs" c="dimmed" px={12} pb={10} pt={4}>A set number of rounds; everyone plays every round against someone on the same score. Join before it starts.</Text>
            </>
          )}
        </Panel>
      )}

      <Panel title={<><IconBroadcast size={13} /> Lobby</>} pad={false}
        right={<Group gap={4}>
          <Tooltip label="Castle TV: the top live game"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.watchTV(o.tvChannel)}><IconDeviceTv size={14} /></ActionIcon></Tooltip>
          <Tooltip label="Refresh"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.refreshLobby()}><IconRefresh size={13} /></ActionIcon></Tooltip>
        </Group>}>
        <div style={{ padding: "8px 12px" }}>
          <SegmentedControl size="xs" fullWidth value={tab} onChange={(v) => { setTab(v); save("onlineTab", v); }}
            data={[{ value: "open", label: `Seeks (${o.open.length + o.races.length})` }, { value: "live", label: `Live (${o.live.length})` }, { value: "mine", label: "Mine" }, { value: "top", label: "Top" }]} />
        </div>
        {tab === "open" && (o.open.length || o.races.length ? (
          <>
            {o.open.map((s) => (
              <div key={s.id} className="listrow">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" truncate><b>{s.name}</b> {s.rating}</Text>
                  <Text size="xs" c="dimmed">{speed(s)}{s.variant && s.variant !== "chess" ? ` · ${variantLabel(s.variant)}` : ""} · {s.rated ? "rated" : "casual"} · {s.color === "random" ? "random colours" : `plays ${s.color}`}</Text>
                </div>
                <Button size="xs" disabled={!o.ready} onClick={() => run("join", () => o.join(s.code))}>Play</Button>
              </div>
            ))}
            {o.races.map((b) => (
              <div key={b.id} className="listrow">
                <IconPuzzle size={16} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" truncate><b>{b.name}</b></Text>
                  <Text size="xs" c="dimmed">Puzzle battle · {b.minutes} min</Text>
                </div>
                <Button size="xs" variant="light" disabled={!o.ready} loading={busy === "battle"} onClick={() => openBattle(b.code)}>Battle</Button>
              </div>
            ))}
          </>
        ) : <Text size="sm" c="dimmed" p={12}>Nobody is waiting. Find an opponent and you show up here for others.</Text>)}
        {tab === "live" && (o.live.length ? o.live.map((g) => listGame(g, "watch")) : <Text size="sm" c="dimmed" p={12}>No games are being played right now.</Text>)}
        {tab === "mine" && (o.history.length ? o.history.map((g) => listGame(g, "analyse")) : <Text size="sm" c="dimmed" p={12}>Your finished games appear here.</Text>)}
        {tab === "top" && (
          <>
            <div style={{ padding: "0 12px 6px" }}>
              <Select size="xs" value={o.leaderCategory} allowDeselect={false} onChange={(v) => v && o.setLeaderCategory(v)}
                data={Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }))} />
            </div>
            {o.leaders.length ? o.leaders.map((l, i) => (
              <div key={l.guest} className="listrow">
                <Text w={24} fw={700} c="dimmed">{i + 1}</Text>
                {i === 0 && <IconTrophy size={15} color="gold" />}
                <Text size="sm" style={{ flex: 1, cursor: "pointer" }} truncate fw={l.guest === p?.id ? 800 : 500} onClick={() => openProfile(l.guest)}>{l.name}{l.guest === p?.id ? " (you)" : ""}</Text>
                <Text size="xs" c="dimmed">{l.games} games</Text>
                <Text fw={700} w={44} ta="right">{l.rating}</Text>
                {l.guest !== p?.id && !o.friends.some((f) => f.id === l.guest) && (
                  <Tooltip label="Add as a friend"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => o.addFriend({ id: l.guest, name: l.name })}><IconUserPlus size={13} /></ActionIcon></Tooltip>
                )}
              </div>
            )) : <Text size="sm" c="dimmed" p={12}>No rated {CATEGORY_LABELS[o.leaderCategory]?.toLowerCase()} games yet.</Text>}
          </>
        )}
      </Panel>

      <Panel title="Options">
        <Switch size="xs" label="Confirm each move before it is sent" checked={o.confirmMoves} onChange={(e) => o.setOption({ confirmMoves: e.currentTarget.checked })} />
        <Switch mt={8} size="xs" label="Review my games when they end" checked={o.autoReview} onChange={(e) => o.setOption({ autoReview: e.currentTarget.checked })} />
        <Switch mt={8} size="xs" label="Turn off chat with opponents" checked={o.muteOpponent} onChange={(e) => o.setOption({ muteOpponent: e.currentTarget.checked })} />
        <Switch mt={8} size="xs" label="Hide spectators' chat and reactions" checked={o.hideRoom} onChange={(e) => o.setOption({ hideRoom: e.currentTarget.checked })} />
        <Text size="xs" c="dimmed" mt={6}>Premoves: while your opponent thinks, make your next move; it plays the moment it becomes legal. Right-click to cancel.</Text>
        {o.blocked.length > 0 && (
          <>
            <Text size="xs" fw={600} mt="sm">Blocked players ({o.blocked.length})</Text>
            <Text size="xs" c="dimmed">They can't challenge you, join your games or be paired with you, and their chat is hidden.</Text>
            {o.blocked.map((b) => (
              <Group key={b} gap={6} mt={4} wrap="nowrap">
                <Text size="xs" ff="monospace" style={{ flex: 1 }} truncate>{b}</Text>
                <Button size="compact-xs" variant="subtle" onClick={() => o.unblock(b)}>Unblock</Button>
              </Group>
            ))}
          </>
        )}
      </Panel>
      <Text size="xs" c="dimmed" p={12}>No account needed: you play as a guest, and your rating stays on this computer, sealed so it can't be edited.{o.liveSocket ? " Live updates are on." : ""}</Text>
    </>
  );
}

function ArenaRow({ a }: { a: ArenaInfo }) {
  const o = useOnline();
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  return (
    <div className="listrow" style={{ cursor: "default" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={600} truncate>{a.name}</Text>
        <Text size="xs" c="dimmed">
          {a.teamLeaders ? "Team battle · " : ""}{tc(a.minutes, a.increment)}{a.variant !== "chess" ? ` · ${variantLabel(a.variant)}` : ""} · {a.status === "running" ? `ends in ${minutesLeft(a.endsAt - now)}` : `starts in ${minutesLeft(a.startsAt - now)}`} · {a.players ?? 0} playing{a.leader ? ` · ${a.leader} leads` : ""}
        </Text>
      </div>
      {a.status === "running" && <Badge size="xs" color="green" variant="light">Live</Badge>}
      <Button size="xs" variant={a.status === "running" ? "filled" : "default"} loading={busy} disabled={!o.ready}
        onClick={async () => { setBusy(true); try { await o.joinArena(a.id); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); } }}>Join</Button>
    </div>
  );
}

function SwissRow({ s }: { s: SwissInfo }) {
  const o = useOnline();
  const [busy, setBusy] = useState(false);
  const open = s.status === "upcoming" || s.round < s.rounds;
  return (
    <div className="listrow" style={{ cursor: "default" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text size="sm" fw={600} truncate>{s.name}</Text>
        <Text size="xs" c="dimmed">
          {tc(s.minutes, s.increment)}{s.variant !== "chess" ? ` · ${variantLabel(s.variant)}` : ""} · {s.rounds} rounds · {s.status === "running" ? `round ${s.round}` : `starts in ${minutesLeft(s.startsAt - Date.now())}`} · {s.players ?? 0} players
        </Text>
      </div>
      {s.status === "running" && <Badge size="xs" color="green" variant="light">Live</Badge>}
      <Button size="xs" variant="default" loading={busy} disabled={!o.ready || !open}
        onClick={async () => { setBusy(true); try { await o.joinSwiss(s.id); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); } }}>{s.status === "running" ? "Join late" : "Join"}</Button>
    </div>
  );
}

/** Your team: its code to share, who's online, and joining or making one. */
function TeamPanel() {
  const o = useOnline();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string>();
  const [page, setPage] = useState(false);
  const run = async (what: string, f: () => Promise<void>) => {
    setBusy(what);
    try { await f(); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(undefined); }
  };
  if (!o.ready) return null;
  const t = o.team;
  return (
    <Panel title={<><IconUsers size={13} /> Team</>}>
      {t ? (
        <>
          <Group justify="space-between" wrap="nowrap">
            <div style={{ minWidth: 0 }}>
              <Text fw={700} truncate>{t.name}</Text>
              <Text size="xs" c="dimmed">Join code <b style={{ letterSpacing: 1 }}>{t.code}</b> · {t.members.length} member{t.members.length === 1 ? "" : "s"}</Text>
            </div>
            <Group gap={4} wrap="nowrap">
              <Tooltip label="Copy the join code"><ActionIcon size="sm" variant="subtle" color="gray" onClick={() => copyText(t.code)}><IconCopy size={13} /></ActionIcon></Tooltip>
              <Button size="compact-xs" variant="subtle" onClick={() => setPage(true)}>Team page</Button>
              <Button size="compact-xs" variant="subtle" color="red" loading={busy === "leave"} onClick={() => run("leave", o.leaveTeam)}>Leave</Button>
            </Group>
          </Group>
          <div style={{ marginTop: 6, maxHeight: 120, overflowY: "auto" }}>
            {t.members.map((m) => (
              <Group key={m.guest} gap={8} py={1} wrap="nowrap">
                <span className={"presence" + (m.online ? " on" : "")} />
                <Text size="sm" truncate fw={m.guest === o.profile?.id ? 700 : 400} style={{ cursor: "pointer" }} onClick={() => openProfile(m.guest)}>{m.name}{m.guest === o.profile?.id ? " (you)" : ""}</Text>
              </Group>
            ))}
          </div>
          <Text size="xs" c="dimmed" mt={4}>Take on other teams in a team battle: make an arena under Tournaments and add the teams' codes.</Text>
          <TeamModal opened={page} onClose={() => setPage(false)} />
        </>
      ) : (
        <>
          <Group gap={6} wrap="nowrap">
            <TextInput style={{ flex: 1 }} size="xs" placeholder="Join with a team code" value={code} onChange={(e) => setCode(e.currentTarget.value.toUpperCase())} />
            <Button size="xs" variant="default" disabled={code.length < 6} loading={busy === "join"} onClick={() => run("join", () => o.joinTeam(code))}>Join</Button>
          </Group>
          <Group gap={6} wrap="nowrap" mt={6}>
            <TextInput style={{ flex: 1 }} size="xs" placeholder="Or name a new team" maxLength={32} value={name} onChange={(e) => setName(e.currentTarget.value)} />
            <Button size="xs" variant="light" disabled={!name.trim()} loading={busy === "create"} onClick={() => run("create", () => o.createTeam(name))}>Create</Button>
          </Group>
        </>
      )}
    </Panel>
  );
}

function NewArena({ onDone }: { onDone: () => void }) {
  const o = useOnline();
  const [battle, setBattle] = useState(false);
  const [codes, setCodes] = useState(o.team?.code ?? "");
  const [leaders, setLeaders] = useState<number>(5);
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState(1);
  const [variant, setVariant] = useState<OnlineVariant>("chess");
  const [startsIn, setStartsIn] = useState<number>(5);
  const [duration, setDuration] = useState<number>(30);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <TextInput size="xs" label="Name" placeholder={`${o.name}'s arena`} value={title} maxLength={40} onChange={(e) => setTitle(e.currentTarget.value)} />
      <Group grow mt={6}>
        <Select size="xs" label="Time" value={String(preset)} allowDeselect={false} onChange={(v) => v && setPreset(Number(v))} data={PRESETS.map(([m, i, l], k) => ({ value: String(k), label: `${tc(m, i)} ${l}` }))} />
        <Select size="xs" label="Variant" value={variant} allowDeselect={false} onChange={(v) => v && setVariant(v as OnlineVariant)} data={ONLINE_VARIANTS} />
      </Group>
      <Group grow mt={6}>
        <NumberInput size="xs" label="Starts in (min)" min={0} max={120} value={startsIn} onChange={(v) => setStartsIn(Number(v) || 0)} />
        <NumberInput size="xs" label="Lasts (min)" min={10} max={180} value={duration} onChange={(v) => setDuration(Number(v) || 30)} />
      </Group>
      <Switch mt={8} size="xs" label="Team battle" checked={battle} onChange={(e) => setBattle(e.currentTarget.checked)} />
      {battle && (
        <Group grow mt={6} align="flex-end">
          <TextInput size="xs" label="Team codes, separated by commas" placeholder="ABC234, XYZ789" value={codes} onChange={(e) => setCodes(e.currentTarget.value.toUpperCase())} />
          <NumberInput size="xs" label="Best players who count" min={1} max={10} value={leaders} onChange={(v) => setLeaders(Number(v) || 5)} />
        </Group>
      )}
      <Button mt={8} size="xs" fullWidth loading={busy} onClick={async () => {
        setBusy(true);
        try {
          const teams = battle ? codes.split(/[\s,]+/).filter(Boolean) : undefined;
          await o.createArena({ title, minutes: PRESETS[preset][0], increment: PRESETS[preset][1], variant, startsIn, duration, teams, leaders: battle ? leaders : undefined });
          onDone();
        } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); }
      }}>Create and join</Button>
    </div>
  );
}

function NewSwiss({ onDone }: { onDone: () => void }) {
  const o = useOnline();
  const [title, setTitle] = useState("");
  const [preset, setPreset] = useState(2);
  const [variant, setVariant] = useState<OnlineVariant>("chess");
  const [rounds, setRounds] = useState<number>(5);
  const [startsIn, setStartsIn] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--border)" }}>
      <TextInput size="xs" label="Name" placeholder={`${o.name}'s Swiss`} value={title} maxLength={40} onChange={(e) => setTitle(e.currentTarget.value)} />
      <Group grow mt={6}>
        <Select size="xs" label="Time" value={String(preset)} allowDeselect={false} onChange={(v) => v && setPreset(Number(v))} data={PRESETS.map(([m, i, l], k) => ({ value: String(k), label: `${tc(m, i)} ${l}` }))} />
        <Select size="xs" label="Variant" value={variant} allowDeselect={false} onChange={(v) => v && setVariant(v as OnlineVariant)} data={ONLINE_VARIANTS} />
      </Group>
      <Group grow mt={6}>
        <NumberInput size="xs" label="Rounds" min={3} max={11} value={rounds} onChange={(v) => setRounds(Number(v) || 5)} />
        <NumberInput size="xs" label="Starts in (min)" min={1} max={1440} value={startsIn} onChange={(v) => setStartsIn(Number(v) || 10)} />
      </Group>
      <Button mt={8} size="xs" fullWidth loading={busy} onClick={async () => {
        setBusy(true);
        try {
          await o.createSwiss({ title, minutes: PRESETS[preset][0], increment: PRESETS[preset][1], variant, rounds, startsIn });
          onDone();
        } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(false); }
      }}>Create and join</Button>
    </div>
  );
}

/** Gold, silver and bronze once a tournament ends. */
function Podium({ names }: { names: string[] }) {
  const order = [1, 0, 2].filter((i) => names[i]);
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-end", gap: 8, margin: "10px 0 4px" }}>
      {order.map((i) => (
        <div key={i} style={{ textAlign: "center", width: 90 }}>
          <Text size="xs" truncate fw={700}>{names[i]}</Text>
          <div style={{ height: [64, 46, 34][i], borderRadius: "6px 6px 0 0", background: ["#d4a52a", "#a8acb3", "#b0753f"][i], display: "grid", placeItems: "center", color: "#fff", fontWeight: 800, fontSize: 20 }}>{i + 1}</div>
        </div>
      ))}
    </div>
  );
}

/** Standings and status for the arena this player is in. */
function ArenaPanel() {
  const o = useOnline();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const a = o.arena!;
  const now = Date.now();
  const over = now >= a.info.endsAt;
  const me = a.players.find((x) => x.guest === o.profile?.id);
  const status = now < a.info.startsAt ? `Starts in ${clock(a.info.startsAt - now)}`
    : over ? "The arena is over"
    : a.paused ? "Paused: you won't be paired" : a.status === "seated" ? "In a game" : "Waiting for a pairing…";
  return (
    <Panel title={<><IconTrophy size={13} /> {a.info.name}</>} right={<Text size="xs" c="dimmed">{!over && now >= a.info.startsAt ? `${clock(a.info.endsAt - now)} left` : ""}</Text>}>
      {over && (a.teams?.length ? <Podium names={a.teams.slice(0, 3).map((t) => t.name)} /> : a.players.length > 0 && <Podium names={a.players.slice(0, 3).map((p) => p.name)} />)}
      {a.teams && a.teams.length > 0 && (
        <div style={{ marginBottom: 8, padding: 8, borderRadius: 6, background: "var(--bg-raised)" }}>
          <Text size="xs" fw={700} mb={2}>Team battle · best {a.info.teamLeaders} of each team count</Text>
          {a.teams.map((t, i) => (
            <Group key={t.id} gap={8} wrap="nowrap" py={1} style={{ fontWeight: o.team?.id === t.id ? 800 : undefined }}>
              <Text size="xs" w={16} c="dimmed">{i + 1}</Text>
              <Text size="sm" style={{ flex: 1 }} truncate>{t.name}</Text>
              <Text size="xs" c="dimmed">{t.players} playing</Text>
              <Text size="sm" fw={700} w={30} ta="right">{t.score}</Text>
            </Group>
          ))}
        </div>
      )}
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Group gap={6}>{!a.paused && now >= a.info.startsAt && !over && a.status !== "seated" && <Loader size="xs" />}<Text fw={700} size="sm">{status}</Text></Group>
          <Text size="xs" c="dimmed">{tc(a.info.minutes, a.info.increment)}{a.info.variant !== "chess" ? ` · ${variantLabel(a.info.variant)}` : ""}{me ? ` · you: ${me.score} pts from ${me.games} games${me.streak >= 2 ? " 🔥" : ""}` : ""}</Text>
        </div>
        <Group gap={4} wrap="nowrap">
          {!over && <Button size="compact-xs" variant="default" onClick={() => o.pauseArena()}>{a.paused ? "Resume" : "Pause"}</Button>}
          <Button size="compact-xs" variant="default" color="red" onClick={() => o.leaveArena()}>{over ? "Close" : "Leave"}</Button>
        </Group>
      </Group>
      <div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto" }}>
        {a.players.slice(0, 30).map((x, i) => (
          <Group key={x.guest} gap={8} wrap="nowrap" py={2} style={{ fontWeight: x.guest === o.profile?.id ? 800 : undefined }}>
            <Text size="xs" w={18} c="dimmed">{i + 1}</Text>
            <span className={"presence" + (x.active ? " on" : "")} />
            <Text size="sm" style={{ flex: 1, cursor: "pointer" }} truncate onClick={() => openProfile(x.guest)}>{x.name}{x.streak >= 2 ? " 🔥" : ""}</Text>
            {x.playing && <IconSwords size={12} />}
            <Text size="xs" c="dimmed">{x.games}g</Text>
            <Text size="sm" fw={700} w={30} ta="right">{x.score}</Text>
          </Group>
        ))}
        {!a.players.length && <Text size="xs" c="dimmed">Nobody has joined yet.</Text>}
      </div>
      <Text size="xs" fw={600} mt="sm" mb={2}>Arena chat</Text>
      <Room lines={o.tourRoom} onSay={o.sayToTour} placeholder="Say something to the arena" empty="Everyone in the arena can talk here." height={90} />
    </Panel>
  );
}

/** A Swiss this player is in: round, pairings, standings and chat. */
function SwissPanel() {
  const o = useOnline();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const w = o.swiss!;
  const now = Date.now();
  const s = w.info;
  const status = s.status === "upcoming" ? `Starts in ${clock(s.startsAt - now)}`
    : s.status === "finished" ? "The tournament is over"
    : w.status === "bye" ? `Round ${s.round}: you have a bye (a point)` : w.status === "seated" ? `Round ${s.round}: in your game`
    : s.nextRoundAt ? `Round ${s.round + 1 > s.rounds ? s.round : s.round + 1} in ${Math.max(0, Math.ceil((s.nextRoundAt - now) / 1000))} s` : `Round ${s.round}: waiting for the other games`;
  return (
    <Panel title={<><IconTrophy size={13} /> {s.name}</>} right={<Text size="xs" c="dimmed">{s.status === "running" ? `Round ${s.round} of ${s.rounds}` : `${s.rounds} rounds`}</Text>}>
      {s.status === "finished" && w.standings.length > 0 && <Podium names={w.standings.slice(0, 3).map((p) => p.name)} />}
      <Group justify="space-between" wrap="nowrap">
        <div>
          <Text fw={700} size="sm">{status}</Text>
          <Text size="xs" c="dimmed">{tc(s.minutes, s.increment)}{s.variant !== "chess" ? ` · ${variantLabel(s.variant)}` : ""} · win 1, draw ½, bye 1</Text>
        </div>
        <Button size="compact-xs" variant="default" color="red" onClick={() => o.withdrawSwiss()}>{s.status === "finished" ? "Close" : "Withdraw"}</Button>
      </Group>
      {w.pairings.length > 0 && s.status === "running" && (
        <div style={{ marginTop: 8 }}>
          {w.pairings.map((g) => (
            <Group key={g.id} gap={6} wrap="nowrap" className="pressable" py={1} onClick={() => g.status !== "finished" && o.watch(g.id)}>
              <Text size="xs" style={{ flex: 1 }} truncate>{g.white} – {g.black}</Text>
              <Text size="xs" c="dimmed">{g.result ?? "playing"}</Text>
            </Group>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8, maxHeight: 160, overflowY: "auto" }}>
        {w.standings.map((x, i) => (
          <Group key={x.guest} gap={8} wrap="nowrap" py={2} style={{ fontWeight: x.guest === o.profile?.id ? 800 : undefined, opacity: x.withdrawn ? 0.5 : 1 }}>
            <Text size="xs" w={18} c="dimmed">{i + 1}</Text>
            <Text size="sm" style={{ flex: 1, cursor: "pointer" }} truncate onClick={() => openProfile(x.guest)}>{x.name}</Text>
            <Tooltip label="Buchholz: the sum of your opponents' scores"><Text size="xs" c="dimmed">{x.buchholz}</Text></Tooltip>
            <Text size="sm" fw={700} w={30} ta="right">{x.points}</Text>
          </Group>
        ))}
        {!w.standings.length && <Text size="xs" c="dimmed">Nobody has joined yet.</Text>}
      </div>
      <Text size="xs" fw={600} mt="sm" mb={2}>Tournament chat</Text>
      <Room lines={o.tourRoom} onSay={o.sayToTour} placeholder="Say something to the players" empty="Everyone in the tournament can talk here." height={90} />
    </Panel>
  );
}

/**
 * Reviews a finished game with the engine (Fairy-Stockfish for variants), turns
 * its mistakes into puzzles, and checks the opening against your repertoire.
 */
function useAutoReview(g: GameView, mine: Color | undefined) {
  const o = useOnline();
  const [state, setState] = useState<{ progress: number; summary?: ReviewSummary; tree?: GameTree; added?: number; error?: string; prep?: PrepCheck; note?: string }>();
  useEffect(() => {
    setState(undefined);
    if (!mine || g.status !== "finished" || g.result === "aborted") return;
    const tree = o.toTree(g);
    const prep = checkPrep(tree, mine);
    if (!o.autoReview || g.moves.length < 8) { if (prep) setState({ progress: 100, prep }); return; }
    const standard = rulesOfVariant(g.variant) === "chess";
    const entry = standard ? resolveEngine() : entryOf("fairy-stockfish")?.path ? entryOf("fairy-stockfish") : undefined;
    if (!entry) {
      setState({ progress: 100, prep, note: standard ? undefined : "Install Fairy-Stockfish on the Engines page to review variant games." });
      return;
    }
    let cancelled = false;
    let engine: Engine | undefined;
    (async () => {
      setState({ progress: 0, prep });
      engine = await launch(entry);
      const done = await reviewGame(tree, engine, 150, (d, n) => !cancelled && setState({ progress: (d / n) * 100, prep }), () => cancelled);
      engine.quit();
      engine = undefined;
      if (!done || cancelled) return;
      const summary = summarise(tree);
      const added = standard ? usePuzzles.getState().addMistakes(mistakePuzzles(tree, mine)) : 0;
      if (standard && summary) o.reportAccuracy(g.id, summary.accuracy.white, summary.accuracy.black);
      setState({ progress: 100, summary, tree, added, prep });
    })().catch((e) => !cancelled && setState({ progress: 0, error: e.message, prep }));
    return () => { cancelled = true; engine?.quit(); };
  }, [g.id, g.status, o.autoReview]); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

/** What the repertoire check found, with a way to act on it. */
function PrepNote({ prep, color }: { prep: PrepCheck; color: Color }) {
  const app = useApp();
  const rep = useRepertoire();
  const [added, setAdded] = useState(false);
  const text = prep.kind === "you"
    ? <>You left your repertoire at <b>{prep.moveLabel} {prep.played}</b>. Your prep has <b>{prep.expected.join(" or ")}</b>.</>
    : prep.kind === "them"
      ? <>Your opponent left your prep at <b>{prep.moveLabel} {prep.played}</b>; your repertoire doesn't cover it yet.</>
      : <>The game followed your repertoire for {Math.ceil(prep.depth / 2)} moves, to its end at {prep.moveLabel}.</>;
  return (
    <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: "var(--bg-raised)" }}>
      <Text size="xs" fw={700} mb={2}>Opening prep</Text>
      <Text size="xs">{text}</Text>
      <Group gap={6} mt={6}>
        {prep.kind === "you" && <Button size="compact-xs" variant="light" onClick={() => { rep.setColor(color); app.go("repertoire"); }}>Practise the line</Button>}
        {prep.kind === "them" && <Button size="compact-xs" variant="light" disabled={added} onClick={() => { rep.importTree(prep.line, color); setAdded(true); }}>{added ? "Added: choose your reply in Repertoire" : "Add this position to my repertoire"}</Button>}
      </Group>
    </div>
  );
}

/** Private notes on a game, saved on the server as you type (only your seat can read them). */
function Notes({ gameId }: { gameId: string }) {
  const o = useOnline();
  const [text, setText] = useState<string>();
  const [saved, setSaved] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => { setText(undefined); o.loadNotes().then(setText); }, [gameId]); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (v: string) => {
    setText(v);
    setSaved(false);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => o.saveNotes(v).then(() => setSaved(true)).catch(() => {}), 800);
  };
  return (
    <Panel title={<><IconNotes size={13} /> Notes</>} right={<Text size="xs" c="dimmed">{text === undefined ? "" : saved ? "Saved" : "Saving…"}</Text>}>
      <Textarea size="xs" autosize minRows={2} maxRows={8} placeholder="Plans, ideas, things to check. Only you can see these." disabled={text === undefined}
        value={text ?? ""} onChange={(e) => change(e.currentTarget.value)} />
    </Panel>
  );
}

/** Your mistakes from the review, with the move that was better. */
interface Slip { node: GNode; label: string; played: string; better: string; best: string; loss: string }
function slipsFor(tree: GameTree, mine: Color): Slip[] {
  return tree.mainline.filter((n) => (n.nag === 2 || n.nag === 4) && n.parent?.turn === mine && n.parent.best).map((n) => {
    const before = n.parent!;
    const ply = tree.mainline.indexOf(n);
    const better = sanLine(before.fen, [before.best!], tree.rules, 1).replace(/^\d+\.(\.\.)?\s*/, "");
    return {
      node: n, label: `${Math.floor(ply / 2) + 1}.${mine === "black" ? ".." : ""}`, played: n.san, better, best: before.best!,
      loss: before.eval && n.eval ? `${scoreText(before.eval)} → ${scoreText(n.eval)}` : "",
    };
  });
}

interface Floating { id: number; emoji: string; left: number }

/** An online game being played or watched. */
export function OnlineGame() {
  const o = useOnline();
  const app = useApp();
  const g = o.game!;
  const seat = o.seat?.id === g.id ? o.seat : undefined;
  const [flipped, setFlipped] = useState(false);
  const [message, setMessage] = useState("");
  const [chatTab, setChatTab] = useState<string>(seat ? "players" : "room");
  const [pending, setPending] = useState<string>();
  const [floating, setFloating] = useState<Floating[]>([]);
  const [reported, setReported] = useState(false);
  const [evalOn, setEvalOn] = useState<boolean>(load("onlineSpectatorEval", true));
  /** The mistake being shown on the board, from the review. */
  const [inspect, setInspect] = useState<number>();
  const seenRoom = useRef(0);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 200); return () => clearInterval(t); }, []);
  useEffect(() => { setPending(undefined); }, [g.ply, g.id]);
  const tree = useMemo(() => { const t = o.toTree(g); t.toEnd(); return t; }, [g.id, g.ply, g.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useTree(tree);
  const review = useAutoReview(g, seat?.color);
  const slips = useMemo(() => (review?.tree && seat ? slipsFor(review.tree, seat.color) : []), [review?.tree, seat?.color]); // eslint-disable-line react-hooks/exhaustive-deps
  const slip = inspect !== undefined ? slips[inspect] : undefined;
  useEffect(() => setInspect(undefined), [g.id]);

  // Spectators see the engine's view, three moves behind while the game is on, so players can't use it.
  const DELAY = 3;
  const evalNode = g.status === "playing" ? tree.mainline[tree.mainline.length - 1 - DELAY] ?? tree.root : tree.last;
  const spectating = !seat && evalOn && tree.rules === "chess";
  const { score } = useSpectatorEngine(spectating ? evalNode.fen : undefined, spectating);

  // New reactions float up over the board.
  useEffect(() => {
    const fresh = o.room.filter((l) => l.kind === "react" && l.id > seenRoom.current && Date.now() - l.at < 15_000);
    if (o.room.length) seenRoom.current = Math.max(seenRoom.current, ...o.room.map((l) => l.id));
    if (!fresh.length || o.hideRoom) return;
    const add = fresh.map((l) => ({ id: l.id, emoji: l.text, left: 10 + Math.random() * 80 }));
    setFloating((f) => [...f, ...add]);
    setTimeout(() => setFloating((f) => f.filter((x) => !add.includes(x))), 2800);
  }, [o.room]); // eslint-disable-line react-hooks/exhaustive-deps

  const mine: Color | undefined = seat?.color;
  const opponent = mine ? other(mine) : undefined;
  const bottom: Color = (mine ?? "white") === "white" ? (flipped ? "black" : "white") : flipped ? "white" : "black";
  const top: Color = other(bottom);
  const turn: Color = g.ply % 2 === 0 ? "white" : "black";
  const clocks = shownClocks(g, o.receivedAt);
  const atEnd = tree.current === tree.last;
  const canMove = !!mine && g.status === "playing" && turn === mine && atEnd && !pending;
  const canPremove = !!mine && g.status === "playing" && turn !== mine && atEnd && !g.days;

  // With move confirmation on (always, in correspondence), the board shows the move waiting to be sent.
  const confirm = o.confirmMoves || !!g.days;
  const shown = useMemo(() => {
    if (!pending) return { fen: tree.fen, lastMove: tree.current.lastMove };
    const t = tree.clone();
    t.toEnd();
    return t.play(pending) ? { fen: t.fen, lastMove: t.current.lastMove } : { fen: tree.fen, lastMove: tree.current.lastMove };
  }, [pending, tree]);

  const slipShapes: Shape[] | undefined = slip ? [
    { from: slip.best.slice(0, 2), to: slip.best.slice(2, 4), color: "green" },
    ...(slip.node.lastMove ? [{ from: slip.node.lastMove[0], to: slip.node.lastMove[1], color: "red" as const }] : []),
  ] : undefined;
  const sendMove = (uci: string) => (confirm ? setPending(uci) : o.move(uci));
  useEffect(() => {
    if (!pending) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter") { o.move(pending); setPending(undefined); }
      if (e.key === "Escape") setPending(undefined);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Material ahead, from the position on the board (so it follows you through the moves).
  const balance = materialBalance(shown.fen);
  const strip = (c: Color) => {
    const s = g[c];
    const change = s.after != null && s.rating != null ? s.after - s.rating : undefined;
    const rating = s.rating != null ? `${s.rating}${change !== undefined ? ` ${change >= 0 ? "+" : ""}${change}` : ""}` : "";
    const corrLeft = g.days && g.status === "playing" && g.running && turn === c ? ` · ${daysLeft(clocks[c])} to move` : "";
    return (
      <PlayerStrip name={`${s.name ?? (g.status === "waiting" ? (o.challenging ? `Waiting for ${o.challenging.name}…` : "Waiting for an opponent…") : "?")}${g.berserk?.[c] ? " ⚔" : ""}`} color={c}
        detail={(rating + corrLeft) || undefined}
        clock={g.status === "waiting" || g.days ? undefined : clocks[c] / 1000} active={g.status === "playing" && turn === c}
        material={c === "white" ? Math.max(0, balance) : Math.max(0, -balance)} />
    );
  };

  const opponentOffers = g.drawOffer && g.drawOffer !== mine && g.status === "playing";
  const iOffered = g.drawOffer && g.drawOffer === mine;
  const queued = !!o.queue && g.status === "waiting";
  const range = ratingWindow(Date.now() - (o.queuedAt ?? Date.now()));
  const variant = g.variant && g.variant !== "chess" ? variantLabel(g.variant) : undefined;
  const resultText = g.status === "finished" ? (g.result === "aborted" ? "Game aborted" : `${g.result} · ${g.reason}`)
    : queued ? "Looking for an opponent…"
    : g.status === "waiting" ? (o.challenging ? `Challenge sent to ${o.challenging.name}` : g.days ? "Your seek is in the lobby" : `Share the code ${g.code}`)
    : g.running ? `${turn === "white" ? "White" : "Black"} to move` : "White to move; the clock starts after the first move";

  // The opponent has gone quiet: count down to when the game can be claimed.
  const away = opponent && g.status === "playing" && g.away?.[opponent] != null ? g.away[opponent]! + (Date.now() - o.receivedAt) : 0;
  const gone = away > 8000;
  const claimable = away >= ABANDON_MS && g.ply >= 2;

  const opp = opponent ? g[opponent] : undefined;
  const botGame = isBot(opp?.guest);
  // Chat goes straight to the opponent when connected directly, and through the server when relayed.
  const canChat = !botGame && (o.link === "direct" || o.link === "relay");
  const oppGuest = opp?.guest && opp.guest !== o.profile?.id && !botGame ? opp.guest : undefined;
  const canFriend = !!oppGuest && !o.friends.some((f) => f.id === oppGuest);
  const arenaBreak = g.arena && o.arena?.info.id === g.arena && g.status === "finished" && seat ? Math.max(0, ARENA_BREAK_MS - (Date.now() - (o.endedAt ?? 0))) : undefined;
  const casual = !!seat && !g.rated && !g.arena && !g.swiss;
  const canBerserk = !!seat && !!g.arena && g.status === "playing" && !g.berserk?.[mine!] && (mine === "white" ? g.ply === 0 : g.ply <= 1);
  const roomTalk = o.room.filter((l) => l.kind === "text");
  const showRoom = !o.hideRoom;

  return (
    <div className="page">
      <div className="boardcol">
        {strip(top)}
        <div className="boardrow" style={{ position: "relative" }}>
          {spectating && <EvalBar score={score} flipped={bottom === "black"} />}
          <Board fen={slip ? slip.node.parent!.fen : shown.fen} rules={tree.rules} chess960={tree.chess960} orientation={bottom}
            lastMove={slip ? slip.node.parent!.lastMove : shown.lastMove} movable={canMove && !slip ? mine : undefined} shapes={slipShapes}
            onMove={(m) => { const pos = positionOf(tree.fen, tree.rules); sendMove(uciOf(pos, m, tree.chess960)); }}
            premove={canPremove ? { color: mine!, onSet: (a, b) => o.setPremove([a, b]), onUnset: () => o.setPremove(undefined) } : undefined} />
          <div className="reactions">{floating.map((f) => <span key={f.id} className="reaction" style={{ left: `${f.left}%` }}>{f.emoji}</span>)}</div>
        </div>
        {strip(bottom)}
      </div>
      <div className="sidecol">
        <Panel title={<>{o.tv && !seat ? <IconDeviceTv size={13} /> : seat ? <IconSwords size={13} /> : <IconEye size={13} />} {o.tv && !seat ? "Castle TV" : seat ? (g.status === "finished" ? "Finished" : g.status === "waiting" ? "Waiting" : "Playing") : "Watching"} · {speed(g)}{variant ? ` · ${variant}` : ""} · {g.arena ? "arena" : g.swiss ? `Swiss round ${g.round}` : g.rated ? "rated" : "casual"}</>}
          right={seat && !g.days && (o.offline ? (
            <Badge variant="light" color="red" leftSection={<IconWifiOff size={11} />}>Reconnecting</Badge>
          ) : (
            <Tooltip label={o.link === "direct" ? "Moves go straight to your opponent" : o.link === "relay" ? "No direct connection: moves go through Castle's server" : "Connecting to your opponent…"}>
              <Badge variant="light" color={o.link === "direct" ? "green" : o.link === "relay" ? "yellow" : "gray"} leftSection={<IconPlugConnected size={11} />}>{o.link === "direct" ? "Direct" : o.link === "relay" ? "Relayed" : "Connecting"}</Badge>
            </Tooltip>
          ))}>
          <Group gap={8} wrap="nowrap">{(queued || (o.challenging && g.status === "waiting")) && <Loader size="xs" />}<Text fw={700}>{resultText}</Text></Group>
          {queued && o.bots.length > 0 && (
            <Button mt={6} size="xs" variant="subtle" leftSection={<IconRobot size={13} />}
              onClick={async () => { const q = o.queue!; await o.leaveQueue(); await o.playBot("amara", { minutes: q.minutes, increment: q.increment, color: "random", variant: q.variant === "chess960" ? "chess960" : "chess" }).catch((e) => useOnline.setState({ error: e.message })); }}>
              Play a bot instead
            </Button>
          )}
          {queued ? <Text size="sm" c="dimmed">In the queue for {tc(o.queue!.minutes, o.queue!.increment)} {variantLabel(o.queue!.variant)}, {o.queue!.rated ? "rated" : "casual"}. {range === Infinity ? "Open to any rating now." : `Looking within ±${range} of your rating.`}</Text>
            : g.status === "waiting" && !o.challenging && <Text size="sm" c="dimmed">{g.days ? "It stays listed for three days. You can leave this screen: the game shows up under Correspondence when someone accepts." : g.public ? "Anyone in the lobby can take it." : "Only someone with the code can join."}{g.days ? "" : " It starts as soon as they join."}</Text>}
          {pending && (
            <Alert mt={8} p="xs" color="blue">
              <Text size="sm">Send this move?</Text>
              <Group gap={6} mt={4}>
                <Button size="xs" onClick={() => { o.move(pending); setPending(undefined); }}>Confirm ⏎</Button>
                <Button size="xs" variant="default" onClick={() => setPending(undefined)}>Take back ⎋</Button>
              </Group>
            </Alert>
          )}
          {o.premove && canPremove && <Text size="xs" c="dimmed" mt={4}>Premove {o.premove[0]}–{o.premove[1]} queued.</Text>}
          {canBerserk && (
            <Tooltip label="Halve your clock and give up the increment. Win, and you get an extra point.">
              <Button mt={8} size="xs" color="orange" variant="light" leftSection={<IconFlame size={14} />} onClick={() => o.act("berserk")}>Berserk</Button>
            </Tooltip>
          )}
          {gone && (
            <Alert mt={8} p="xs" color="orange" icon={<IconWifiOff size={16} />}>
              <Text size="sm">{opp?.name ?? "Your opponent"} has left the game.</Text>
              {claimable ? (
                <Group gap={6} mt={4}>
                  <Button size="xs" color="orange" onClick={() => o.act("claim")}>Claim victory</Button>
                  <Button size="xs" variant="default" onClick={() => o.act("claim-draw")}>Call it a draw</Button>
                </Group>
              ) : <Text size="xs" c="dimmed">{g.ply < 2 ? "If they don't move, the game is aborted." : `You can claim the game in ${Math.ceil((ABANDON_MS - away) / 1000)} s if they don't come back.`}</Text>}
            </Alert>
          )}
          {o.error && <Text size="xs" c="red" mt={4}>{o.error}</Text>}
          {seat && (
            <Group gap={6} mt={8}>
              {g.status === "waiting" && <Button size="xs" variant="default" onClick={() => o.leaveQueue()}>{queued ? "Leave queue" : o.challenging ? "Withdraw" : "Cancel"}</Button>}
              {g.status === "playing" && g.ply < 2 && !g.swiss && <Button size="xs" variant="default" onClick={() => o.act("abort")}>Abort</Button>}
              {g.status === "playing" && g.ply >= 2 && <Button size="xs" variant="default" color="red" leftSection={<IconFlag size={13} />} onClick={() => o.act("resign")}>Resign</Button>}
              {g.status === "playing" && g.ply >= 2 && !opponentOffers && <Button size="xs" variant="default" disabled={!!iOffered} leftSection={<IconHandStop size={13} />} onClick={() => o.act("draw")}>{iOffered ? "Draw offered" : "Offer draw"}</Button>}
              {opponentOffers && <><Button size="xs" onClick={() => o.act("draw")}>Accept draw</Button><Button size="xs" variant="default" onClick={() => o.act("decline")}>Decline</Button></>}
              {casual && g.status === "playing" && g.takeback && g.takeback !== mine && (
                <><Button size="xs" color="teal" onClick={() => o.takeback()}>Allow takeback</Button><Button size="xs" variant="default" onClick={() => o.declineTakeback()}>Refuse</Button></>
              )}
              {casual && g.status === "playing" && g.takeback !== opponent && g.ply >= (mine === "white" ? 1 : 2) && (
                <Tooltip label="Ask to take back your last move"><Button size="xs" variant="default" disabled={g.takeback === mine} leftSection={<IconArrowBackUp size={13} />} onClick={() => o.takeback()}>{g.takeback === mine ? "Takeback asked" : "Takeback"}</Button></Tooltip>
              )}
              {g.status === "finished" && botGame && <Button size="xs" onClick={() => o.playBot(String(opp?.guest).slice(4), { minutes: g.minutes, increment: g.increment, color: mine === "white" ? "black" : "white", variant: g.variant === "chess960" ? "chess960" : "chess" }).catch((e) => useOnline.setState({ error: e.message }))}>Play again</Button>}
              {g.status === "finished" && !g.arena && !g.swiss && !g.simul && !botGame && <Button size="xs" onClick={() => o.act("rematch")}>{g.rematch ? "Accept rematch" : "Rematch"}</Button>}
              {oppGuest && g.status !== "waiting" && (
                <Menu position="bottom-end" withinPortal>
                  <Menu.Target><ActionIcon size="md" variant="subtle" color="gray" aria-label="More about your opponent"><IconDots size={15} /></ActionIcon></Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Label>{opp?.name}</Menu.Label>
                    <Menu.Item onClick={() => openProfile(oppGuest)}>View profile</Menu.Item>
                    {canFriend && <Menu.Item leftSection={<IconUserPlus size={14} />} onClick={() => o.addFriend({ id: oppGuest, name: opp?.name ?? "Friend" })}>Add as a friend</Menu.Item>}
                    <Menu.Item leftSection={<IconBan size={14} />} color="red" onClick={() => o.block(oppGuest)}>Block</Menu.Item>
                    <Menu.Divider />
                    <Menu.Label>{reported ? "Thanks: the report was sent" : "Report"}</Menu.Label>
                    {!reported && [["chat", "Rude or abusive chat"], ["cheating", "Cheating (engine help)"], ["name", "Offensive name"], ["stalling", "Stalling or leaving games"]].map(([value, label]) => (
                      <Menu.Item key={value} onClick={() => o.report(oppGuest, value).then(() => setReported(true)).catch((e) => useOnline.setState({ error: e.message }))}>{label}</Menu.Item>
                    ))}
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          )}
          {arenaBreak !== undefined && <Text size="sm" mt={6} c="dimmed">{arenaBreak > 0 ? `Next arena pairing in ${Math.ceil(arenaBreak / 1000)} s…` : "Looking for your next arena opponent…"}</Text>}
          {g.status === "finished" && seat && g.rated && g[seat.color].after != null && o.profile && g.category && (
            <Text size="sm" mt={6}>Your {CATEGORY_LABELS[g.category]?.toLowerCase() ?? ""} rating is now <b>{ratingFor(o.profile, g.category)}</b>.</Text>
          )}
          {!seat && spectating && g.status === "playing" && <Text size="xs" c="dimmed" mt={4}>The evaluation runs three moves behind the game.</Text>}
          {o.tv && !seat && (
            <Select mt={8} size="xs" label="Channel" value={o.tvChannel} allowDeselect={false} onChange={(v) => v && o.watchTV(v)}
              data={TV_CHANNELS.map((c) => ({ value: c, label: c === "all" ? "Top game" : CATEGORY_LABELS[c] ?? c }))} />
          )}
        </Panel>
        {review && (review.prep || review.progress < 100 || review.summary || review.error || review.note) && (
          <Panel title="Game review">
            {review.error ? <Text size="xs" c="red">{review.error}</Text> : review.progress < 100 ? (
              <>
                <Text size="xs" c="dimmed">Checking every move with the engine…</Text>
                <Progress mt={6} size="sm" value={review.progress} animated />
              </>
            ) : review.summary && mine ? (
              <>
                <Group grow>
                  {([mine, other(mine)] as Color[]).map((c) => (
                    <div key={c}>
                      <Text size="xs" c="dimmed">{c === mine ? "You" : g[c].name}</Text>
                      <Text fw={800} fz={20} ff="ui-rounded, system-ui">{review.summary!.accuracy[c] !== undefined ? `${Math.round(review.summary!.accuracy[c]!)}%` : "–"}</Text>
                      <Text size="xs" c="dimmed">{review.summary!.blunders[c]} blunders · {review.summary!.mistakes[c]} mistakes · {review.summary!.inaccuracies[c]} inaccuracies</Text>
                    </div>
                  ))}
                </Group>
                {!!review.added && <Text size="xs" mt={6}>{review.added} of your mistakes are now puzzles under Puzzles, My mistakes.</Text>}
                {slips.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Text size="xs" fw={700} mb={2}>What you should have played</Text>
                    {slip ? (
                      <div style={{ padding: 8, borderRadius: 6, background: "var(--bg-raised)" }}>
                        <Text size="sm">At <b>{slip.label}</b> you played <b style={{ color: "#e5534b" }}>{slip.played}</b>; <b style={{ color: "#3fb950" }}>{slip.better}</b> was better.</Text>
                        {slip.loss && <Text size="xs" c="dimmed">Evaluation {slip.loss}</Text>}
                        <Group gap={4} mt={6}>
                          <Button size="compact-xs" variant="default" disabled={inspect === 0} onClick={() => setInspect((inspect ?? 0) - 1)}>Previous</Button>
                          <Button size="compact-xs" variant="default" disabled={inspect === slips.length - 1} onClick={() => setInspect((inspect ?? 0) + 1)}>Next</Button>
                          <Button size="compact-xs" variant="subtle" onClick={() => setInspect(undefined)}>Back to the game</Button>
                        </Group>
                      </div>
                    ) : (
                      <Group gap={4}>
                        {slips.map((x, i) => <Button key={i} size="compact-xs" variant="light" color={x.node.nag === 4 ? "red" : "orange"} onClick={() => setInspect(i)}>{x.label} {x.played}</Button>)}
                      </Group>
                    )}
                  </div>
                )}
                <Button mt={8} size="xs" variant="light" onClick={() => review.tree && app.openGame(review.tree)}>Open the review</Button>
              </>
            ) : review.note ? <Text size="xs" c="dimmed">{review.note}</Text> : null}
            {review.prep && mine && <PrepNote prep={review.prep} color={mine} />}
          </Panel>
        )}
        {o.simul && o.simul.info.host === o.profile?.id && o.simul.info.status !== "open" && <SimulPanel />}
        <Panel grow pad={false} title="Moves"><MoveList tree={tree} editable={false} /></Panel>
        {seat && g.status !== "waiting" && <Notes gameId={g.id} />}
        {(seat || showRoom) && (
          <Panel title={seat && showRoom ? (
            <SegmentedControl size="xs" value={chatTab} onChange={setChatTab} data={[{ value: "players", label: "Opponent" }, { value: "room", label: `Spectators${roomTalk.length ? ` (${roomTalk.length})` : ""}` }]} />
          ) : seat ? "Opponent" : "Spectators"}>
            {(chatTab === "players" || !showRoom) && seat ? (
              o.muteOpponent ? <Text size="xs" c="dimmed">Chat with opponents is off (Options).</Text> : (
                <>
                  <div style={{ maxHeight: 130, overflowY: "auto" }} className="selectable">
                    {o.chat.length ? o.chat.map((c, i) => (
                      <Text key={i} size="sm" c={c.from === "system" ? "dimmed" : undefined}>{c.from === "system" ? c.text : <><b>{c.from === mine ? "You" : g[c.from].name}:</b> {c.text}</>}</Text>
                    )) : <Text size="xs" c="dimmed">{botGame ? "Bots don't chat." : o.link === "direct" ? "Say hello. Chat goes directly to your opponent." : o.link === "relay" ? "Say hello. Chat goes through Castle's server, like the moves." : "Chat opens once you're connected."}</Text>}
                  </div>
                  <Group gap={6} mt={6} wrap="nowrap">
                    <TextInput style={{ flex: 1 }} size="xs" placeholder="Message" disabled={!canChat} value={message} onChange={(e) => setMessage(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === "Enter") { o.say(message); setMessage(""); } }} />
                    <Button size="xs" variant="default" disabled={!canChat} onClick={() => { o.say(message); setMessage(""); }}><IconSend size={13} /></Button>
                  </Group>
                </>
              )
            ) : (
              <Room lines={o.room} onSay={(t) => o.sayToRoom(t)} placeholder="Say something to the room" empty={`Anyone watching can talk here${seat ? "; your opponent can read it too" : ""}.`} />
            )}
            {showRoom && (
              <Group gap={2} mt={6}>
                {REACTIONS.map((r) => <button key={r} className="react-button" onClick={() => o.sayToRoom(r, "react")}>{r}</button>)}
              </Group>
            )}
          </Panel>
        )}
        <div style={{ padding: 12, display: "flex", gap: 6 }}>
          <Button variant="default" style={{ flex: 1 }} onClick={() => setFlipped(!flipped)}>Flip</Button>
          <Menu position="top" withinPortal>
            <Menu.Target><Button variant="default" style={{ flex: 1 }} leftSection={<IconShare2 size={14} />} disabled={g.status === "waiting"}>Share</Button></Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconLink size={14} />} onClick={() => copyShareLink(g.code)}>Copy a link to this game</Menu.Item>
              <Menu.Item leftSection={<IconCopy size={14} />} onClick={() => copyPgn(o.toTree(g))}>Copy PGN</Menu.Item>
              <Menu.Item leftSection={<IconFileDownload size={14} />} onClick={() => savePgn(o.toTree(g))}>Save PGN…</Menu.Item>
              <Menu.Item leftSection={<IconGif size={14} />} disabled={!g.moves.length} onClick={() => saveGif(o.toTree(g), bottom === "black").catch((e) => useOnline.setState({ error: e.message }))}>Save as animated GIF…</Menu.Item>
              <Menu.Divider />
              <Menu.Item onClick={() => app.openGame(o.toTree(g))} disabled={!g.moves.length}>Analyse</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {o.tv && !seat ? (
            <Button variant="default" style={{ flex: 1 }} leftSection={<IconPlayerSkipForward size={14} />} onClick={() => o.watchTV()}>Next</Button>
          ) : null}
          <Button variant="default" style={{ flex: 1 }} disabled={!!seat && g.status === "playing" && !g.days} onClick={() => (seat && g.status === "waiting" && !g.days ? o.leaveQueue() : o.leave())}>Back</Button>
        </div>
        {!seat && tree.rules === "chess" && (
          <div style={{ padding: "0 12px 12px" }}>
            <Switch size="xs" label="Engine evaluation" checked={evalOn} onChange={(e) => { setEvalOn(e.currentTarget.checked); save("onlineSpectatorEval", e.currentTarget.checked); }} />
          </div>
        )}
      </div>
    </div>
  );
}
