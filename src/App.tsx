import { Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  IconActivity, IconBolt, IconBook2, IconBooks, IconChartLine, IconCpu, IconDeviceTv, IconFlag, IconPuzzle, IconSettings,
  IconTarget, IconTrophy, IconUserCircle, IconWorld, IconDatabase, IconCommand,
} from "@tabler/icons-react";
import { ReactNode, useEffect, useState } from "react";
import { CheatSheet, CommandPalette, openPalette } from "./components/Palette";
import { WhatsNew } from "./components/WhatsNew";
import { useOnline } from "./lib/online";
import { ChallengeCard } from "./pages/Online";
import { useBatch } from "./lib/batch";
import { db } from "./lib/db";
import { available, useEngines } from "./lib/engines";
import { importLegacyData } from "./lib/legacy";
import { useLichess } from "./lib/lichess";
import { useOpenings } from "./lib/openings";
import { usePuzzles } from "./lib/puzzles";
import { dueNodes, useRepertoire } from "./lib/repertoire";
import { installShortcutListener, useAction } from "./lib/shortcuts";
import { checkOnLaunch, useUpdates, versionLabel } from "./lib/updates";
import { usePlay } from "./lib/play";
import { call, copyText, isTauri, load, save } from "./lib/storage";
import { activeTree, Page, useApp } from "./lib/store";
import AccountsPage from "./pages/Accounts";
import AnalysisPage, { openPgnFile, pasteGame } from "./pages/Analysis";
import EnginesPage from "./pages/Engines";
import FicsPage from "./pages/Fics";
import LibraryPage from "./pages/Library";
import LichessPage from "./pages/Lichess";
import MatchesPage from "./pages/Matches";
import PlayPage from "./pages/Play";
import OnlinePage from "./pages/Online";
import ProgressPage from "./pages/Progress";
import PuzzlesPage from "./pages/Puzzles";
import RepertoirePage from "./pages/Repertoire";
import SettingsPage from "./pages/Settings";
import TrainingPage from "./pages/Training";
import WatchPage from "./pages/Watch";

const PAGES: { id: Page; title: string; icon: ReactNode; group: number }[] = [
  { id: "play", title: "Play", icon: <IconFlag size={21} />, group: 0 },
  { id: "lichess", title: "Lichess", icon: <IconBolt size={21} />, group: 0 },
  { id: "fics", title: "FICS", icon: <IconWorld size={21} />, group: 0 },
  { id: "watch", title: "Watch", icon: <IconDeviceTv size={21} />, group: 0 },
  { id: "matches", title: "Engine Tournaments", icon: <IconTrophy size={21} />, group: 0 },
  { id: "analysis", title: "Analysis", icon: <IconActivity size={21} />, group: 1 },
  { id: "puzzles", title: "Puzzles", icon: <IconPuzzle size={21} />, group: 1 },
  { id: "training", title: "Training", icon: <IconTarget size={21} />, group: 1 },
  { id: "repertoire", title: "Repertoire", icon: <IconBook2 size={21} />, group: 1 },
  { id: "progress", title: "Progress", icon: <IconChartLine size={21} />, group: 1 },
  { id: "library", title: "Library", icon: <IconBooks size={21} />, group: 2 },
  { id: "accounts", title: "Accounts", icon: <IconUserCircle size={21} />, group: 2 },
  { id: "engines", title: "Engines", icon: <IconCpu size={21} />, group: 2 },
];

const VIEWS: Record<Page, () => JSX.Element> = {
  play: PlayPage, online: OnlinePage, lichess: LichessPage, fics: FicsPage, watch: WatchPage, matches: MatchesPage, analysis: AnalysisPage,
  puzzles: PuzzlesPage, training: TrainingPage, repertoire: RepertoirePage, progress: ProgressPage, library: LibraryPage,
  accounts: AccountsPage, engines: EnginesPage, settings: SettingsPage,
};

const say = (message: string) => notifications.show({ message, autoClose: 1800 });

function GlobalActions({ onCheatSheet }: { onCheatSheet: () => void }) {
  const go = useApp((s) => s.go);
  for (const p of PAGES) useAction(`go.${p.id}`, () => go(p.id)); // eslint-disable-line react-hooks/rules-of-hooks
  useAction("go.online", () => go("online"));
  useAction("settings", () => go("settings"));
  useAction("palette", openPalette);
  useAction("cheatsheet", onCheatSheet);
  useAction("tab.new", () => { useApp.getState().newTab(); go("analysis"); });
  useAction("tab.close", () => useApp.getState().closeTab(useApp.getState().active));
  const cycle = (dir: number) => {
    const { tabs, active, selectTab } = useApp.getState();
    const i = tabs.findIndex((t) => t.id === active);
    selectTab(tabs[(i + dir + tabs.length) % tabs.length].id);
    go("analysis");
  };
  useAction("tab.next", () => cycle(1));
  useAction("tab.prev", () => cycle(-1));
  useAction("file.open", openPgnFile);
  useAction("file.paste", pasteGame);
  useAction("file.copyFen", () => { copyText(activeTree().fen); say("FEN copied"); });
  useAction("file.copyPgn", () => { copyText(activeTree().toPgn()); say("PGN copied"); });
  useAction("theme.toggle", () => {
    const s = useApp.getState();
    s.set({ colorScheme: s.settings.colorScheme === "light" ? "dark" : "light" });
  });
  return null;
}

