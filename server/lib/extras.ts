import { fail, Handler, json, sql } from "./db.js";
import { load, seatOf } from "./game.js";

/** Private notes on a game, a player's stats, and accuracy reports for spotting engine help. */
export const extraRoutes: Record<string, Handler> = {
  /** A player's own notes on a game: only their seat key can read or write them. */
  "GET notes": async (_r, u) => {
    const g = await load(u.searchParams.get("id"));
    const seat = g && seatOf(g, u.searchParams.get("key"));
    if (!g || !seat) return fail("You are not playing this game.", 403);
    const row = (await sql`select text from notes where game_id = ${g.id} and guest = ${g[`${seat}_guest`]}`)[0];
    return json({ text: row?.text ?? "" });
  },

  "POST notes": async (_r, _u, b) => {
    const g = await load(b.id);
    const seat = g && seatOf(g, b.key);
    if (!g || !seat) return fail("You are not playing this game.", 403);
    const text = String(b.text ?? "").slice(0, 4000);
    await sql`insert into notes (game_id, guest, text) values (${g.id}, ${g[`${seat}_guest`]}, ${text})
      on conflict (game_id, guest) do update set text = excluded.text, updated_at = now()`;
    return json({ ok: true });
  },

  /** A guest's finished games, compact, for the stats page (ratings over time, colours, openings). */
  "GET stats": async (_r, u) => {
    const guest = u.searchParams.get("guest") ?? "";
    const rows = await sql`select id, code, white_guest, white_name, white_rating, white_new, black_name, black_rating, black_new, result, reason,
        category, variant, moves, rated, updated_at
      from games where (white_guest = ${guest} or black_guest = ${guest}) and status = 'finished' and result <> 'aborted'
      order by updated_at desc limit 500`;
    return json({
      games: rows.map((g) => {
        const color = g.white_guest === guest ? "white" : "black", opp = color === "white" ? "black" : "white";
        const score = g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (color === "white") ? 1 : 0;
        return {
          id: g.id, code: g.code, color, score, category: g.category, variant: g.variant, rated: g.rated, reason: g.reason,
          rating: g[`${color}_rating`], after: g[`${color}_new`], opponent: g[`${opp}_name`], opponentRating: g[`${opp}_rating`],
          moves: (g.moves ? g.moves.split(" ") : []).slice(0, 24), at: new Date(g.updated_at).getTime(),
        };
      }).reverse(),
    });
  },

  /**
   * After reviewing a game, a player's app reports both sides' accuracy. Only
   * reports by opponents count towards flagging a player (see the moderation page).
   */
  "POST accuracy": async (_r, _u, b) => {
    const g = await load(b.id);
    const seat = g && seatOf(g, b.key);
    if (!g || !seat) return fail("You are not playing this game.", 403);
    if (g.status !== "finished" || g.ply < 20) return json({ ok: false });
    const clamp = (v: unknown) => (typeof v === "number" && v >= 0 && v <= 100 ? v : null);
    await sql`insert into accuracy (game_id, reporter, white, black) values (${g.id}, ${g[`${seat}_guest`]}, ${clamp(b.white)}, ${clamp(b.black)})
      on conflict (game_id, reporter) do update set white = excluded.white, black = excluded.black`;
    return json({ ok: true });
  },
};
