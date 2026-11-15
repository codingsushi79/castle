import { homeDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { call, load, save } from "./storage";
import { Engine } from "./uci";

export interface EngineEntry {
  id: string;
  name: string;
  summary: string;
  path?: string;
  bundled?: boolean;
  custom?: boolean;
  formula?: string;
  hint?: string;
}

/** Which desktop system Castle is running on. */
export const PLATFORM: "mac" | "windows" | "linux" = /Windows/i.test(navigator.userAgent) ? "windows" : /Linux/i.test(navigator.userAgent) && !/Android/i.test(navigator.userAgent) ? "linux" : "mac";

const KNOWN: { id: string; name: string; summary: string; bins: string[]; formula?: string; hint?: string }[] = [
  { id: "stockfish", name: "Stockfish", summary: "The strongest open-source engine. NNUE evaluation, alpha-beta search.", bins: ["stockfish"], formula: "stockfish" },
  { id: "lc0", name: "Leela Chess Zero", summary: "Neural network engine with Monte Carlo tree search. Also runs the Maia human-like networks.", bins: ["lc0"], formula: "lc0" },
  { id: "dragon", name: "Komodo Dragon", summary: "Commercial engine known for its positional, human-like style.", bins: ["dragon", "komodo-dragon", "komodo"], hint: "Purchase from komodochess.com, then locate the binary" },
  { id: "berserk", name: "Berserk", summary: "Top-tier NNUE engine with an aggressive search.", bins: ["berserk"] },
  { id: "rubichess", name: "RubiChess", summary: "Strong NNUE engine by Andreas Matthies.", bins: ["rubichess", "RubiChess"] },
  { id: "caissa", name: "Caissa", summary: "Strong engine with a large custom neural network.", bins: ["caissa"] },
  { id: "ethereal", name: "Ethereal", summary: "Clean, influential alpha-beta engine by Andrew Grant.", bins: ["ethereal", "Ethereal"] },
  { id: "koivisto", name: "Koivisto", summary: "Fast NNUE engine with a tactical style.", bins: ["koivisto", "Koivisto"] },
  { id: "obsidian", name: "Obsidian", summary: "Very strong NNUE engine by Gabriele Lombardo.", bins: ["obsidian", "Obsidian"] },
  { id: "fairy-stockfish", name: "Fairy-Stockfish", summary: "Stockfish derivative that plays every chess variant in Castle.", bins: ["fairy-stockfish"], formula: "fairy-stockfish" },
];

interface EngineStore {
  engines: EngineEntry[];
  defaultId: string;
  loaded: boolean;
  refresh: () => Promise<void>;
  setDefault: (id: string) => void;
  locate: (id: string, path: string) => Promise<void>;
  addCustom: (path: string) => Promise<void>;
  removeCustom: (id: string) => Promise<void>;
}

export const useEngines = create<EngineStore>((set, get) => ({
  engines: [],
  defaultId: load("defaultEngine", "wasabi"),
  loaded: false,
  refresh: async () => {
    let home = "";
    try {
      home = (await homeDir()).replace(/\/$/, "");
    } catch {
      /* not in the app shell */
    }
    const dirs = PLATFORM === "windows"
      ? [`${home}\\AppData\\Local\\Castle\\Engines`, "C:\\Program Files\\Stockfish", "C:\\Program Files\\lc0", `${home}\\scoop\\shims`, "C:\\ProgramData\\chocolatey\\bin", `${home}\\Downloads`]
      : PLATFORM === "linux"
        ? ["/usr/games", "/usr/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.local/share/Castle/Engines`, "/snap/bin", "/var/lib/flatpak/exports/bin"]
        : ["/opt/homebrew/bin", "/usr/local/bin", `${home}/code/stockapi/engines/bin`, `${home}/Library/Application Support/Castle/Engines`, `${home}/.local/bin`, "/usr/bin"];
    const sep = PLATFORM === "windows" ? "\\" : "/";
    const exe = (b: string) => (PLATFORM === "windows" ? [`${b}.exe`, `${b}-windows-x86-64.exe`, `${b}-windows-x86-64-avx2.exe`] : [b]);
    const overrides = load<Record<string, string>>("enginePaths", {});
    const custom = load<EngineEntry[]>("customEngines", []);
    // Castle keeps its own copy of Wasabi in the data folder; the app bundle may not have one.
    const dataDir = await call<string>("app_dir", { sub: "engines" }).catch(() => "");
    const bundled = await call<string>("resource_path", { name: "wasabi-2.1" }).catch(() => "");
    const copies = await call<string[]>("scan_paths", { paths: [dataDir && `${dataDir}/wasabi-2.1`, bundled].filter(Boolean) }).catch(() => [] as string[]);
    const wasabi = copies[0] ?? "";
    const candidates = [wasabi, ...Object.values(overrides), ...custom.map((c) => c.path ?? ""), ...KNOWN.flatMap((k) => dirs.flatMap((d) => k.bins.flatMap(exe).map((b) => `${d}${sep}${b}`)))];
    const found = new Set(await call<string[]>("scan_paths", { paths: candidates.filter(Boolean) }).catch(() => [] as string[]));
    const list: EngineEntry[] = [
      ...(PLATFORM === "mac" && wasabi ? [{ id: "wasabi", name: "Wasabi 2.1", summary: "Castle's built-in engine. NNUE evaluation, runs with no setup.", path: found.has(wasabi) ? wasabi : undefined, bundled: true }] : []),
    ];
    for (const k of KNOWN) {
      let path = overrides[k.id] && found.has(overrides[k.id]) ? overrides[k.id] : undefined;
      if (!path) path = dirs.flatMap((d) => k.bins.flatMap(exe).map((b) => `${d}${sep}${b}`)).find((p) => found.has(p));
      list.push({ id: k.id, name: k.name, summary: k.summary, path, formula: k.formula, hint: k.hint ?? (k.formula && PLATFORM === "mac" ? `brew install ${k.formula}` : k.formula && PLATFORM === "linux" ? `sudo apt install ${k.formula}` : undefined) });
    }
    list.push(...custom.filter((c) => c.path && found.has(c.path)));
    let defaultId = get().defaultId;
    if (!list.find((e) => e.id === defaultId)?.path) defaultId = list.find((e) => e.path)?.id ?? "wasabi";
    set({ engines: list, loaded: true, defaultId });
  },
  setDefault: (id) => {
    save("defaultEngine", id);
    set({ defaultId: id });
  },
  locate: async (id, path) => {
    save("enginePaths", { ...load<Record<string, string>>("enginePaths", {}), [id]: path });
    await get().refresh();
  },
  addCustom: async (path) => {
    const custom = load<EngineEntry[]>("customEngines", []);
    custom.push({ id: "custom-" + Date.now().toString(36), name: path.split("/").pop() ?? "Engine", summary: path, path, custom: true });
    save("customEngines", custom);
    await get().refresh();
  },
  removeCustom: async (id) => {
    save("customEngines", load<EngineEntry[]>("customEngines", []).filter((c) => c.id !== id));
    await get().refresh();
  },
}));

export const available = () => useEngines.getState().engines.filter((e) => e.path);
export const entryOf = (id?: string) => useEngines.getState().engines.find((e) => e.id === id);

/** The requested engine if installed, otherwise the default, otherwise anything that runs. */
export function resolveEngine(id?: string): EngineEntry | undefined {
  const s = useEngines.getState();
  return [entryOf(id), entryOf(s.defaultId), ...s.engines].find((e) => e?.path);
}

export const engineOptions = (id: string) => load<Record<string, string>>(`engineOptions.${id}`, {});
export const setEngineOptions = (id: string, options: Record<string, string>) => save(`engineOptions.${id}`, options);

export function syzygyPath(): string {
  return load("syzygyPath", "");
}

/** Starts an engine with the user's thread and hash settings and any saved options. */
export async function launch(entry: EngineEntry, overrides: Record<string, string> = {}): Promise<Engine> {
  if (!entry.path) throw new Error(`${entry.name} is not installed.`);
  const settings = load("settings", {} as { threads?: number; hash?: number });
  const cores = navigator.hardwareConcurrency || 4;
  const all: Record<string, string> = {
    Threads: String(settings.threads ?? Math.max(1, Math.floor(cores / 2))),
    Hash: String(settings.hash ?? 256),
    ...(syzygyPath() ? { SyzygyPath: syzygyPath() } : {}),
    ...engineOptions(entry.id),
    ...overrides,
  };
  const engine = new Engine(entry.path, all);
  await engine.start();
  return engine;
}
