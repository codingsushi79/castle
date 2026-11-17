import { Button, ColorInput, Group, Kbd, NumberInput, SegmentedControl, Select, Switch, Text, TextInput } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { importLegacyData } from "../lib/legacy";
import { prettyCombo, recordNextCombo, SHORTCUTS, useShortcuts } from "../lib/shortcuts";
import { call } from "../lib/storage";
import { isBeta, useUpdates, versionLabel } from "../lib/updates";
import { NotesText, openWhatsNew } from "../components/WhatsNew";
import { Progress } from "@mantine/core";
import { getVersion } from "@tauri-apps/api/app";
import { useEffect } from "react";
import { Board, PieceImg } from "../components/Board";
import { BOARD_THEMES, PIECE_SETS, useApp } from "../lib/store";

const ACCENTS = ["teal", "blue", "violet", "grape", "pink", "red", "orange", "yellow", "lime", "green", "cyan", "indigo"];

export default function SettingsPage() {
  const { settings, set } = useApp();
  const cores = navigator.hardwareConcurrency || 8;
  return (
    <div className="page">
      <div className="page scroll" style={{ flex: 1 }}>
        <Text fw={700} size="lg" mb="sm">Board</Text>
        <div className="card stagger" style={{ maxWidth: 640 }}>
          <Text size="sm" fw={600} mb={6}>Colours</Text>
          <Group gap={8}>
            {[...Object.entries(BOARD_THEMES), ["custom", { light: settings.customLight, dark: settings.customDark }] as const].map(([name, t]) => (
              <div key={name} className="pressable" title={name} onClick={() => set({ boardTheme: name })}
                style={{ width: 40, height: 40, borderRadius: 6, overflow: "hidden", display: "grid", gridTemplate: "1fr 1fr / 1fr 1fr", outline: settings.boardTheme === name ? "3px solid var(--mantine-primary-color-filled)" : "1px solid #0006", transform: settings.boardTheme === name ? "scale(1.08)" : undefined }}>
                <div style={{ background: t.light }} /><div style={{ background: t.dark }} /><div style={{ background: t.dark }} /><div style={{ background: t.light }} />
              </div>
            ))}
          </Group>
          {settings.boardTheme === "custom" && (
            <Group mt={10} grow>
              <ColorInput size="xs" label="Light squares" value={settings.customLight} onChange={(v) => set({ customLight: v })} />
              <ColorInput size="xs" label="Dark squares" value={settings.customDark} onChange={(v) => set({ customDark: v })} />
            </Group>
          )}
          <Text size="sm" fw={600} mt="md" mb={6}>Pieces</Text>
          <Group gap={8}>
            {PIECE_SETS.map((name) => (
              <div key={name} className="pressable" onClick={() => set({ pieceSet: name })}
                style={{ padding: "4px 8px", borderRadius: 6, textAlign: "center", background: settings.pieceSet === name ? "var(--mantine-primary-color-filled)" : "var(--bg-raised)" }}>
                <img src={`/pieces/${name}/wN.svg`} width={34} height={34} alt="" />
                <Text size="xs" tt="capitalize">{name}</Text>
              </div>
            ))}
          </Group>
          <Switch mt="md" label="Perspective (3D-style tilted) board" checked={settings.perspective} onChange={(e) => set({ perspective: e.currentTarget.checked })} />
          <Switch mt={8} label="Show coordinates" checked={settings.coords} onChange={(e) => set({ coords: e.currentTarget.checked })} />
          <Switch mt={8} label="Show legal moves for the selected piece" checked={settings.dests} onChange={(e) => set({ dests: e.currentTarget.checked })} />
        </div>

        <Text fw={700} size="lg" mt="lg" mb="sm">Appearance and sound</Text>
        <div className="card" style={{ maxWidth: 640 }}>
          <Text size="sm" fw={600} mb={6}>Theme</Text>
          <SegmentedControl mb="md" value={settings.colorScheme} onChange={(v) => set({ colorScheme: v as "dark" | "light" | "auto" })}
            data={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "auto", label: "Match macOS" }]} />
          <Text size="sm" fw={600} mb={6}>Accent colour</Text>
          <Group gap={6}>
            {ACCENTS.map((c) => (
              <div key={c} className="pressable" title={c} onClick={() => set({ accent: c })}
                style={{ width: 24, height: 24, borderRadius: "50%", background: `var(--mantine-color-${c}-7)`, outline: settings.accent === c ? "2px solid #fff" : undefined, outlineOffset: 2 }} />
            ))}
          </Group>
          <Switch mt="md" label="Play sounds for moves and results" checked={settings.sound} onChange={(e) => set({ sound: e.currentTarget.checked })} />
        </div>

        <Text fw={700} size="lg" mt="lg" mb="sm">Engine resources</Text>
        <div className="card" style={{ maxWidth: 640 }}>
          <Group>
            <NumberInput label="Threads" w={120} min={1} max={cores} value={settings.threads} onChange={(v) => typeof v === "number" && set({ threads: v })} />
            <Select label="Hash" w={140} value={String(settings.hash)} onChange={(v) => v && set({ hash: parseInt(v, 10) })} data={[64, 128, 256, 512, 1024, 2048, 4096].map((n) => ({ value: String(n), label: `${n} MB` }))} />
          </Group>
          <Text size="xs" c="dimmed" mt={6}>Applies the next time an engine starts. This Mac has {cores} cores.</Text>
        </div>
        <Text fw={700} size="lg" mt="lg" mb="sm">Keyboard</Text>
        <Shortcuts />

        <Text fw={700} size="lg" mt="lg" mb="sm">Updates</Text>
        <UpdatesCard />

        <Text fw={700} size="lg" mt="lg" mb="sm">Your data</Text>
        <DataCard />
        <Text size="xs" c="dimmed" mt="lg" maw={640}>
          Piece sets come from the Lichess project and keep their own licences (cburnett and merida: GPL; alpha: free for personal use; staunty, maestro and others: Creative Commons). The board uses chessground and the rules use chessops, both GPL-3.0.
        </Text>
      </div>
      <div style={{ width: 380, padding: 20, borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", gap: 10 }}>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase">Preview</Text>
        <div style={{ height: 340, display: "flex" }}>
          <Board fen="r1bq1rk1/pp2ppbp/2np1np1/8/3NP3/2N1BP2/PPPQ2PP/R3KB1R w KQ - 3 9" lastMove={["f8", "g8"]} />
        </div>
        <Group gap={4}>{(["king", "queen", "rook", "bishop", "knight", "pawn"] as const).map((r) => <PieceImg key={r} role={r} color="black" size={40} />)}</Group>
      </div>
    </div>
  );
}

