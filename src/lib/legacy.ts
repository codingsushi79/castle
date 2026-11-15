import { Color, GameTree } from "./chess";
import { Card, useRepertoire } from "./repertoire";
import { Puzzle, PuzzleStats, usePuzzles } from "./puzzles";
import { call, load, save } from "./storage";
import { useApp } from "./store";
import { useEngines } from "./engines";

const APPLE_EPOCH = 978307200; // 2001-01-01, the reference date Swift encodes dates from

/**
 * Brings puzzle progress, repertoires, accounts and engine settings over from the
 * Swift version of Castle. Safe to run more than once: everything is merged.
 */
export async function importLegacyData(): Promise<string[]> {
  const data = await call<Record<string, any>>("legacy_data").catch(() => ({}) as Record<string, any>);
  return applyLegacyData(data);
}

export async function applyLegacyData(data: Record<string, any>): Promise<string[]> {
  const d: Record<string, any> = data.defaults ?? {};
  const done: string[] = [];

  // Puzzles
  const p = usePuzzles.getState();
  const oldStats: any = data["PuzzleStats.json"] ? JSON.parse(data["PuzzleStats.json"]) : undefined;
  if (typeof d.puzzleRating === "number" || oldStats) {
    const stats: PuzzleStats = { ...p.stats, themes: { ...p.stats.themes } };
    if (oldStats) {
      const history = (oldStats.ratingHistory ?? []).map((h: any) => ({ t: Math.round((h.date + APPLE_EPOCH) * 1000), r: h.rating }));
      const seen = new Set(stats.ratingHistory.map((h) => h.t));
      stats.ratingHistory = [...history.filter((h: any) => !seen.has(h.t)), ...stats.ratingHistory].sort((a, b) => a.t - b.t);
      for (const [k, v] of Object.entries<any>(oldStats.themes ?? {})) {
        const cur = stats.themes[k] ?? { attempts: 0, solved: 0 };
        stats.themes[k] = { attempts: cur.attempts + (v.attempts ?? 0), solved: cur.solved + (v.solved ?? 0) };
      }
      stats.rushScores = [...(oldStats.rushScores ?? []), ...stats.rushScores];
      stats.dailySolved = [...new Set([...(oldStats.dailySolved ?? []), ...stats.dailySolved])];
    }
    const hadHistory = p.stats.ratingHistory.length > 0;
    const rating = hadHistory ? p.rating : (d.puzzleRating ?? p.rating);
    usePuzzles.setState({ stats, rating, solved: p.solved + (d.puzzleSolved ?? 0), failed: p.failed + (d.puzzleFailed ?? 0) });
    save("puzzleStats", stats);
    save("puzzle", { rating, solved: p.solved + (d.puzzleSolved ?? 0), failed: p.failed + (d.puzzleFailed ?? 0) });
    done.push("puzzle rating and statistics");
  }
  if (data["Mistakes.json"]) {
    const n = usePuzzles.getState().addMistakes(JSON.parse(data["Mistakes.json"]) as Puzzle[]);
    if (n) done.push(`${n} saved mistakes`);
  }

  // Repertoire
  const r = useRepertoire.getState();
  for (const [file, color] of [["Repertoire-White.pgn", "white"], ["Repertoire-Black.pgn", "black"]] as [string, Color][]) {
    const tree = data[file] && GameTree.fromPgn(data[file]);
    if (tree && tree.root.children.length) {
      r.importTree(tree, color);
      done.push(`${color} repertoire`);
    }
  }
  if (data["RepertoireCards.json"]) {
    const old = JSON.parse(data["RepertoireCards.json"]) as Record<string, any>;
    const cards: Record<string, Card> = { ...useRepertoire.getState().cards };
    for (const [key, c] of Object.entries(old)) {
      const [side, epd] = [key.slice(0, key.indexOf("|")), key.slice(key.indexOf("|") + 1)];
      const k = `${side === "0" ? "white" : "black"}|${epd}`;
      if (!cards[k]) cards[k] = { interval: c.interval, ease: c.ease, reps: c.reps, lapses: c.lapses, due: Math.round((c.due + APPLE_EPOCH) * 1000) };
    }
    save("repertoire.cards", cards);
    useRepertoire.setState({ cards });
    done.push("repertoire review schedule");
  }

  // Accounts
  if (Array.isArray(d.accounts) && d.accounts.length) {
    const current = load<{ site: string; username: string }[]>("accounts", []);
    const key = (a: { site: string; username: string }) => a.site + a.username.toLowerCase();
    const have = new Set(current.map(key));
    const added = d.accounts.map((a: any) => ({ site: a.site === "Lichess" ? "lichess" : "chesscom", username: a.username })).filter((a: any) => !have.has(key(a)));
    save("accounts", [...current, ...added]);
    if (added.length) done.push(`${added.length} account${added.length === 1 ? "" : "s"}`);
  }

  // Engines and settings
  for (const [k, v] of Object.entries(d)) if (k.startsWith("engineOptions.") && v && typeof v === "object") save(k, { ...v, ...load(k, {}) });
  if (d.enginePaths) save("enginePaths", { ...d.enginePaths, ...load("enginePaths", {}) });
  if (Array.isArray(d.customEngines)) {
    const current = load<any[]>("customEngines", []);
    const paths = new Set(current.map((c) => c.path));
    save("customEngines", [...current, ...d.customEngines.filter((c: any) => c.path && !paths.has(c.path)).map((c: any) => ({ id: c.id, name: c.name, summary: c.summary, path: c.path, custom: true }))]);
  }
  if (d.defaultEngine && !load("defaultEngineSet", false)) useEngines.getState().setDefault(d.defaultEngine);
  const settings: Record<string, unknown> = {};
  if (typeof d.boardTheme === "string") settings.boardTheme = d.boardTheme;
  if (typeof d.soundEnabled === "boolean") settings.sound = d.soundEnabled;
  if (typeof d.showCoordinates === "boolean") settings.coords = d.showCoordinates;
  if (typeof d.engineThreads === "number" && d.engineThreads > 0) settings.threads = d.engineThreads;
  if (typeof d.engineHash === "number" && d.engineHash > 0) settings.hash = d.engineHash;
  if (Object.keys(settings).length) {
    useApp.getState().set(settings);
    done.push("board and engine settings");
  }
  await useEngines.getState().refresh();
  return done;
}
