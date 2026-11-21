import { CORS, fail, Handler, json, sql } from "./db.js";
import { verified } from "./game.js";

/**
 * Profile pictures. Castle shrinks the picture to a small square before
 * sending it, so the server keeps it as it comes (base64, at most MAX_BYTES)
 * after checking it really is a JPEG, PNG or WebP image. Shown on profiles and
 * beside the board in games; moderators can remove one from /mod.
 */
export const MAX_BYTES = 64 * 1024;

const TYPES: Record<string, (b: Buffer) => boolean> = {
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/png": (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  "image/webp": (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
};

/** A data URL to [type, bytes], or why it can't be a profile picture. */
export function parseImage(image: unknown): { type: string; bytes: Buffer } | string {
  const m = typeof image === "string" ? image.match(/^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/) : null;
  if (!m || !TYPES[m[1]]) return "Choose a JPEG, PNG or WebP picture.";
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_BYTES) return "That picture is too big.";
  if (!TYPES[m[1]](bytes)) return "That file isn't a picture.";
  return { type: m[1], bytes };
}

/** When each guest's picture last changed (ms), for those who have one. */
export async function avatarVersions(guests: string[]): Promise<Record<string, number>> {
  if (!guests.length) return {};
  const rows = await sql`select guest, updated_at from avatars where guest = any(${guests})`;
  return Object.fromEntries(rows.map((r) => [r.guest, new Date(r.updated_at).getTime()]));
}

export const avatarRoutes: Record<string, Handler> = {
  /** The picture itself. With ?v= (its version) it can be cached for good; without, for a few minutes. */
  "GET avatar": async (_r, u) => {
    const row = (await sql`select type, data from avatars where guest = ${u.searchParams.get("guest") ?? ""}`)[0];
    const cache = u.searchParams.has("v") ? "public, max-age=31536000, immutable" : "public, max-age=300";
    if (!row) return new Response("No picture.", { status: 404, headers: { "content-type": "text/plain", "cache-control": "public, max-age=300", ...CORS } });
    return new Response(Buffer.from(row.data, "base64"), { headers: { "content-type": row.type, "cache-control": cache, ...CORS } });
  },

  /** Sets (image: a data URL) or removes (image: null) your picture. */
  "POST avatar": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    if (b.image == null) {
      await sql`delete from avatars where guest = ${p.id}`;
      return json({ avatar: null });
    }
    const img = parseImage(b.image);
    if (typeof img === "string") return fail(img);
    const now = new Date();
    await sql`insert into avatars (guest, type, data, updated_at) values (${p.id}, ${img.type}, ${img.bytes.toString("base64")}, ${now.toISOString()})
      on conflict (guest) do update set type = excluded.type, data = excluded.data, updated_at = excluded.updated_at`;
    return json({ avatar: now.getTime() });
  },
};