function Shortcuts() {
  const { keysFor, setKeys, reset } = useShortcuts();
  const [recording, setRecording] = useState<string>();
  const [filter, setFilter] = useState("");
  const shown = SHORTCUTS.filter((d) => d.label.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <Group mb={8}>
        <TextInput style={{ flex: 1 }} placeholder="Filter" value={filter} onChange={(e) => setFilter(e.currentTarget.value)} />
        <Button variant="default" onClick={reset}>Restore defaults</Button>
      </Group>
      <div style={{ maxHeight: 340, overflowY: "auto" }}>
        {shown.map((d) => (
          <Group key={d.id} justify="space-between" py={4} style={{ borderBottom: "1px solid #8881" }}>
            <div><Text size="sm">{d.label}</Text><Text size="xs" c="dimmed">{d.group}</Text></div>
            <Group gap={6}>
              <Kbd>{recording === d.id ? "Press keys…" : prettyCombo(keysFor(d.id))}</Kbd>
              <Button variant="default" onClick={() => {
                setRecording(d.id);
                recordNextCombo((combo) => { setKeys(d.id, combo); setRecording(undefined); });
              }}>{recording === d.id ? "Waiting" : "Change"}</Button>
              {keysFor(d.id) && <Button variant="subtle" color="gray" onClick={() => setKeys(d.id, "")}>Clear</Button>}
            </Group>
          </Group>
        ))}
      </div>
      <Text size="xs" c="dimmed" mt={6}>Press Escape while recording to remove a shortcut. Press ? anywhere to see them all.</Text>
    </div>
  );
}

