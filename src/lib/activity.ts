import { load, save } from "./storage";

export type ActivityKind = "puzzle" | "rush" | "repertoire" | "endgame" | "vision" | "game" | "review" | "quiz" | "calculation" | "guess";

export interface Activity {
  t: number;
  kind: ActivityKind;
  ok?: boolean;
  value?: number;
}

/** A small rolling log of training and play, used by the weekly report. */
export function logActivity(kind: ActivityKind, ok?: boolean, value?: number) {
  const log = load<Activity[]>("activity", []);
  log.push({ t: Date.now(), kind, ok, value });
  save("activity", log.slice(-5000));
}

export const activitySince = (since: number) => load<Activity[]>("activity", []).filter((a) => a.t >= since);
