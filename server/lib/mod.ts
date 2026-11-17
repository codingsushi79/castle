import { fail, Handler, json, sql } from "./db.js";

/**
 * Moderation. /mod is a small page for whoever holds ADMIN_KEY (a Vercel
 * environment variable): reported players with their reasons and recent chat,
 * players whose opponents' reviews show engine-like accuracy, and bans.
 * A banned player can still finish their games but can't start, join, chat or race.
 */

/** Accuracy flags: enough games reviewed by opponents, and a high average. */
export const FLAG_GAMES = 8;
export const FLAG_ACCURACY = 92;

function authorised(key: unknown) {
  const want = process.env.ADMIN_KEY ?? "";
  return want.length >= 12 && typeof key === "string" && key === want;
}

/** Whether a guest is banned now, and until when. */
export async function banOf(guest: string): Promise<{ until: number; reason: string | null } | undefined> {
  const row = (await sql`select banned_until, ban_reason from guests where id = ${guest}`)[0];
  const until = row?.banned_until ? new Date(row.banned_until).getTime() : 0;
  return until > Date.now() ? { until, reason: row.ban_reason ?? null } : undefined;
}

/** Each player's average accuracy as reported by their opponents. */
export async function accuracyFlags() {
  return sql`
    with seen as (
      select case when a.reporter = g.white_guest then g.black_guest else g.white_guest end as guest,
             case when a.reporter = g.white_guest then a.black else a.white end as acc
      from accuracy a join games g on g.id = a.game_id
      where a.reporter in (g.white_guest, g.black_guest)
    )
    select s.guest, count(*)::int as games, round(avg(s.acc)::numeric, 1)::float as accuracy, max(u.name) as name
    from seen s left join guests u on u.id = s.guest where s.acc is not null
    group by s.guest having count(*) >= ${FLAG_GAMES} and avg(s.acc) >= ${FLAG_ACCURACY}
    order by avg(s.acc) desc limit 50`;
}

