import { fail, Handler, json, sql } from "./db.js";

/**
 * Error reports from Castle, sent only when the player has turned them on
 * (Settings). They carry the version, platform, page and the error itself,
 * with home-folder paths blanked out; nothing that identifies the player.
 */
const scrub = (s: unknown, max: number) =>
  String(s ?? "").slice(0, max)
    .replace(/\/Users\/[^/\s]+/g, "/Users/…").replace(/\/home\/[^/\s]+/g, "/home/…").replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "C:\\Users\\…");

export const errorRoutes: Record<string, Handler> = {
  "POST error": async (_r, _u, b) => {
    const message = scrub(b.message, 500).trim();
    if (!message) return fail("Nothing to report.");
    // The same error flooding in from a loop is kept to a sample.
    const recent = await sql`select count(*)::int as n from errors where message = ${message} and created_at > now() - interval '1 hour'`;
    if (recent[0].n >= 50) return json({ ok: true, sampled: true });
    await sql`insert into errors (version, platform, page, message, stack)
      values (${scrub(b.version, 30)}, ${scrub(b.platform, 40)}, ${scrub(b.page, 40)}, ${message}, ${scrub(b.stack, 4000)})`;
    return json({ ok: true });
  },
};

/** Errors of the last week, grouped by message, for the moderation page. */
export async function errorSummary() {
  return sql`select message, count(*)::int as count, array_agg(distinct version) as versions, array_agg(distinct platform) as platforms,
      max(created_at) as last, (array_agg(stack order by id desc))[1] as stack, (array_agg(page order by id desc))[1] as page
    from errors where created_at > now() - interval '7 days' group by message order by count(*) desc limit 50`;
}
