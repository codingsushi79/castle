import { Anchor, Button, Group, SegmentedControl, Text, Tooltip } from "@mantine/core";
import { IconBell, IconBellCheck, IconBook, IconBroadcast, IconDownload, IconPuzzle } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { Board } from "../components/Board";
import { MiniTV } from "../components/MiniTV";
import { ProfileModal } from "../components/OnlineExtras";
import { START_FEN } from "../lib/chess";
import { api, onlineToken, useOnline } from "../lib/online";
import { load, save } from "../lib/storage";
import { useStudies } from "../lib/studies";
import { OnlineGame, OnlinePanels } from "../pages/Online";
import PuzzlesPage from "../pages/Puzzles";
import StudiesPage from "../pages/Studies";

/**
 * Castle in a browser: Castle Online (play, tournaments, TV), the online
 * puzzle modes, and studies. Engines, the game library and other desktop
 * features stay in the app.
 */
type Tab = "play" | "puzzles" | "studies";

/** Links like /play/#game=<id> (from an alert) and /play/#study=<id>&edit=<code>. */
function useHashLinks(setTab: (t: Tab) => void) {
  const o = useOnline();
  useEffect(() => {
    const handle = async () => {
      const hash = location.hash;
      if (hash.includes("study=")) {
        setTab("studies");
        await useStudies.getState().openLink(hash);
      } else if (hash.includes("game=")) {
        setTab("play");
        const id = /game=([\w-]+)/.exec(hash)?.[1];
        if (!id) return;
        if (!useOnline.getState().ready) await useOnline.getState().start();
        // Your own correspondence game opens to play; anything else to watch.
        const mine = useOnline.getState().correspondence.find((c) => c.id === id)
          ?? (await api<{ correspondence: any[] }>("inbox", { token: onlineToken(), name: useOnline.getState().name }).catch(() => ({ correspondence: [] }))).correspondence.find((c: any) => c.id === id);
        if (mine) useOnline.getState().openCorrespondence(mine);
        else useOnline.getState().watch(id);
      }
    };
    handle();
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, [o.ready]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Alerts on this device: a service worker and a push subscription for the signed-in guest. */
function AlertsButton() {
  const [state, setState] = useState<"off" | "on" | "busy" | "unsupported">(
    typeof Notification === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window) ? "unsupported" : Notification.permission === "granted" && load("webAlerts", false) ? "on" : "off");
  if (state === "unsupported") return null;
  const turnOn = async () => {
    setState("busy");
    try {
      if ((await Notification.requestPermission()) !== "granted") throw new Error("Notifications weren't allowed.");
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const { key } = await api<{ key: string }>("push/key");
      const pad = "=".repeat((4 - (key.length % 4)) % 4);
      const raw = atob((key + pad).replace(/-/g, "+").replace(/_/g, "/"));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) });
      const o = useOnline.getState();
      if (!o.ready) await o.start();
      await api("alerts/subscribe", { token: onlineToken(), subscription: sub.toJSON() });
      save("webAlerts", true);
      setState("on");
    } catch (e: any) {
      useOnline.setState({ error: e.message });
      setState("off");
    }
  };
  return (
    <Tooltip label={state === "on" ? "Alerts are on for this device" : "Get alerts here for correspondence moves and challenges"}>
      <Button size="xs" variant={state === "on" ? "light" : "default"} loading={state === "busy"} leftSection={state === "on" ? <IconBellCheck size={14} /> : <IconBell size={14} />}
        onClick={state === "on" ? undefined : turnOn}>{state === "on" ? "Alerts on" : "Alerts"}</Button>
    </Tooltip>
  );
}

function PlayTab() {
  const game = useOnline((s) => !!s.game);
  if (game) return <OnlineGame />;
  return (
    <div className="page">
      <div className="boardcol web-hide-narrow"><div className="boardrow"><Board fen={START_FEN} readOnly /></div></div>
      <div className="sidecol wide stagger"><OnlinePanels /></div>
    </div>
  );
}

export function WebApp() {
  const [tab, setTab] = useState<Tab>(load<Tab>("webTab", "play"));
  const o = useOnline();
  useHashLinks(setTab);
  useEffect(() => { save("webTab", tab); }, [tab]);
  useEffect(() => { if (!o.ready) o.start(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const p = o.profile;
  return (
    <div className="web-shell">
      <header className="web-bar">
        <Group gap={8} wrap="nowrap">
          <img src={`${import.meta.env.BASE_URL}pieces/cburnett/wR.svg`} width={24} height={24} alt="" />
          <Text fw={800} className="web-hide-narrow">Castle Online</Text>
        </Group>
        <SegmentedControl size="xs" value={tab} onChange={(v) => setTab(v as Tab)} data={[
          { value: "play", label: <Group gap={4} wrap="nowrap"><IconBroadcast size={14} /><span>Play</span></Group> },
          { value: "puzzles", label: <Group gap={4} wrap="nowrap"><IconPuzzle size={14} /><span>Puzzles</span></Group> },
          { value: "studies", label: <Group gap={4} wrap="nowrap"><IconBook size={14} /><span>Studies</span></Group> },
        ]} />
        <Group gap={8} wrap="nowrap">
          {p && <Text size="xs" c="dimmed" className="web-hide-narrow">{o.name} · {p.rating}</Text>}
          <AlertsButton />
          <Tooltip label="Engines, your game library, analysis and training: get the desktop app">
            <Anchor href="https://github.com/codingsushi79/castle/releases/latest" target="_blank" size="xs" className="web-hide-narrow">
              <Group gap={4} wrap="nowrap"><IconDownload size={14} />Desktop app</Group>
            </Anchor>
          </Tooltip>
        </Group>
      </header>
      <main className="web-main">
        {tab === "play" ? <PlayTab /> : tab === "puzzles" ? <PuzzlesPage /> : <StudiesPage />}
      </main>
      <MiniTV />
      <ProfileModal />
    </div>
  );
}
