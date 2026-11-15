import { invoke } from "@tauri-apps/api/core";

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem("castle." + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown) {
  try {
    localStorage.setItem("castle." + key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Calls the Rust backend; outside the app shell it rejects so callers can fall back. */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri) return Promise.reject(new Error("Not running inside Castle"));
  return invoke<T>(cmd, args);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

export const clockText = (seconds: number) => {
  if (seconds < 20) return `0:${seconds.toFixed(1).padStart(4, "0")}`;
  const s = Math.ceil(seconds);
  const pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
};
