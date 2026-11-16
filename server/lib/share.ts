import { positions, variantOf } from "./chess.js";
import { CORS, Row, sql } from "./db.js";

/**
 * A shared game: /g/<code> shows a small page anyone can open in a browser,
 * stepping through the moves, and /g/<code>.pgn downloads the PGN.
 */
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const VARIANT_NAMES: Record<string, string> = { chess960: "Chess960", crazyhouse: "Crazyhouse", atomic: "Atomic", kingofthehill: "King of the Hill", "3check": "Three-check", antichess: "Antichess", horde: "Horde", racingkings: "Racing Kings" };

export async function findShared(idOrCode: string): Promise<Row | undefined> {
  const rows = await sql`select * from games where (id = ${idOrCode} or code = ${idOrCode.toUpperCase()}) and status <> 'waiting' limit 1`;
  return rows[0];
}

export function pgnOf(g: Row): string {
  const variant = variantOf(g.variant);
  const list = positions(g.moves ? g.moves.split(" ") : [], variant, g.initial_fen);
  const result = g.result && g.result !== "aborted" ? g.result : "*";
  const headers: [string, string][] = [
    ["Event", g.arena_id ? "Castle Online arena game" : g.swiss_id ? "Castle Online Swiss game" : g.rated ? "Castle Online rated game" : "Castle Online casual game"],
    ["Site", `https://castle-online.vercel.app/g/${g.code}`],
    ["Date", new Date(g.created_at).toISOString().slice(0, 10).replace(/-/g, ".")],
    ["White", g.white_name ?? "?"], ["Black", g.black_name ?? "?"], ["Result", result],
    ...(g.white_rating ? [["WhiteElo", String(g.white_rating)] as [string, string]] : []),
    ...(g.black_rating ? [["BlackElo", String(g.black_rating)] as [string, string]] : []),
    ["TimeControl", g.days ? `1/${g.days * 86400}` : `${Math.round(g.minutes * 60)}+${g.increment}`],
    ...(variant !== "chess" ? [["Variant", VARIANT_NAMES[variant] ?? variant] as [string, string]] : []),
    ...(g.initial_fen ? [["SetUp", "1"], ["FEN", g.initial_fen]] as [string, string][] : []),
    ...(g.reason ? [["Termination", g.reason]] as [string, string][] : []),
  ];
  const black = list[0].fen.split(" ")[1] === "b";
  const moves = list.slice(1).map((p, i) => {
    const ply = i + (black ? 1 : 0);
    return ply % 2 === 0 ? `${ply / 2 + 1}. ${p.san}` : i === 0 ? `1... ${p.san}` : p.san;
  });
  return `${headers.map(([k, v]) => `[${k} "${v.replace(/"/g, "'")}"]`).join("\n")}\n\n${[...moves, result].join(" ")}\n`;
}

