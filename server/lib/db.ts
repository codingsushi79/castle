import { neon } from "@neondatabase/serverless";
import { cleanText, isOffensiveName } from "./moderation.js";

export const sql = neon(process.env.DATABASE_URL!);
export type Color = "white" | "black";
export type Row = Record<string, any>;
export type Handler = (req: Request, url: URL, body: any) => Promise<Response>;

export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
export const fail = (message: string, status = 400, code?: string) => json({ error: message, ...(code ? { code } : {}) }, status);
export const other = (c: Color): Color => (c === "white" ? "black" : "white");

/** A display name: letters, digits and a little punctuation, never an offensive word. */
export function cleanName(n: unknown): string {
  const name = typeof n === "string" ? n.replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 24) : "";
  return name && !isOffensiveName(name) ? name : "Guest";
}
export { cleanText };

export function timeOf(b: any) {
  return {
    minutes: Math.min(180, Math.max(0.5, Number(b.minutes) || 5)),
    increment: Math.min(60, Math.max(0, Math.round(Number(b.increment) || 0))),
  };
}

/** Days per move for a correspondence game, or null for a game on the clock. */
export function daysOf(b: any): number | null {
  const d = Math.round(Number(b.days));
  return [1, 2, 3, 5, 7, 14].includes(d) ? d : null;
}
