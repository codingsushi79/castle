import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { call, isTauri, load, save } from "./storage";

export type Channel = "stable" | "beta";

interface UpdateState {
  status: "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";
  version?: string;
  notes?: string;
  progress: number;
  error?: string;
  auto: boolean;
  channel: Channel;
  check: (quiet?: boolean) => Promise<void>;
  install: () => Promise<void>;
  setAuto: (v: boolean) => void;
  setChannel: (c: Channel) => void;
}

/** "2.3.0-1" is the first beta of 2.3.0; plain versions are stable releases. */
export const isBeta = (version: string) => version.includes("-");
export const versionLabel = (version: string) => {
  const [base, pre] = version.split("-");
  return pre ? `${base} beta ${pre}` : version;
};

/**
 * Checks GitHub releases for a newer Castle and installs it. The check runs in
 * the app (src-tauri/src/updates.rs) so it can read the stable or the beta manifest.
 */
export const useUpdates = create<UpdateState>((set, get) => ({
  status: "idle",
  progress: 0,
  auto: load("autoUpdateCheck", true),
  channel: load<Channel>("updateChannel", "stable"),
  setAuto: (auto) => {
    save("autoUpdateCheck", auto);
    set({ auto });
  },
  setChannel: (channel) => {
    save("updateChannel", channel);
    set({ channel, status: "idle", version: undefined, notes: undefined });
    get().check();
  },
  check: async (quiet = false) => {
    if (!isTauri || get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: undefined });
    try {
      const found = await call<{ version: string; notes?: string } | null>("update_check", { channel: get().channel });
      save("lastUpdateCheck", Date.now());
      if (found) set({ status: "available", version: found.version, notes: found.notes ?? undefined });
      else set({ status: "none" });
    } catch (e) {
      set({ status: quiet ? "idle" : "error", error: String(e) });
    }
  },
  install: async () => {
    set({ status: "downloading", progress: 0 });
    const stop = await listen<[number, number | null]>("update-progress", ({ payload: [received, total] }) => {
      set({ progress: total ? Math.round((received / total) * 100) : 0 });
    });
    try {
      await call("update_install");
      set({ status: "ready", progress: 100 });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ status: "error", error: String(e) });
    } finally {
      stop();
    }
  },
}));

/** Looks for an update at most once a day, when automatic checks are on. */
export function checkOnLaunch() {
  const s = useUpdates.getState();
  if (!s.auto) return;
  if (Date.now() - load("lastUpdateCheck", 0) < 20 * 3600 * 1000) return;
  setTimeout(() => useUpdates.getState().check(true), 8000);
}