export function sharePage(g: Row): Response {
  const variant = variantOf(g.variant);
  const list = positions(g.moves ? g.moves.split(" ") : [], variant, g.initial_fen);
  const title = `${g.white_name ?? "?"} vs ${g.black_name ?? "?"}`;
  const result = g.status === "finished" ? (g.result === "aborted" ? "Aborted" : `${g.result} · ${g.reason}`) : "In progress";
  const detail = `${g.days ? `${g.days} days per move` : `${g.minutes}+${g.increment}`}${variant !== "chess" ? ` · ${VARIANT_NAMES[variant]}` : ""} · ${result}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Castle Online</title>
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(detail)} · ${list.length - 1} moves on Castle Online">
<style>
:root{--bg:#f4f1ea;--fg:#1d1b18;--muted:#6b665d;--light:#f0d9b5;--dark:#b58863;--hi:#cdd26a99;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#191817;--fg:#ece8e1;--muted:#a19a8e;--panel:#232220}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 ui-rounded,system-ui,sans-serif;display:flex;justify-content:center;padding:16px}
main{width:100%;max-width:980px;display:flex;gap:20px;flex-wrap:wrap}
.board{width:min(560px,100%);aspect-ratio:1;display:grid;grid-template-columns:repeat(8,1fr);border-radius:6px;overflow:hidden;box-shadow:0 8px 24px #0004}
.sq{display:grid;place-items:center;font-size:min(7.2vw,52px);line-height:1;user-select:none}.l{background:var(--light)}.d{background:var(--dark)}.hi{box-shadow:inset 0 0 0 100px var(--hi)}
.w{color:#fff;-webkit-text-stroke:1.2px #222}.b{color:#111}
aside{flex:1;min-width:260px;background:var(--panel);border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px}
h1{font-size:19px;margin:0}.muted{color:var(--muted);font-size:13px}.moves{flex:1;overflow:auto;max-height:420px;display:flex;flex-wrap:wrap;gap:2px 6px;align-content:flex-start}
.mv{cursor:pointer;padding:1px 5px;border-radius:4px}.mv.on{background:var(--dark);color:#fff}.nav{display:flex;gap:6px}
button,a.btn{flex:1;font:inherit;padding:7px;border-radius:6px;border:1px solid #8884;background:transparent;color:inherit;cursor:pointer;text-align:center;text-decoration:none}
</style></head><body><main>
<div class="board" id="board" aria-label="Chess board"></div>
<aside><h1>${esc(title)}</h1><div class="muted">${esc(detail)}</div>
<div class="moves" id="moves"></div>
<div class="nav"><button id="first" aria-label="First move">⏮</button><button id="prev" aria-label="Previous move">◀</button><button id="next" aria-label="Next move">▶</button><button id="last" aria-label="Last move">⏭</button></div>
<a class="btn" href="/g/${esc(g.code)}.pgn" download="castle-${esc(g.code)}.pgn">Download PGN</a>
<div class="muted">Played on Castle Online. Open the PGN in Castle to analyse it.</div></aside></main>
<script>
const P=${JSON.stringify(list.map((p) => ({ f: p.fen.split(" ")[0], s: p.san, u: p.uci })))};
const G={K:"♚",Q:"♛",R:"♜",B:"♝",N:"♞",P:"♟"};let at=P.length-1;
function draw(){const rows=P[at].f.split("/"),u=P[at].u,hi=u?[u.slice(0,2),u.slice(2,4)]:[];let h="";
rows.forEach((row,r)=>{let f=0;for(const c of row){if(/\\d/.test(c)){for(let i=0;i<+c;i++)h+=cell(r,f++,"");}else h+=cell(r,f++,c);}});
document.getElementById("board").innerHTML=h;
function cell(r,f,c){const sq="abcdefgh"[f]+(8-r);const cls=((r+f)%2?"d":"l")+(hi.includes(sq)?" hi":"");const pc=c?'<span class="'+(c===c.toUpperCase()?"w":"b")+'">'+G[c.toUpperCase()]+"</span>":"";return '<div class="sq '+cls+'">'+pc+"</div>";}
document.querySelectorAll(".mv").forEach(e=>e.classList.toggle("on",+e.dataset.i===at));}
document.getElementById("moves").innerHTML=P.slice(1).map((p,i)=>(i%2===0?'<span class="muted">'+(i/2+1)+".</span>":"")+'<span class="mv" data-i="'+(i+1)+'">'+p.s+"</span>").join("");
document.getElementById("moves").onclick=e=>{const i=e.target.dataset&&e.target.dataset.i;if(i){at=+i;draw();}};
const go=n=>{at=Math.max(0,Math.min(P.length-1,n));draw();};
document.getElementById("first").onclick=()=>go(0);document.getElementById("prev").onclick=()=>go(at-1);document.getElementById("next").onclick=()=>go(at+1);document.getElementById("last").onclick=()=>go(P.length-1);
addEventListener("keydown",e=>{if(e.key==="ArrowLeft")go(at-1);if(e.key==="ArrowRight")go(at+1);});draw();
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=30" } });
}

export function pgnResponse(g: Row): Response {
  return new Response(pgnOf(g), { headers: { "content-type": "application/x-chess-pgn; charset=utf-8", "content-disposition": `attachment; filename="castle-${g.code}.pgn"`, ...CORS } });
}
