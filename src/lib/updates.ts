import { create } from "zustand";
import { isTauri, load, save } from "./storage";

type Update = Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;

interface UpdateState {
  status: "idle" | "checking" | "available" | "none" | "downloading" | "ready" | "error";
  version?: string;
  notes?: string;
  progress: number;
  error?: string;
  auto: boolean;
  check: (quiet?: boolean) => Promise<void>;
  install: () => Promise<void>;
  setAuto: (v: boolean) => void;
}

let pending: Update | undefined;

/** Checks GitHub releases for a newer Castle and installs it. */
export const useUpdates = create<UpdateState>((set, get) => ({
  status: "idle",
  progress: 0,
  auto: load("autoUpdateCheck", true),
  setAuto: (auto) => {
    save("autoUpdateCheck", auto);
    set({ auto });
  },
  check: async (quiet = false) => {
    if (!isTauri || get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: undefined });
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      pending = await check();
      save("lastUpdateCheck", Date.now());
      if (pending) set({ status: "available", version: pending.version, notes: pending.body ?? undefined });
      else set({ status: "none" });
    } catch (e) {
      set({ status: quiet ? "idle" : "error", error: String(e) });
    }
  },
  install: async () => {
    if (!pending) return;
    set({ status: "downloading", progress: 0 });
    try {
      let total = 0, received = 0;
      await pending.downloadAndInstall((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") {
          received += e.data.chunkLength;
          set({ progress: total ? Math.round((received / total) * 100) : 0 });
        } else if (e.event === "Finished") set({ status: "ready", progress: 100 });
      });
      set({ status: "ready" });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      set({ status: "error", error: String(e) });
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
