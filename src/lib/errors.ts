import { getVersion } from "@tauri-apps/api/app";
import { api } from "./online";
import { isTauri, load, save } from "./storage";
import { useApp } from "./store";

/**
 * Error reports, only when the player turns them on (Settings). A report has
 * the version, platform, page and the error with its stack, and the server
 * blanks out home-folder paths. Each distinct error is sent once per session.
 */
export const reportsOn = () => load<boolean>("errorReports", false);
export const setReports = (on: boolean) => save("errorReports", on);
/** Whether the player has been asked yet. */
export const reportsAsked = () => load<boolean>("errorReportsAsked", false);
export const markAsked = () => save("errorReportsAsked", true);

const sent = new Set<string>();
let version = "";
if (isTauri) getVersion().then((v) => (version = v)).catch(() => {});

const platform = () => (isTauri ? navigator.userAgent.includes("Mac") ? "macos" : navigator.userAgent.includes("Win") ? "windows" : "linux" : "web");

export function reportError(error: unknown, where?: string) {
  if (!reportsOn()) return;
  const e = error instanceof Error ? error : new Error(String(error));
  const message = `${e.name}: ${e.message}`.slice(0, 500);
  if (sent.has(message) || sent.size > 20) return;
  sent.add(message);
  api("error", { version: version || "web", platform: platform(), page: where ?? useApp.getState().page, message, stack: e.stack ?? "" }).catch(() => {});
}

/** Catches errors nothing else handled. */
export function installErrorReporting() {
  window.addEventListener("error", (ev) => reportError(ev.error ?? ev.message));
  window.addEventListener("unhandledrejection", (ev) => reportError(ev.reason));
}
