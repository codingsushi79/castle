import { cleanName, fail, Handler, json, ping, Row, sql } from "./db.js";
import { verified } from "./game.js";
import { randomId } from "./token.js";

/**
 * Studies: shared analysis boards in chapters, each chapter one PGN with
 * variations and comments. Anyone with the link can look; anyone with the edit
 * code can change it. Each chapter has a revision number: a save based on an
 * older revision is refused with the current text, and the app merges and saves again.
 */
const MAX_PGN = 200_000;
const chapterOut = (c: Row) => ({ id: c.id, title: c.title, pgn: c.pgn, rev: c.rev, updatedAt: new Date(c.updated_at).getTime() });
const title = (t: unknown, fallback: string) => String(t ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 80) || fallback;

async function editable(id: unknown, edit: unknown) {
  const s = (await sql`select * from studies where id = ${String(id ?? "")}`)[0];
  return s && typeof edit === "string" && edit === s.edit_code ? s : undefined;
}

export const studyRoutes: Record<string, Handler> = {
  "POST study/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const id = randomId(), edit = randomId(9);
    await sql`insert into studies (id, edit_code, title, owner, owner_name) values (${id}, ${edit}, ${title(b.title, "New study")}, ${p.id}, ${cleanName(b.name)})`;
    await sql`insert into study_chapters (id, study_id, idx, title, pgn) values (${randomId()}, ${id}, 0, 'Chapter 1', ${String(b.pgn ?? "").slice(0, MAX_PGN)})`;
    return json({ id, edit });
  },

  "GET study": async (_r, u) => {
    const s = (await sql`select * from studies where id = ${u.searchParams.get("id") ?? ""}`)[0];
    if (!s) return fail("No such study.", 404);
    const chapters = await sql`select * from study_chapters where study_id = ${s.id} order by idx`;
    return json({ id: s.id, title: s.title, owner: s.owner, ownerName: s.owner_name, updatedAt: new Date(s.updated_at).getTime(), chapters: chapters.map(chapterOut) });
  },

  /** The studies a guest made (with their edit codes). */
  "POST study/mine": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const rows = await sql`select id, edit_code, title, updated_at from studies where owner = ${p.id} order by updated_at desc limit 100`;
    return json({ studies: rows.map((s) => ({ id: s.id, edit: s.edit_code, title: s.title, updatedAt: new Date(s.updated_at).getTime() })) });
  },

  /** Saves a chapter (or adds one, without a chapter id). */
  "POST study/chapter": async (_r, _u, b) => {
    const s = await editable(b.id, b.edit);
    if (!s) return fail("You need the edit link to change this study.", 403);
    const pgn = String(b.pgn ?? "");
    if (pgn.length > MAX_PGN) return fail("That chapter is too long.", 413);
    let c: Row | undefined;
    if (!b.chapter) {
      const idx = Number((await sql`select coalesce(max(idx), -1) + 1 as n from study_chapters where study_id = ${s.id}`)[0].n);
      if (idx >= 64) return fail("A study holds up to 64 chapters.", 409);
      c = (await sql`insert into study_chapters (id, study_id, idx, title, pgn) values (${randomId()}, ${s.id}, ${idx}, ${title(b.title, `Chapter ${idx + 1}`)}, ${pgn}) returning *`)[0];
    } else {
      c = (await sql`update study_chapters set pgn = ${pgn}, rev = rev + 1, updated_at = now(), title = coalesce(${b.title ? title(b.title, "") : null}, title)
        where id = ${String(b.chapter)} and study_id = ${s.id} and rev = ${Number(b.rev)} returning *`)[0];
      if (!c) {
        const now = (await sql`select * from study_chapters where id = ${String(b.chapter)} and study_id = ${s.id}`)[0];
        return now ? json({ conflict: true, chapter: chapterOut(now) }, 409) : fail("No such chapter.", 404);
      }
    }
    await sql`update studies set updated_at = now() where id = ${s.id}`;
    await ping({ t: "study", id: s.id });
    return json({ chapter: chapterOut(c) });
  },

  "POST study/rename": async (_r, _u, b) => {
    const s = await editable(b.id, b.edit);
    if (!s) return fail("You need the edit link to change this study.", 403);
    if (b.chapter) await sql`update study_chapters set title = ${title(b.title, "Chapter")}, rev = rev + 1, updated_at = now() where id = ${String(b.chapter)} and study_id = ${s.id}`;
    else await sql`update studies set title = ${title(b.title, s.title)}, updated_at = now() where id = ${s.id}`;
    await ping({ t: "study", id: s.id });
    return json({ ok: true });
  },

  "POST study/delete-chapter": async (_r, _u, b) => {
    const s = await editable(b.id, b.edit);
    if (!s) return fail("You need the edit link to change this study.", 403);
    const left = (await sql`select count(*)::int as n from study_chapters where study_id = ${s.id}`)[0].n;
    if (left <= 1) return fail("A study keeps at least one chapter.", 409);
    await sql`delete from study_chapters where id = ${String(b.chapter ?? "")} and study_id = ${s.id}`;
    await ping({ t: "study", id: s.id });
    return json({ ok: true });
  },
};
