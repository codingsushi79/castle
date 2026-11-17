import { positions, variantOf } from "./chess.js";
import { Handler, json, Row, sql } from "./db.js";
import { onFinish } from "./game.js";

/**
 * The Castle Online opening explorer: what people played from each position in
 * the first 30 plies of finished standard games, and how they scored.
 */
const PLIES = 30;
const epd = (fen: string) => fen.split(" ").slice(0, 4).join(" ");

async function record(g: Row) {
  if (variantOf(g.variant) !== "chess" || g.initial_fen || !g.result || g.result === "aborted" || g.ply < 4) return;
  const col = g.result === "1-0" ? "white" : g.result === "0-1" ? "black" : "draws";
  const list = positions((g.moves ? g.moves.split(" ") : []).slice(0, PLIES));
  for (let i = 1; i < list.length; i++) {
    const at = epd(list[i - 1].fen), uci = list[i].uci, san = list[i].san;
    if (col === "white") await sql`insert into explorer_moves (epd, uci, san, white) values (${at}, ${uci}, ${san}, 1) on conflict (epd, uci) do update set white = explorer_moves.white + 1`;
    else if (col === "black") await sql`insert into explorer_moves (epd, uci, san, black) values (${at}, ${uci}, ${san}, 1) on conflict (epd, uci) do update set black = explorer_moves.black + 1`;
    else await sql`insert into explorer_moves (epd, uci, san, draws) values (${at}, ${uci}, ${san}, 1) on conflict (epd, uci) do update set draws = explorer_moves.draws + 1`;
  }
}

onFinish(async (g, result) => { if (result !== "aborted") await record(g); });

/** Counts the games played before the explorer existed, once. */
async function backfill() {
  const claimed = await sql`insert into flags (name) values ('explorer-backfill') on conflict do nothing returning name`;
  if (!claimed.length) return;
  const games = await sql`select * from games where status = 'finished' and result <> 'aborted' and variant = 'chess' and initial_fen is null order by updated_at limit 3000`;
  for (const g of games) await record(g);
}

export const explorerRoutes: Record<string, Handler> = {
  "GET explorer": async (_r, u) => {
    await backfill();
    const rows = await sql`select uci, san, white, draws, black from explorer_moves where epd = ${epd(u.searchParams.get("fen") ?? "")}
      order by white + draws + black desc limit 20`;
    return json({ moves: rows.map((r) => ({ uci: r.uci, san: r.san, white: r.white, draws: r.draws, black: r.black })) });
  },
};
