import { Badge, Button, Group, Loader, Modal, NumberInput, SegmentedControl, Select, Text, TextInput, Tooltip } from "@mantine/core";
import { IconCopy, IconDeviceMobile, IconRobot, IconSwords, IconTrophy, IconUsers } from "@tabler/icons-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { create } from "zustand";
import {
  BotInfo, CATEGORY_LABELS, GameView, ONLINE_API, ONLINE_VARIANTS, OnlineVariant, PublicProfile, SimulInfo, tc, TeamPage, useOnline, variantLabel,
} from "../lib/online";
import { copyText } from "../lib/storage";
import { useApp } from "../lib/store";
import { Panel } from "./common";

const SITE = ONLINE_API.replace(/\/api$/, "");
const run = async (setBusy: (v?: string) => void, what: string, f: () => Promise<unknown>) => {
  setBusy(what);
  try { await f(); } catch (e: any) { useOnline.setState({ error: e.message }); } finally { setBusy(undefined); }
};

/* ───────── Profiles ───────── */

const useProfile = create<{ guest?: string }>(() => ({}));
/** Opens a player's profile anywhere in Castle. */
export const openProfile = (guest?: string | null) => { if (guest && !guest.startsWith("bot:")) useProfile.setState({ guest }); };

export function ProfileModal() {
  const guest = useProfile((s) => s.guest);
  const o = useOnline();
  const app = useApp();
  const [p, setP] = useState<PublicProfile>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setP(undefined); setError(undefined);
    if (guest) o.profileOf(guest).then(setP).catch((e) => setError(e.message));
  }, [guest]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => useProfile.setState({ guest: undefined });
  const ratings = Object.entries(p?.ratings ?? {}).sort((a, b) => b[1].g - a[1].g);
  const me = guest === o.profile?.id;
  const friend = !!p && o.friends.some((f) => f.id === p.guest);
  return (
    <Modal opened={!!guest} onClose={close} size="lg" title={p ? <Group gap={8}><span className={"presence" + (p.online ? " on" : "")} /><Text fw={800}>{p.name}</Text>{p.team && <Badge size="sm" variant="light">{p.team}</Badge>}</Group> : "Player"}>
      {error ? <Text c="red" size="sm">{error}</Text> : !p ? <Loader size="sm" /> : (
        <>
          <Text size="xs" c="dimmed">{p.games} games · {p.wins} won · {p.draws} drawn · {p.losses} lost · playing since {new Date(p.since).toLocaleDateString()}</Text>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8, marginTop: 10 }}>
            {(ratings.length ? ratings : [["blitz", { r: p.rating, g: 0, p: p.rating }] as const]).map(([c, r]) => (
              <div key={c} className="card" style={{ padding: 8 }}>
                <Text size="xs" c="dimmed">{CATEGORY_LABELS[c] ?? c}</Text>
                <Text fw={800} fz={20} ff="ui-rounded, system-ui">{r.r}</Text>
                <Text size="xs" c="dimmed">{r.g} games</Text>
              </div>
            ))}
          </div>
          {p.trophies.length > 0 && (
            <>
              <Text fw={700} size="sm" mt="md" mb={4}><IconTrophy size={13} style={{ verticalAlign: -2 }} /> Trophies</Text>
              {p.trophies.slice(0, 8).map((t, i) => <Text key={i} size="sm">{["🥇", "🥈", "🥉"][t.rank - 1]} {t.name} <Text span size="xs" c="dimmed">{t.kind === "arena" ? `${t.score} points` : `${t.score} in the Swiss`} · {new Date(t.at).toLocaleDateString()}</Text></Text>)}
            </>
          )}
          <Text fw={700} size="sm" mt="md" mb={4}>Recent games</Text>
          {p.recent.length ? p.recent.map((g: GameView) => (
            <div key={g.id} className="listrow" onClick={() => { app.openGame(o.toTree(g)); close(); }}>
              <Text size="sm" style={{ flex: 1 }} truncate><b>{g.white.name}</b> – <b>{g.black.name}</b></Text>
              <Text size="xs" c="dimmed">{g.result} · {g.reason}</Text>
            </div>
          )) : <Text size="xs" c="dimmed">None yet.</Text>}
          <Group mt="md" gap={6}>
            {!me && !friend && <Button size="xs" variant="light" onClick={() => o.addFriend({ id: p.guest, name: p.name })}>Add as a friend</Button>}
            <Button size="xs" variant="default" leftSection={<IconCopy size={13} />} onClick={() => copyText(`${SITE}/p/${p.guest}`)}>Copy profile link</Button>
          </Group>
        </>
      )}
    </Modal>
  );
}

/* ───────── Team page ───────── */