/** Incoming challenges, shown on every page except the one that already lists them. */
function ChallengeStack() {
  const incoming = useOnline((s) => s.incoming);
  const onPlay = useApp((s) => s.page === "play");
  const onlineSetup = usePlay((s) => s.opponent === "online" && s.phase === "setup");
  const onPlayOnline = onPlay && onlineSetup;
  const go = useApp((s) => s.go);
  if (!incoming.length || onPlayOnline) return null;
  return (
    <div className="challenge-stack">
      {incoming.map((c) => (
        <ChallengeCard key={c.id} c={c} onAccept={() => {
          // The game is played on the Play page.
          if (usePlay.getState().phase === "setup") usePlay.getState().patch({ opponent: "online" });
          go("play");
        }} />
      ))}
    </div>
  );
}

export default function App() {
  const { page, status, libraryRevision, tabs } = useApp();
  const go = useApp((s) => s.go);
  const engines = useEngines((s) => s.engines);
  const mistakes = usePuzzles((s) => s.mistakes.length);
  const rep = useRepertoire();
  const lichess = useLichess();
  const batch = useBatch();
  const updates = useUpdates();
  const [games, setGames] = useState(0);
  const [splash, setSplash] = useState(true);
  const [cheat, setCheat] = useState(false);

  useEffect(() => { const t = setTimeout(() => setSplash(false), 1400); return () => clearTimeout(t); }, []);
  useEffect(installShortcutListener, []);

  useEffect(() => {
    useEngines.getState().refresh();
    useOpenings.getState().load();
    usePuzzles.getState().load();
    useLichess.getState().connect();
    // Signed in quietly, so challenges from friends arrive anywhere in Castle.
    useOnline.getState().startBackground();
    if (!isTauri) return;
    checkOnLaunch();
    // Bring over games and progress from the earlier version of Castle, once.
    (async () => {
      if (!load("legacyImported", false)) {
        const path = await call<string | null>("legacy_library").catch(() => null);
        if (path && (await db.count()) === 0) {
          const text = await call<string>("read_text", { path }).catch(() => "");
          if (text.trim()) await db.importText(text, "", true);
        }
        save("legacyImported", true);
      }
      if (!load("legacyDataImported", false)) {
        const done = await importLegacyData().catch(() => [] as string[]);
        save("legacyDataImported", true);
        if (done.length) notifications.show({ title: "Brought over from Castle 1", message: done.join(", "), autoClose: 6000 });
      }
    })();
  }, []);

  useEffect(() => { db.count().then(setGames); }, [libraryRevision]);

  const due = dueNodes(rep.trees.white, "white", rep.cards).length + dueNodes(rep.trees.black, "black", rep.cards).length;
  const onlineWaiting = useOnline((s) => s.correspondence.filter((c) => c.myTurn).length + s.incoming.length);
  const badge: Partial<Record<Page, number>> = {
    play: onlineWaiting,
    analysis: tabs.length > 1 ? tabs.length : 0,
    puzzles: mistakes,
    repertoire: due,
    lichess: lichess.ongoing.filter((g) => g.myTurn).length + lichess.incoming.length,
  };
  const View = VIEWS[page] ?? PlayPage;
  const current = PAGES.find((p) => p.id === page);

  return (
    <>
      {splash && <div className="splash"><div><img src="/pieces/cburnett/wR.svg" width={110} height={110} alt="" />Castle</div></div>}
      <GlobalActions onCheatSheet={() => setCheat(true)} />
      <CommandPalette />
      <CheatSheet opened={cheat} onClose={() => setCheat(false)} />
      <WhatsNew />
      <ChallengeStack />
      <div className="shell">
        <div className="titlebar" data-tauri-drag-region>
          <span className="title">Castle</span>
          <span className="sub">{current?.title ?? (page === "online" ? "Play" : "Settings")}</span>
          <span style={{ flex: 1 }} data-tauri-drag-region />
          <Tooltip label="Command palette  ⌘K">
            <button className="palette-button" onClick={openPalette}><IconCommand size={13} /> Search or run a command</button>
          </Tooltip>
        </div>
        <nav className="activity">
          {PAGES.map((p, i) => (
            <span key={p.id} style={{ display: "contents" }}>
              {i > 0 && PAGES[i - 1].group !== p.group && <div className="sep" />}
              <Tooltip label={p.title} position="right">
                <button className={page === p.id ? "on" : ""} onClick={() => go(p.id)}>
                  {p.icon}
                  {!!badge[p.id] && <span className="badge">{badge[p.id]}</span>}
                </button>
              </Tooltip>
            </span>
          ))}
          <div className="spacer" />
          <Tooltip label="Settings" position="right">
            <button className={page === "settings" ? "on" : ""} onClick={() => go("settings")}><IconSettings size={21} /></button>
          </Tooltip>
        </nav>
        <main className="main" key={page}>
          <View />
        </main>
        <footer className="statusbar">
          <span><IconCpu size={13} /> {available().length} of {engines.length} engines</span>
          <span><IconDatabase size={13} /> {games.toLocaleString()} games</span>
          {lichess.state === "online" && <span><IconBolt size={13} /> {lichess.username}</span>}
          {batch.running && <span style={{ cursor: "pointer" }} onClick={() => go("library")}>Reviewing {batch.done + 1} of {batch.total}{batch.current ? `: ${batch.current}` : ""}</span>}
          {updates.status === "available" && <span style={{ cursor: "pointer", fontWeight: 700 }} onClick={() => go("settings")}>Update to {versionLabel(updates.version!)}</span>}
          <span className="grow">{status}</span>
          <span style={{ cursor: "pointer" }} onClick={() => setCheat(true)}>Shortcuts</span>
          <span>Castle</span>
        </footer>
      </div>
      <div id="print-area" className="print-only" />
    </>
  );
}
