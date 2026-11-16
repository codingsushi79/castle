import { cleanName, fail, Handler, json, Row, sql } from "./db.js";
import { freshCode, verified } from "./game.js";
import { randomId } from "./token.js";

/**
 * Endpoints kept for Castle 2.3.0, whose puzzle battles and rush scores are
 * reported by the app. Newer Castle uses the checked races in race.ts, and the
 * rush leaderboard counts only those.
 */
function battleView(r: Row) {
  const now = Date.now();
  const started = r.started_at ? Number(r.started_at) : null;
  const ends = started ? started + r.minutes * 60_000 : null;
  const out = r.a_strikes >= 3 && r.b_strikes >= 3;
  const status = !started ? "waiting" : now < started ? "countdown" : now >= ends! || out ? "finished" : "running";
  const side = (s: "a" | "b") => ({ name: r[`${s}_name`], guest: r[`${s}_guest`], score: r[`${s}_score`], strikes: r[`${s}_strikes`] });
  return { id: r.id, code: r.code, minutes: r.minutes, puzzles: r.puzzles, startedAt: started, endsAt: ends, now, status, a: side("a"), b: side("b") };
}

export const legacyRoutes: Record<string, Handler> = {
  "POST rush": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const minutes = [3, 5].includes(Number(b.minutes)) ? Number(b.minutes) : 0;
    const score = Math.round(Number(b.score));
    if (!minutes || !(score >= 0 && score <= 150)) return fail("That score can't be recorded.");
    await sql`insert into rush_scores (guest, name, minutes, score) values (${p.id}, ${cleanName(b.name)}, ${minutes}, ${score})`;
    return json({ ok: true });
  },

  "POST battle": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const puzzles = (Array.isArray(b.puzzles) ? b.puzzles : []).slice(0, 150).filter((x: any) =>
      x && typeof x.fen === "string" && x.fen.length < 100 && Array.isArray(x.moves) && x.moves.length >= 2 && x.moves.length <= 20 &&
      x.moves.every((m: unknown) => typeof m === "string" && m.length <= 5)).map((x: any) => ({ id: String(x.id ?? "").slice(0, 12), fen: x.fen, moves: x.moves, rating: Number(x.rating) || 0 }));
    if (puzzles.length < 10) return fail("A battle needs at least 10 puzzles.");
    const minutes = Math.min(10, Math.max(1, Math.round(Number(b.minutes) || 3)));
    const id = randomId(), key = randomId(18), code = await freshCode();
    await sql`insert into battles (id, code, public, minutes, puzzles, a_guest, a_name, a_key)
      values (${id}, ${code}, ${b.public !== false}, ${minutes}, ${JSON.stringify(puzzles)}, ${p.id}, ${cleanName(b.name)}, ${key})`;
    return json({ id, code, key, side: "a" });
  },

  "POST battle/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const code = String(b.code ?? "").trim();
    const row = (await sql`select * from battles where code = ${code.toUpperCase()} or id = ${code}`)[0];
    if (!row) return fail("No battle has that code.", 404);
    if (row.a_guest === p.id) return fail("You can't battle yourself.", 409);
    const key = randomId(18);
    const rows = await sql`update battles set b_guest = ${p.id}, b_name = ${cleanName(b.name)}, b_key = ${key}, started_at = ${Date.now() + 5000}
      where id = ${row.id} and b_guest is null returning id`;
    return rows.length ? json({ id: row.id, code: row.code, key, side: "b" }) : fail("Someone else is already in that battle.", 409);
  },

  "GET battle": async (_r, u) => {
    const row = (await sql`select * from battles where id = ${u.searchParams.get("id") ?? ""}`)[0];
    return row ? json(battleView(row)) : fail("No such battle.", 404);
  },

  "POST battle/progress": async (_r, _u, b) => {
    const row = (await sql`select * from battles where id = ${String(b.id ?? "")}`)[0];
    if (!row) return fail("No such battle.", 404);
    const side = row.a_key === b.key ? "a" : row.b_key && row.b_key === b.key ? "b" : undefined;
    if (!side) return fail("You are not in this battle.", 403);
    const v = battleView(row);
    if (v.status !== "running") return json(v);
    const score = Math.min(150, Math.max(0, Math.round(Number(b.score) || 0)));
    const strikes = Math.min(3, Math.max(0, Math.round(Number(b.strikes) || 0)));
    const next = side === "a"
      ? await sql`update battles set a_score = greatest(a_score, ${score}), a_strikes = greatest(a_strikes, ${strikes}) where id = ${row.id} returning *`
      : await sql`update battles set b_score = greatest(b_score, ${score}), b_strikes = greatest(b_strikes, ${strikes}) where id = ${row.id} returning *`;
    return json(battleView(next[0]));
  },

  "POST battle/cancel": async (_r, _u, b) => {
    await sql`delete from battles where id = ${String(b.id ?? "")} and a_key = ${String(b.key ?? "")} and b_guest is null`;
    return json({ ok: true });
  },
};

/** Open 2.3.0-style battles, for 2.3.0 lobbies. */
export async function openBattles() {
  const rows = await sql`select id, code, a_name, minutes from battles where b_guest is null and public and created_at > now() - interval '15 minutes' order by created_at desc limit 20`;
  return rows.map((r) => ({ id: r.id, code: r.code, name: r.a_name, minutes: r.minutes }));
}