export function TeamModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const o = useOnline();
  const [t, setT] = useState<TeamPage | null>();
  const [text, setText] = useState("");
  useEffect(() => {
    if (!opened) return;
    o.teamPage().then((team) => { setT(team); if (team) o.setExtraRooms([team.room]); }).catch(() => setT(null));
    return () => o.setExtraRooms([]);
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  const [lines, setLines] = useState<{ id: number; name: string; text: string }[]>([]);
  useEffect(() => {
    if (!t) return;
    let live = true;
    const load = () => fetch(`${ONLINE_API}/chat?id=${encodeURIComponent(t.room)}&after=0`).then((r) => r.json()).then((d) => live && setLines(d.lines.filter((l: any) => l.kind === "text"))).catch(() => {});
    load();
    const timer = setInterval(load, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [t?.room]); // eslint-disable-line react-hooks/exhaustive-deps
  const say = async () => {
    if (!t || !text.trim()) return;
    await o.sayToTeam(t.room, text);
    setText("");
    setLines((l) => [...l, { id: Date.now(), name: o.name, text }]);
  };
  return (
    <Modal opened={opened} onClose={onClose} size="lg" title={<Text fw={800}>{t?.name ?? "Team"}</Text>}>
      {t === undefined ? <Loader size="sm" /> : !t ? <Text size="sm" c="dimmed">You're not in a team.</Text> : (
        <>
          <Text size="xs" c="dimmed">Join code <b>{t.code}</b> · {t.members.length} members</Text>
          <Text fw={700} size="sm" mt="md" mb={4}><IconUsers size={13} style={{ verticalAlign: -2 }} /> Members</Text>
          {t.members.slice().sort((a, b) => b.rating - a.rating).map((m) => (
            <div key={m.guest} className="listrow" onClick={() => openProfile(m.guest)}>
              <span className={"presence" + (m.online ? " on" : "")} />
              <Text size="sm" style={{ flex: 1 }}>{m.name}</Text>
              <Text size="xs" c="dimmed">{m.category ? CATEGORY_LABELS[m.category] : ""}</Text>
              <Text fw={700} w={44} ta="right">{m.rating}</Text>
            </div>
          ))}
          <Text fw={700} size="sm" mt="md" mb={4}><IconTrophy size={13} style={{ verticalAlign: -2 }} /> Team battles</Text>
          {t.battles.length ? t.battles.map((b) => (
            <Group key={b.id} gap={8} py={2}><Text size="sm" style={{ flex: 1 }}>{b.name}</Text><Text size="xs" c="dimmed">{b.endsAt < Date.now() ? `${["1st", "2nd", "3rd"][b.rank - 1] ?? `${b.rank}th`} of ${b.teams}` : "in progress"}</Text><Text size="sm" fw={700}>{b.score}</Text></Group>
          )) : <Text size="xs" c="dimmed">No battles yet: make one under Tournaments → Arenas → Team battle.</Text>}
          <Text fw={700} size="sm" mt="md" mb={4}>Team chat</Text>
          <div style={{ maxHeight: 160, overflowY: "auto" }} className="selectable">
            {lines.length ? lines.map((l) => <Text key={l.id} size="sm"><b>{l.name}:</b> {l.text}</Text>) : <Text size="xs" c="dimmed">Only members can read this.</Text>}
          </div>
          <Group gap={6} mt={6} wrap="nowrap">
            <TextInput style={{ flex: 1 }} size="xs" placeholder="Message the team" maxLength={200} value={text} onChange={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && say()} />
            <Button size="xs" variant="default" onClick={say}>Send</Button>
          </Group>
        </>
      )}
    </Modal>
  );
}

/* ───────── Phone alerts ───────── */

export function PhoneAlerts() {
  const o = useOnline();
  const [link, setLink] = useState<{ code: string; url: string; qr: string }>();
  const [devices, setDevices] = useState<number>();
  const [busy, setBusy] = useState<string>();
  useEffect(() => { o.alertDevices().then(setDevices).catch(() => {}); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const make = () => run(setBusy, "code", async () => {
    const c = await o.alertsCode();
    setLink({ ...c, qr: await QRCode.toDataURL(c.url, { margin: 1, width: 180 }) });
  });
  return (
    <>
      <Text fw={700} size="sm" mt="lg"><IconDeviceMobile size={14} style={{ verticalAlign: -2 }} /> Phone alerts</Text>
      <Text size="xs" c="dimmed">Get a notification on your phone for correspondence moves and challenges, even when Castle is closed.{devices ? ` ${devices} device${devices > 1 ? "s" : ""} linked.` : ""}</Text>
      {link ? (
        <Group mt={8} align="flex-start" wrap="nowrap">
          <img src={link.qr} width={140} height={140} alt="QR code for phone alerts" style={{ borderRadius: 6, background: "#fff" }} />
          <div>
            <Text size="xs">Scan this with your phone's camera, or open <b>{SITE.replace("https://", "")}/alerts</b> and enter <b style={{ letterSpacing: 1 }}>{link.code}</b>. It works for 30 minutes.</Text>
            <Text size="xs" c="dimmed" mt={4}>On iPhone, add the page to your Home Screen when it asks, then open it from there.</Text>
            <Group gap={4} mt={6}>
              <Button size="compact-xs" variant="default" onClick={() => copyText(link.url)}>Copy link</Button>
              <Button size="compact-xs" variant="default" onClick={() => o.alertDevices().then(setDevices)}>Refresh</Button>
            </Group>
          </div>
        </Group>
      ) : <Button mt={6} size="xs" variant="light" loading={busy === "code"} onClick={make}>Link a phone</Button>}
      {!!devices && (
        <Group gap={6} mt={6}>
          <Button size="compact-xs" variant="default" loading={busy === "test"} onClick={() => run(setBusy, "test", () => o.testAlert())}>Send a test alert</Button>
          <Button size="compact-xs" variant="subtle" color="red" loading={busy === "clear"} onClick={() => run(setBusy, "clear", async () => setDevices(await o.alertDevices(true)))}>Remove all devices</Button>
        </Group>
      )}
    </>
  );
}

/* ───────── Bots ───────── */

export function BotsPanel({ minutes, increment, variant }: { minutes: number; increment: number; variant: OnlineVariant }) {
  const o = useOnline();
  const [busy, setBusy] = useState<string>();
  const [color, setColor] = useState("random");
  useEffect(() => { if (o.ready && !o.bots.length) o.refreshBots(); }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok960 = variant === "chess" || variant === "chess960";
  return (
    <Panel title={<><IconRobot size={13} /> Play a bot</>}>
      <Text size="xs" c="dimmed" mb={6}>Castle's personalities, running on the server. Always available, never rated. {ok960 ? `Uses ${tc(minutes, increment)}${variant === "chess960" ? ", Chess960" : ""}.` : "Bots play standard chess and Chess960."}</Text>
      <SegmentedControl size="xs" fullWidth mb={6} value={color} onChange={setColor} data={[{ value: "white", label: "White" }, { value: "random", label: "Random" }, { value: "black", label: "Black" }]} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {o.bots.map((b: BotInfo) => (
          <Button key={b.id} variant="default" h="auto" py={6} loading={busy === b.id} disabled={!o.ready}
            onClick={() => run(setBusy, b.id, () => o.playBot(b.id, { minutes, increment, color, variant: ok960 ? variant : "chess" }))}>
            <div style={{ textAlign: "left", lineHeight: 1.2 }}>
              <div>{b.name} <Text span size="xs" c="dimmed">~{b.about}</Text></div>
              <Text span size="xs" c="dimmed">{b.style}</Text>
            </div>
          </Button>
        ))}
      </div>
    </Panel>
  );
}

/* ───────── Simuls ───────── */

export function SimulList() {
  const o = useOnline();
  const [busy, setBusy] = useState<string>();
  const [making, setMaking] = useState(false);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState<number>(20);
  const [increment, setIncrement] = useState<number>(10);
  const [seats, setSeats] = useState<number>(6);
  const [color, setColor] = useState("white");
  const [variant, setVariant] = useState<OnlineVariant>("chess");
  useEffect(() => { if (o.ready) o.refreshSimuls(); }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <div style={{ padding: "0 12px 6px" }}>
        <Button size="compact-xs" variant="subtle" onClick={() => setMaking(!making)}>{making ? "Close" : "Host a simul"}</Button>
      </div>
      {making && (
        <div style={{ padding: "0 12px 8px", borderBottom: "1px solid var(--border)" }}>
          <TextInput size="xs" label="Name" placeholder={`${o.name}'s simul`} value={title} maxLength={40} onChange={(e) => setTitle(e.currentTarget.value)} />
          <Group grow mt={6}>
            <NumberInput size="xs" label="Minutes" min={1} max={180} value={minutes} onChange={(v) => setMinutes(Number(v) || 20)} />
            <NumberInput size="xs" label="Increment" min={0} max={60} value={increment} onChange={(v) => setIncrement(Number(v) || 0)} />
            <NumberInput size="xs" label="Boards" min={2} max={20} value={seats} onChange={(v) => setSeats(Number(v) || 6)} />
          </Group>
          <Group grow mt={6}>
            <Select size="xs" label="You play" value={color} allowDeselect={false} onChange={(v) => v && setColor(v)} data={[{ value: "white", label: "White" }, { value: "black", label: "Black" }, { value: "random", label: "Either" }]} />
            <Select size="xs" label="Variant" value={variant} allowDeselect={false} onChange={(v) => v && setVariant(v as OnlineVariant)} data={ONLINE_VARIANTS} />
          </Group>
          <Button mt={8} size="xs" fullWidth loading={busy === "create"} onClick={() => run(setBusy, "create", async () => { await o.createSimul({ title, minutes, increment, seats, color, variant }); setMaking(false); })}>Open the simul</Button>
        </div>
      )}
      {o.simuls.filter((s) => s.status === "open").map((s: SimulInfo) => (
        <div key={s.id} className="listrow" style={{ cursor: "default" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text size="sm" fw={600} truncate>{s.name}</Text>
            <Text size="xs" c="dimmed">{s.hostName}{s.hostRating ? ` (${s.hostRating})` : ""} · {tc(s.minutes, s.increment)}{s.variant !== "chess" ? ` · ${variantLabel(s.variant)}` : ""} · {s.players.length}/{s.seats} boards</Text>
          </div>
          <Button size="xs" variant="default" loading={busy === s.id} disabled={!o.ready || s.players.length >= s.seats || s.host === o.profile?.id}
            onClick={() => run(setBusy, s.id, () => o.joinSimul(s.id))}>Join</Button>
        </div>
      ))}
      {!o.simuls.some((s) => s.status === "open") && <Text size="sm" c="dimmed" p={12}>No simuls are open. Host one, or join one when it's listed here.</Text>}
      <Text size="xs" c="dimmed" px={12} pb={10} pt={4}>One host plays everyone at once. Casual games, each on its own clock.</Text>
    </>
  );
}

/** The simul this player is in: the host sees every board, a player sees the line-up. */
export function SimulPanel() {
  const o = useOnline();
  const [busy, setBusy] = useState<string>();
  const w = o.simul!;
  const s = w.info;
  const host = s.host === o.profile?.id;
  const mine = (g: GameView) => (g.white.guest === o.profile?.id ? "white" : "black");
  const toMove = (g: GameView) => (g.ply % 2 === 0 ? "white" : "black");
  const waiting = w.games.filter((g) => g.status === "playing" && toMove(g) === mine(g)).length;
  return (
    <Panel title={<><IconSwords size={13} /> {s.name}</>} right={<Badge size="sm" variant="light" color={s.status === "running" ? "green" : "gray"}>{s.status === "open" ? `${s.players.length}/${s.seats} signed up` : s.status}</Badge>}>
      {s.status === "open" ? (
        <>
          <Text size="sm">{host ? "Players are signing up. Start when you're ready." : `Waiting for ${s.hostName} to start.`}</Text>
          {s.players.map((p) => <Text key={p.guest} size="xs" c="dimmed">• {p.name}{p.rating ? ` (${p.rating})` : ""}</Text>)}
          <Group gap={6} mt={8}>
            {host && <Button size="xs" disabled={!s.players.length} loading={busy === "start"} onClick={() => run(setBusy, "start", () => o.startSimul())}>Start the simul</Button>}
            <Button size="xs" variant="default" onClick={() => o.leaveSimul()}>{host ? "Cancel it" : "Leave"}</Button>
          </Group>
        </>
      ) : host ? (
        <>
          <Text size="sm" mb={6}>{waiting ? <><b>{waiting}</b> board{waiting > 1 ? "s" : ""} waiting for your move.</> : "Your opponents are thinking."} Click a board to play it.</Text>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
            {w.games.map((g) => {
              const opp = g[mine(g) === "white" ? "black" : "white"];
              const yours = g.status === "playing" && toMove(g) === mine(g);
              return (
                <Button key={g.id} size="xs" variant={o.game?.id === g.id ? "filled" : yours ? "light" : "default"} color={yours ? "orange" : undefined}
                  onClick={() => o.openSimulBoard(g.id)}>
                  {opp.name} · {g.status === "finished" ? g.result : `move ${Math.floor(g.ply / 2) + 1}`}
                </Button>
              );
            })}
          </div>
          {s.status === "finished" && <Button mt={8} size="xs" variant="default" onClick={() => o.leaveSimul()}>Close</Button>}
        </>
      ) : (
        <>
          <Text size="sm">{s.status === "finished" ? "The simul is over." : `You're playing ${s.hostName}, along with ${Math.max(0, s.players.length - 1)} others.`}</Text>
          {s.status === "finished" && <Button mt={8} size="xs" variant="default" onClick={() => o.leaveSimul()}>Close</Button>}
        </>
      )}
    </Panel>
  );
}

export function ProfileButton({ guest, children }: { guest?: string | null; children: React.ReactNode }) {
  if (!guest || guest.startsWith("bot:")) return <>{children}</>;
  return <Tooltip label="View profile"><span className="pressable" onClick={() => openProfile(guest)}>{children}</span></Tooltip>;
}

