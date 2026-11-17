import { cleanName, fail, Handler, json, sql } from "./db.js";
import { verified } from "./game.js";
import { randomId } from "./token.js";

/**
 * Teams: a name and a join code. A guest belongs to at most one team. Teams
 * meet in team-battle arenas, where a team scores the points of its best players.
 */
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => Array.from({ length: 6 }, () => codeChars[Math.floor(Math.random() * codeChars.length)]).join("");
const cleanTitle = (t: unknown) => String(t ?? "").replace(/[^\p{L}\p{N} _.,!'&-]/gu, "").trim().slice(0, 32);

async function teamOf(guest: string) {
  const t = (await sql`select t.* from teams t join team_members m on m.team_id = t.id where m.guest = ${guest}`)[0];
  if (!t) return undefined;
  const members = await sql`select m.guest, m.name, g.last_seen from team_members m left join guests g on g.id = m.guest where m.team_id = ${t.id} order by m.joined_at`;
  const cutoff = Date.now() - 60_000;
  return {
    id: t.id, code: t.code, name: t.name, mine: t.created_by === guest,
    members: members.map((m) => ({ guest: m.guest, name: m.name, online: !!m.last_seen && new Date(m.last_seen).getTime() > cutoff })),
  };
}

export const teamRoutes: Record<string, Handler> = {
  "POST team/mine": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    return json({ team: (await teamOf(p.id)) ?? null });
  },

  "POST team/create": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    if (await teamOf(p.id)) return fail("Leave your team first.", 409);
    const title = cleanTitle(b.title);
    if (!title || cleanName(title) === "Guest") return fail("Choose a name for the team.");
    const id = randomId();
    let code = newCode();
    while ((await sql`select 1 from teams where code = ${code}`).length) code = newCode();
    await sql`insert into teams (id, code, name, created_by) values (${id}, ${code}, ${title}, ${p.id})`;
    await sql`insert into team_members (team_id, guest, name) values (${id}, ${p.id}, ${cleanName(b.name)})`;
    return json({ team: await teamOf(p.id) });
  },

  "POST team/join": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    if (await teamOf(p.id)) return fail("Leave your team first.", 409);
    const t = (await sql`select id from teams where code = ${String(b.code ?? "").toUpperCase().trim()}`)[0];
    if (!t) return fail("No team has that code.", 404);
    await sql`insert into team_members (team_id, guest, name) values (${t.id}, ${p.id}, ${cleanName(b.name)}) on conflict (guest) do nothing`;
    return json({ team: await teamOf(p.id) });
  },

  "POST team/leave": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    const m = (await sql`delete from team_members where guest = ${p.id} returning team_id`)[0];
    if (m) await sql`delete from teams where id = ${m.team_id} and not exists (select 1 from team_members where team_id = ${m.team_id})`;
    return json({ ok: true });
  },

  /** A team by its code, for checking before a team battle. */
  "GET team": async (_r, u) => {
    const t = (await sql`select t.id, t.code, t.name, (select count(*)::int from team_members m where m.team_id = t.id) as members
      from teams t where t.code = ${(u.searchParams.get("code") ?? "").toUpperCase()}`)[0];
    return t ? json({ team: t }) : fail("No team has that code.", 404);
  },
};

/** The team a guest plays for, if any. */
export async function teamIdOf(guest: string): Promise<string | undefined> {
  return (await sql`select team_id from team_members where guest = ${guest}`)[0]?.team_id;
}