export const modRoutes: Record<string, Handler> = {
  "GET mod": async () => new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),

  "POST mod/list": async (_r, _u, b) => {
    if (!process.env.ADMIN_KEY) return fail("Moderation is off: set ADMIN_KEY on the server (at least 12 characters).", 503);
    if (!authorised(b.key)) return fail("Wrong key.", 401);
    const reported = await sql`
      select r.reported as guest, max(g.name) as name, count(distinct r.reporter)::int as reporters, count(*)::int as reports,
        array_agg(distinct r.reason) as reasons, max(r.created_at) as last, max(g.banned_until) as banned_until, max(g.ban_reason) as ban_reason
      from reports r left join guests g on g.id = r.reported
      where r.created_at > now() - interval '30 days'
      group by r.reported order by count(distinct r.reporter) desc, max(r.created_at) desc limit 100`;
    const guests = reported.map((r) => r.guest);
    const chat = guests.length ? await sql`select guest, text, created_at from chat where guest = any(${guests}) and kind = 'text' order by id desc limit 300` : [];
    const banned = await sql`select id, name, banned_until, ban_reason from guests where banned_until > now() order by banned_until desc limit 100`;
    return json({
      reported: reported.map((r) => ({ ...r, chat: chat.filter((c) => c.guest === r.guest).slice(0, 6).map((c) => c.text) })),
      flagged: await accuracyFlags(), banned,
      thresholds: { games: FLAG_GAMES, accuracy: FLAG_ACCURACY },
    });
  },

  "POST mod/ban": async (_r, _u, b) => {
    if (!authorised(b.key)) return fail("Wrong key.", 401);
    const days = Number(b.days);
    const until = new Date(Date.now() + (days > 0 ? days : 36500) * 86_400_000).toISOString();
    await sql`update guests set banned_until = ${until}, ban_reason = ${String(b.reason ?? "").slice(0, 200) || null} where id = ${String(b.guest ?? "")}`;
    return json({ ok: true, until });
  },

  "POST mod/unban": async (_r, _u, b) => {
    if (!authorised(b.key)) return fail("Wrong key.", 401);
    await sql`update guests set banned_until = null, ban_reason = null where id = ${String(b.guest ?? "")}`;
    return json({ ok: true });
  },

  /** Clears a player's reports (after dealing with them, or when they were unfounded). */
  "POST mod/clear": async (_r, _u, b) => {
    if (!authorised(b.key)) return fail("Wrong key.", 401);
    await sql`delete from reports where reported = ${String(b.guest ?? "")}`;
    return json({ ok: true });
  },
};

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Castle Online moderation</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6f4ef;--fg:#1d1b18;--muted:#6b665d;--panel:#fff;--line:#0001;--red:#c0392b}
@media (prefers-color-scheme:dark){:root{--bg:#191817;--fg:#ece8e1;--muted:#a19a8e;--panel:#232220;--line:#fff1}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 ui-rounded,system-ui,sans-serif;padding:16px}
main{max-width:980px;margin:0 auto}h1{font-size:20px}h2{font-size:15px;margin:22px 0 6px}
.card{background:var(--panel);border-radius:8px;padding:10px 12px;margin:6px 0;border:1px solid var(--line)}
.muted{color:var(--muted);font-size:12px}button{font:inherit;padding:4px 10px;border-radius:6px;border:1px solid #8885;background:transparent;color:inherit;cursor:pointer;margin:2px}
button.red{color:var(--red);border-color:var(--red)}input{font:inherit;padding:6px;border-radius:6px;border:1px solid #8886;background:transparent;color:inherit;width:min(340px,100%)}
.row{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}.chat{font-size:12px;color:var(--muted);margin-top:4px}.err{color:var(--red)}
</style></head><body><main>
<h1>Castle Online moderation</h1>
<div id="login" class="row"><input id="key" type="password" placeholder="Admin key" autocomplete="off"><button id="go">Open</button></div>
<div id="out"></div></main>
<script>
const $=s=>document.querySelector(s);let key=sessionStorage.getItem("castleModKey")||"";
const post=(p,b)=>fetch("/api/"+p,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({key,...b})}).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||r.status);return d;});
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);
const ban=(g,days)=>{const reason=prompt("Reason (optional)")??"";post("mod/ban",{guest:g,days,reason}).then(load).catch(e=>alert(e.message));};
const act=(p,g)=>post(p,{guest:g}).then(load).catch(e=>alert(e.message));
function actions(g){return '<button class="red" onclick="ban(\\''+g+'\\',1)">Ban 1 day</button><button class="red" onclick="ban(\\''+g+'\\',7)">7 days</button><button class="red" onclick="ban(\\''+g+'\\',0)">Permanently</button>';}
async function load(){
  try{const d=await post("mod/list",{});$("#login").style.display="none";sessionStorage.setItem("castleModKey",key);
  let h='<h2>Reported in the last 30 days</h2>';
  h+=d.reported.length?d.reported.map(r=>'<div class="card"><div class="row"><b>'+esc(r.name||"?")+'</b><span class="muted">'+esc(r.guest)+'</span><span>'+r.reporters+' reporter(s): '+esc(r.reasons.join(", "))+'</span>'+(r.banned_until&&new Date(r.banned_until)>new Date()?'<span class="err">banned until '+new Date(r.banned_until).toLocaleString()+'</span>':'')+'</div>'+(r.chat.length?'<div class="chat">'+r.chat.map(esc).join(" · ")+'</div>':'')+'<div>'+actions(r.guest)+'<button onclick="act(\\'mod/clear\\',\\''+r.guest+'\\')">Clear reports</button></div></div>').join(""):'<p class="muted">No reports.</p>';
  h+='<h2>Engine-like accuracy</h2><p class="muted">At least '+d.thresholds.games+' games reviewed by their opponents, averaging '+d.thresholds.accuracy+'% or more. A flag is a reason to look at their games, not proof.</p>';
  h+=d.flagged.length?d.flagged.map(f=>'<div class="card"><div class="row"><b>'+esc(f.name||"?")+'</b><span class="muted">'+esc(f.guest)+'</span><span>'+f.accuracy+'% over '+f.games+' games</span></div><div>'+actions(f.guest)+'</div></div>').join(""):'<p class="muted">Nobody is flagged.</p>';
  h+='<h2>Banned</h2>'+(d.banned.length?d.banned.map(b=>'<div class="card row"><b>'+esc(b.name||"?")+'</b><span class="muted">'+esc(b.id)+'</span><span>until '+new Date(b.banned_until).toLocaleString()+(b.ban_reason?' · '+esc(b.ban_reason):'')+'</span><button onclick="act(\\'mod/unban\\',\\''+b.id+'\\')">Unban</button></div>').join(""):'<p class="muted">Nobody is banned.</p>');
  $("#out").innerHTML=h;}catch(e){$("#login").style.display="";$("#out").innerHTML='<p class="err">'+esc(e.message)+'</p>';}
}
$("#go").onclick=()=>{key=$("#key").value;load();};$("#key").onkeydown=e=>{if(e.key==="Enter"){key=$("#key").value;load();}};
if(key)load();
</script></body></html>`;
