import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { call, isTauri, load, save } from "./storage";

export type Channel = "stable" | "beta";

interface Location { path: string; translocated: boolean; in_applications: boolean }

interface UpdateState {
  /** "ready": downloaded and checked, waiting for a restart to install. */
  status: "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "installing" | "error";
  version?: string;
  notes?: string;
  progress: number;
  error?: string;
  auto: boolean;
  channel: Channel;
  /** Background mode: closing the window keeps Castle in the menu bar or tray. */
  background: boolean;
  location?: Location;
  check: (quiet?: boolean) => Promise<void>;
  download: () => Promise<void>;
  /** Installs the downloaded update and starts the new version. */
  install: () => Promise<void>;
  setAuto: (v: boolean) => void;
  setChannel: (c: Channel) => void;
  setBackground: (v: boolean) => void;
}

/** "2.3.0-1" is the first beta of 2.3.0; plain versions are stable releases. */
export const isBeta = (version: string) => version.includes("-");
export const versionLabel = (version: string) => {
  const [base, pre] = version.split("-");
  return pre ? `${base} beta ${pre}` : version;
};

/**
 * Checks GitHub releases for a newer Castle, downloads it in the background,
 * and installs it on restart. The work runs in the app (src-tauri/src/updates.rs)
 * so it can read the stable or the beta manifest and relaunch cleanly.
 */
export const useUpdates = create<UpdateState>((set, get) => ({
  status: "idle",
  progress: 0,
  auto: load("autoUpdateCheck", true),
  channel: load<Channel>("updateChannel", "stable"),
  background: load("backgroundMode", false),
  setAuto: (auto) => {
    save("autoUpdateCheck", auto);
    set({ auto });
  },
  setChannel: (channel) => {
    save("updateChannel", channel);
    set({ channel, status: "idle", version: undefined, notes: undefined });
    get().check();
  },
  setBackground: (background) => {
    save("backgroundMode", background);
    set({ background });
    if (isTauri) call("set_background", { enabled: background }).catch((e) => set({ error: String(e) }));
  },
  check: async (quiet = false) => {
    const s = get().status;
    if (!isTauri || s === "checking" || s === "downloading" || s === "installing") return;
    set({ status: "checking", error: undefined });
    try {
      const found = await call<{ version: string; notes?: string } | null>("update_check", { channel: get().channel });
      save("lastUpdateCheck", Date.now());
      if (!found) return set({ status: "none" });
      set({ status: "available", version: found.version, notes: found.notes ?? undefined });
      // Automatic updates download straight away, so the restart is quick.
      if (get().auto && !get().location?.translocated) await get().download();
    } catch (e) {
      set({ status: quiet ? "idle" : "error", error: String(e) });
    }
  },
  download: async () => {
    set({ status: "downloading", progress: 0, error: undefined });
    const stop = await listen<[number, number | null]>("update-progress", ({ payload: [received, total] }) => {
      set({ progress: total ? Math.round((received / total) * 100) : 0 });
    });
    try {
      await call("update_download");
      set({ status: "ready", progress: 100 });
    } catch (e) {
      set({ status: "error", error: String(e) });
    } finally {
      stop();
    }
  },
  install: async () => {
    if (get().status !== "ready") await get().download();
    if (get().status !== "ready") return;
    set({ status: "installing" });
    try {
      await call("update_install"); // quits and opens the new version
    } catch (e) {
      set({ status: "error", error: String(e) });
    }
  },
}));

/** Checks at launch (at most daily) and every six hours while Castle is open; restores background mode. */
export function checkOnLaunch() {
  const s = useUpdates.getState();
  call<Location>("app_location").then((location) => useUpdates.setState({ location })).catch(() => {});
  if (s.background) call("set_background", { enabled: true }).catch(() => {});
  if (!s.auto) return;
  if (Date.now() - load("lastUpdateCheck", 0) >= 20 * 3600 * 1000) setTimeout(() => useUpdates.getState().check(true), 8000);
  setInterval(() => { if (useUpdates.getState().auto) useUpdates.getState().check(true); }, 6 * 3600 * 1000);
}