function DataCard() {
  const [busy, setBusy] = useState<string>();
  const say = (message: string) => notifications.show({ message, autoClose: 4000 });
  const backup = async () => {
    const path = await saveDialog({ defaultPath: `Castle backup ${new Date().toISOString().slice(0, 10)}.castlebackup`, filters: [{ name: "Castle backup", extensions: ["castlebackup"] }] });
    if (!path) return;
    setBusy("backup");
    try {
      const state: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith("castle.")) state[k] = localStorage.getItem(k)!;
      }
      await call("db_backup", { path, state: JSON.stringify(state) });
      say("Backup saved: library, repertoire, puzzles, settings and training history.");
    } catch (e) {
      say(`Backup failed: ${e}`);
    }
    setBusy(undefined);
  };
  const restore = async () => {
    const path = await openDialog({ filters: [{ name: "Castle backup", extensions: ["castlebackup"] }] });
    if (typeof path !== "string") return;
    if (!window.confirm("Restoring replaces your current library, repertoire, puzzle progress and settings with the backup. Continue?")) return;
    setBusy("restore");
    try {
      const state = JSON.parse(await call<string>("db_restore", { path })) as Record<string, string>;
      for (const k of Object.keys(localStorage)) if (k.startsWith("castle.")) localStorage.removeItem(k);
      for (const [k, v] of Object.entries(state)) localStorage.setItem(k, v);
      location.reload();
    } catch (e) {
      say(String(e));
      setBusy(undefined);
    }
  };
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <Text size="sm">A backup is one file with the whole library plus your repertoire, puzzle progress, packs, accounts, engine options and settings.</Text>
      <Group mt="sm" gap={8}>
        <Button loading={busy === "backup"} onClick={backup}>Back up…</Button>
        <Button variant="default" loading={busy === "restore"} onClick={restore}>Restore…</Button>
        <Button variant="default" loading={busy === "legacy"} onClick={async () => {
          setBusy("legacy");
          const done = await importLegacyData().catch(() => [] as string[]);
          setBusy(undefined);
          say(done.length ? `Brought over: ${done.join(", ")}.` : "Nothing new to bring over from Castle 1.");
        }}>Import from Castle 1</Button>
      </Group>
    </div>
  );
}

function UpdatesCard() {
  const u = useUpdates();
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  const label = u.version ? versionLabel(u.version) : "";
  const status = {
    idle: "Updates come from the project's GitHub releases.",
    checking: "Checking GitHub…",
    none: "You have the latest version.",
    available: `Castle ${label} is available.`,
    downloading: `Downloading Castle ${label}… ${u.progress}%`,
    ready: `Castle ${label} is downloaded and checked. Restart to finish.`,
    installing: "Installing and restarting…",
    error: `Could not update: ${u.error}`,
  }[u.status];
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <Group justify="space-between">
        <div>
          <Text size="sm">Castle {version && versionLabel(version)} <Button variant="subtle" size="compact-xs" onClick={openWhatsNew}>What's new</Button></Text>
          <Text size="xs" c={u.status === "error" ? "red" : "dimmed"}>{status}</Text>
        </div>
        {u.status === "ready" || u.status === "installing" ? <Button loading={u.status === "installing"} onClick={() => u.install()}>Restart to update</Button>
          : u.status === "available" ? <Button disabled={u.location?.translocated} onClick={() => u.download()}>Download</Button>
          : <Button variant="default" loading={u.status === "checking"} disabled={u.status === "downloading"} onClick={() => u.check()}>Check now</Button>}
      </Group>
      {u.location?.translocated && (
        <Text size="xs" c="orange" mt={6}>
          macOS is running Castle from a temporary copy, so it can't update itself. Quit Castle, drag it into your Applications folder, and open it from there.
        </Text>
      )}
      {u.status === "downloading" && <Progress mt="sm" value={u.progress} size="sm" animated />}
      {(u.status === "available" || u.status === "ready" || u.status === "downloading") && u.notes && (
        <div style={{ marginTop: 8, maxHeight: 220, overflowY: "auto", padding: 8, borderRadius: 6, background: "var(--bg-raised)" }}>
          <Text size="xs" fw={700} mb={4}>What's in Castle {label}</Text>
          <NotesText text={u.notes} />
        </div>
      )}
      <Switch mt="sm" label="Check for updates automatically, and download them in the background" checked={u.auto} onChange={(e) => u.setAuto(e.currentTarget.checked)} />
      <Switch mt="sm" label="Keep Castle running in the menu bar when its window is closed" checked={u.background} onChange={(e) => u.setBackground(e.currentTarget.checked)}
        description="So you still get alerts for your correspondence moves and challenges. Quit from the menu bar (or tray) icon." />
      <Group mt="md" justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="sm">Update channel</Text>
          <Text size="xs" c="dimmed" maw={400}>
            {u.channel === "beta"
              ? "You get beta builds as soon as they are out, plus every stable release. Betas have the newest features and may have rough edges."
              : "Stable releases only. Switch to Beta to try new features early."}
          </Text>
          {u.channel === "stable" && version && isBeta(version) && (
            <Text size="xs" c="orange" mt={4}>You are on a beta now. You'll move back to stable with the next stable release.</Text>
          )}
        </div>
        <SegmentedControl size="xs" value={u.channel} disabled={u.status === "downloading" || u.status === "installing"} onChange={(v) => u.setChannel(v as "stable" | "beta")}
          data={[{ value: "stable", label: "Stable" }, { value: "beta", label: "Beta" }]} />
      </Group>
    </div>
  );
}
