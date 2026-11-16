import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * A guest's rating lives on the guest's own computer, as a token only this
 * server can read or write: AES-256-GCM under RATING_KEY. Editing a token breaks
 * its authentication tag, and the version number (checked against the guests
 * table) stops an old token being restored after a loss.
 */
export interface Profile {
  id: string;
  rating: number;
  games: number;
  wins: number;
  losses: number;
  draws: number;
  peak: number;
  v: number;
}

function key(): Buffer {
  const hex = process.env.RATING_KEY ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("RATING_KEY must be 32 bytes of hex");
  return Buffer.from(hex, "hex");
}

export function seal(profile: Profile): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(profile), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

export function open(token: unknown): Profile | undefined {
  if (typeof token !== "string" || token.length > 2000) return undefined;
  try {
    const raw = Buffer.from(token, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const text = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    const p = JSON.parse(text) as Profile;
    return typeof p.id === "string" && typeof p.rating === "number" ? p : undefined;
  } catch {
    return undefined;
  }
}

export const randomId = (bytes = 9) => randomBytes(bytes).toString("base64url");

/** Elo with a larger K while a guest has few games. */
export function elo(mine: number, theirs: number, score: number, games: number): number {
  const k = games < 20 ? 40 : mine >= 2400 ? 16 : 24;
  const expected = 1 / (1 + 10 ** ((theirs - mine) / 400));
  return Math.max(100, Math.round(mine + k * (score - expected)));
}
