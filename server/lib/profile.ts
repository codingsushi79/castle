import { CORS, fail, Handler, json, sql } from "./db.js";
import { view } from "./game.js";

/**
 * Player profiles: ratings per category, record, team, recent games and
 * trophies (top three in arenas and Swiss tournaments). In the app and as a
 * page at /p/<id>.
 */
async function profileOf(guest: string) {
  const g = (await sql`select id, name, profile, last_seen, created_at from guests where id = ${guest}`)[0];
  if (!g) return undefined;
  const p = g.profile ?? {};
  const [recent, team, arenas, swisses] = await Promise.all([
    sql`select * from games where (white_guest = ${guest} or black_guest = ${guest}) and status = 'finished' and result <> 'aborted' order by updated_at desc limit 10`,
    sql`select t.name, t.id from team_members m join teams t on t.id = m.team_id where m.guest = ${guest}`,
    sql`select a.id, a.name, a.ends_at, 1 + (select count(*) from arena_players o where o.arena_id = a.id and o.score > me.score)::int as rank, me.score
        from arena_players me join arenas a on a.id = me.arena_id where me.guest = ${guest} and a.ends_at < ${Date.now()} and me.games > 0`,
    sql`select s.id, s.name, s.starts_at, 1 + (select count(*) from swiss_players o where o.swiss_id = s.id and o.points > me.points)::int as rank, me.points
        from swiss_players me join swiss s on s.id = me.swiss_id where me.guest = ${guest} and s.status = 'finished' and cardinality(me.opponents) > 0`,
  ]);
  const trophies = [
    ...arenas.filter((a) => a.rank <= 3).map((a) => ({ kind: "arena", name: a.name, rank: a.rank, score: a.score, at: Number(a.ends_at) })),
    ...swisses.filter((s) => s.rank <= 3).map((s) => ({ kind: "swiss", name: s.name, rank: s.rank, score: s.points / 2, at: Number(s.starts_at) })),
  ].sort((a, b) => b.at - a.at);
  return {
    guest: g.id, name: g.name ?? "Guest", online: !!g.last_seen && new Date(g.last_seen).getTime() > Date.now() - 60_000,
    since: new Date(g.created_at).getTime(), ratings: p.ratings ?? {}, rating: p.rating ?? 1500,
    games: p.games ?? 0, wins: p.wins ?? 0, draws: p.draws ?? 0, losses: p.losses ?? 0,
    team: team[0]?.name ?? null, trophies, recent: recent.map(view),
  };
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LABELS: Record<string, string> = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical", correspondence: "Correspondence", chess960: "Chess960", crazyhouse: "Crazyhouse", atomic: "Atomic", kingofthehill: "King of the Hill", "3check": "Three-check", antichess: "Antichess", horde: "Horde", racingkings: "Racing Kings" };

export const profileRoutes: Record<string, Handler> = {
  "GET profile": async (_r, u) => {
    const p = await profileOf(u.searchParams.get("guest") ?? "");
    return p ? json(p) : fail("No such player.", 404);
  },

  "GET p": async (_r, u) => {
    const p = await profileOf(u.searchParams.get("id") ?? "");
    if (!p) return new Response("No such player.", { status: 404, headers: { "content-type": "text/plain", ...CORS } });
    const ratings = Object.entries(p.ratings as Record<string, { r: number; g: number }>).sort((a, b) => b[1].g - a[1].g);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(p.name)} · Castle Online</title><meta property="og:title" content="${esc(p.name)} on Castle Online">
<style>:root{--bg:#f4f1ea;--fg:#1d1b18;--muted:#6b665d;--panel:#fff}@media (prefers-color-scheme:dark){:root{--bg:#191817;--fg:#ece8e1;--muted:#a19a8e;--panel:#232220}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 ui-rounded,system-ui,sans-serif;display:flex;justify-content:center;padding:16px}
main{max-width:720px;width:100%}h1{margin:0}.muted{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px;margin:12px 0}
.card{background:var(--panel);border-radius:8px;padding:10px 12px}.big{font-size:22px;font-weight:800}a{color:inherit}li{margin:3px 0}</style></head><body><main>
<h1>${esc(p.name)}${p.online ? ' <span class="muted">· online</span>' : ""}</h1>
<div class="muted">${p.games} games · ${p.wins} won · ${p.draws} drawn · ${p.losses} lost${p.team ? ` · team ${esc(p.team)}` : ""}</div>
<div class="grid">${ratings.length ? ratings.map(([c, r]) => `<div class="card"><div class="muted">${esc(LABELS[c] ?? c)}</div><div class="big">${r.r}</div><div class="muted">${r.g} games</div></div>`).join("") : `<div class="card"><div class="muted">Rating</div><div class="big">${p.rating}</div></div>`}</div>
${p.trophies.length ? `<h3>Trophies</h3><ul>${p.trophies.map((t) => `<li>${["🥇", "🥈", "🥉"][t.rank - 1]} ${esc(t.name)} <span class="muted">${t.kind === "arena" ? `${t.score} pts` : `${t.score} / Swiss`}</span></li>`).join("")}</ul>` : ""}
<h3>Recent games</h3><ul>${p.recent.map((g) => `<li><a href="/g/${esc(g.code)}">${esc(g.white.name)} – ${esc(g.black.name)}</a> <span class="muted">${esc(g.result)} · ${esc(g.reason)}</span></li>`).join("") || '<li class="muted">None yet.</li>'}</ul>
<p class="muted">Castle Online · <a href="/play/">play in your browser</a></p></main></body></html>`;
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" } });
  },
};
