import { canMate, Result, startFen, Variant, variantOf } from "./chess.js";
import { Color, other, ping, Row, sql } from "./db.js";
import { categoryOf, gamesIn, ratingIn } from "./ratings.js";
import { elo, open, Profile, randomId } from "./token.js";

export const NEW_RATING = 1500;
/** A player not heard from for this long has left: the opponent may claim the game. */
export const ABANDON_MS = 30_000;
const DAY = 86_400_000;

export const fresh = (id: string): Profile => ({ id, rating: NEW_RATING, games: 0, wins: 0, losses: 0, draws: 0, peak: NEW_RATING, v: 0, ratings: {} });
export const variantFields = (g: Row) => [variantOf(g.variant), g.initial_fen as string | null] as const;
export const toMove = (g: Row): Color => (g.ply % 2 === 0 ? "white" : "black");
export const movesOf = (g: Row): string[] => (g.moves ? g.moves.split(" ") : []);

/** A token that decrypts and is the guest's latest. */
export async function verified(token: unknown): Promise<Profile | undefined> {
  const p = open(token);
  if (!p) return undefined;
  const rows = await sql`select version from guests where id = ${p.id}`;
  return rows.length && rows[0].version === p.v ? p : undefined;
}

/** Keeps a copy of the profile on the server, for moving it to another computer. */
export async function remember(p: Profile) {
  await sql`update guests set profile = ${JSON.stringify(p)} where id = ${p.id}`;
}

/** Clocks start once White has moved. Correspondence clocks count down days per move. */
export function clocks(g: Row, now = Date.now()): Record<Color, number> {
  const c = { white: Number(g.white_ms), black: Number(g.black_ms) };
  if (g.status === "playing" && g.ply >= 1 && g.last_move_at) c[toMove(g)] -= now - Number(g.last_move_at);
  return c;
}

/** Things to do whenever a game ends (arena points, Swiss points). */
type FinishHook = (g: Row, result: Result | "aborted") => Promise<void>;
const hooks: FinishHook[] = [];
export const onFinish = (h: FinishHook) => hooks.push(h);
/** Lets a tournament change how an aborted game counts (Swiss: a forfeit). */
type ResultRule = (g: Row, result: Result | "aborted", reason: string) => { result: Result | "aborted"; reason: string };
const rules: ResultRule[] = [];
export const onResult = (r: ResultRule) => rules.push(r);

/** Ends a game once. Ratings move for rated games of two moves or more. */
export async function finish(g: Row, result: Result | "aborted", reason: string): Promise<Row> {
  for (const r of rules) ({ result, reason } = r(g, result, reason));
  const now = Date.now();
  const c = clocks(g, now);
  let whiteNew: number | null = null, blackNew: number | null = null;
  if (g.rated && result !== "aborted" && g.ply >= 2 && g.white_rating != null && g.black_rating != null) {
    const score = result === "1-0" ? 1 : result === "0-1" ? 0 : 0.5;
    whiteNew = elo(g.white_rating, g.black_rating, score, g.white_cgames ?? 99);
    blackNew = elo(g.black_rating, g.white_rating, 1 - score, g.black_cgames ?? 99);
  }
  const rows = await sql`
    update games set status = 'finished', result = ${result}, reason = ${reason},
      white_ms = ${Math.max(0, c.white)}, black_ms = ${Math.max(0, c.black)}, last_move_at = ${now},
      white_new = ${whiteNew}, black_new = ${blackNew}, draw_offer = null, updated_at = now()
    where id = ${g.id} and status = 'playing' returning *`;
  if (rows[0]) for (const h of hooks) await h(rows[0], result);
  await ping({ t: "game", id: g.id });
  return rows[0] ?? (await load(g.id))!;
}

export async function load(id: unknown): Promise<Row | undefined> {
  if (typeof id !== "string") return undefined;
  const rows = await sql`select * from games where id = ${id}`;
  return rows[0];
}

/** How long a game may wait for its first two moves before it is aborted. */
const firstMoveWindow = (g: Row) => (g.days ? g.days * DAY : 60_000);

/** Loads a game and settles a flag that nobody has claimed yet (an abandoned game). */
export async function current(id: unknown): Promise<Row | undefined> {
  let g = await load(id);
  if (g?.status === "playing") g = await settle(g);
  return g;
}

export async function settle(g: Row): Promise<Row> {
  const c = clocks(g);
  const mover = toMove(g);
  if (g.ply >= 1 && c[mover] <= 0) {
    return finish(g, canMate(movesOf(g), other(mover), ...variantFields(g)) ? (mover === "white" ? "0-1" : "1-0") : "1/2-1/2", "time");
  }
  if (g.ply < 2 && Date.now() - new Date(g.updated_at).getTime() > firstMoveWindow(g)) return finish(g, "aborted", "no first move");
  return g;
}

/** Notes that a player is still there (at most every few seconds). */
export async function markSeen(g: Row, seat: Color) {
  const now = Date.now();
  if (Number(g[`${seat}_seen`] ?? 0) > now - 3000) return;
  g[`${seat}_seen`] = now;
  if (seat === "white") await sql`update games set white_seen = ${now} where id = ${g.id}`;
  else await sql`update games set black_seen = ${now} where id = ${g.id}`;
}

export function seatOf(g: Row, key: unknown): Color | undefined {
  if (typeof key !== "string" || !key) return undefined;
  return g.white_key === key ? "white" : g.black_key === key ? "black" : undefined;
}

/** What anyone may see of a game. */
export function view(g: Row) {
  const c = clocks(g);
  const now = Date.now();
  const away = (s: Color) => (g.status === "playing" && !g.days && g[`${s}_seen`] ? Math.max(0, now - Number(g[`${s}_seen`])) : null);
  return {
    id: g.id, code: g.code, status: g.status, rated: g.rated, public: g.public,
    minutes: g.minutes, increment: g.increment, days: g.days ?? null, variant: variantOf(g.variant), fen: g.initial_fen ?? null,
    category: g.category ?? null, arena: g.arena_id ?? null, swiss: g.swiss_id ?? null, round: g.swiss_round ?? null,
    berserk: { white: !!g.white_berserk, black: !!g.black_berserk },
    away: { white: away("white"), black: away("black") },
    white: { name: g.white_name, rating: g.white_rating, after: g.white_new, guest: g.white_guest },
    black: { name: g.black_name, rating: g.black_rating, after: g.black_new, guest: g.black_guest },
    moves: movesOf(g), ply: g.ply,
    clocks: { white: Math.max(0, c.white), black: Math.max(0, c.black) },
    running: g.status === "playing" && g.ply >= 1,
    drawOffer: g.draw_offer, result: g.result, reason: g.reason, rematch: g.rematch_id,
    /** Goes up when moves are taken back, so apps know a shorter game is the newer one. */
    rev: g.rev ?? 0, takeback: g.takeback_offer ?? null,
    now,
  };
}

export interface GameOptions { minutes: number; increment: number; days?: number | null; color: string; rated: boolean; public: boolean; variant: Variant }

export async function freshCode(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const c = randomId(4).replace(/[-_]/g, "x").slice(0, 6).toUpperCase();
    const taken = await sql`select 1 from games where code = ${c} union all select 1 from battles where code = ${c} union all select 1 from races where code = ${c}`;
    if (!taken.length) return c;
  }
  return randomId(6).toUpperCase();
}

/** Milliseconds on each clock at the start: days per move, or the time control. */
export const startMs = (o: { minutes: number; days?: number | null }) => (o.days ? o.days * DAY : Math.round(o.minutes * 60_000));

export async function createGame(p: Profile, name: string, o: GameOptions, swapFrom?: Row) {
  const id = randomId(), key = randomId(18);
  const color: Color = o.color === "white" || o.color === "black" ? o.color : Math.random() < 0.5 ? "white" : "black";
  const code = await freshCode();
  const fen = o.variant === "chess" ? null : startFen(o.variant);
  const days = o.days ?? null;
  const category = categoryOf(o.variant, o.minutes, o.increment, days);
  const ms = startMs({ minutes: o.minutes, days });
  const rating = ratingIn(p, category), cgames = gamesIn(p, category);
  const seat = color === "white"
    ? { white_guest: p.id, white_name: name, white_key: key, white_rating: rating, white_cgames: cgames }
    : { black_guest: p.id, black_name: name, black_key: key, black_rating: rating, black_cgames: cgames };
  await sql`
    insert into games (id, code, public, rated, minutes, increment, days, creator_color, variant, initial_fen, category,
      white_guest, white_name, white_key, white_rating, white_cgames, black_guest, black_name, black_key, black_rating, black_cgames, white_ms, black_ms)
    values (${id}, ${code}, ${o.public}, ${o.rated}, ${o.minutes}, ${o.increment}, ${days}, ${o.color}, ${o.variant}, ${fen}, ${category},
      ${seat.white_guest ?? null}, ${seat.white_name ?? null}, ${seat.white_key ?? null}, ${seat.white_rating ?? null}, ${seat.white_cgames ?? null},
      ${seat.black_guest ?? null}, ${seat.black_name ?? null}, ${seat.black_key ?? null}, ${seat.black_rating ?? null}, ${seat.black_cgames ?? null}, ${ms}, ${ms})`;
  if (swapFrom) await sql`update games set rematch_id = ${id}, updated_at = now() where id = ${swapFrom.id}`;
  return { id, code, color, key };
}

/** Whether either guest has blocked the other. */
export async function blocked(a: string | null | undefined, b: string | null | undefined): Promise<boolean> {
  if (!a || !b) return false;
  const rows = await sql`select 1 from blocks where (guest = ${a} and blocked = ${b}) or (guest = ${b} and blocked = ${a}) limit 1`;
  return rows.length > 0;
}

/** Seats a guest in the empty chair of a waiting game, which starts it. */
export async function takeSeat(g: Row, p: Profile, name: string) {
  const color: Color = g.white_key ? "black" : "white";
  const key = randomId(18);
  const category = g.category ?? categoryOf(variantOf(g.variant), g.minutes, g.increment, g.days);
  const rating = ratingIn(p, category), cgames = gamesIn(p, category);
  const rows = color === "white"
    ? await sql`update games set white_guest = ${p.id}, white_name = ${name}, white_key = ${key}, white_rating = ${rating}, white_cgames = ${cgames}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`
    : await sql`update games set black_guest = ${p.id}, black_name = ${name}, black_key = ${key}, black_rating = ${rating}, black_cgames = ${cgames}, status = 'playing', updated_at = now() where id = ${g.id} and status = 'waiting' returning id`;
  if (rows.length) await ping({ t: "game", id: g.id });
  return rows.length ? { id: g.id as string, code: g.code as string, color, key } : undefined;
}

/** Inserts a game with both players already seated (arenas and Swiss rounds). */
export async function pairedGame(o: { minutes: number; increment: number; variant: Variant; arena?: string; swiss?: string; round?: number },
  white: { guest: string; name: string; profileRating: number | null }, black: { guest: string; name: string; profileRating: number | null }) {
  const id = randomId(), code = await freshCode(), wk = randomId(18), bk = randomId(18);
  const fen = o.variant === "chess" ? null : startFen(o.variant);
  const ms = startMs(o);
  const category = categoryOf(o.variant, o.minutes, o.increment);
  await sql`insert into games (id, code, status, public, rated, minutes, increment, creator_color, variant, initial_fen, category, arena_id, swiss_id, swiss_round,
      white_guest, white_name, white_key, white_rating, black_guest, black_name, black_key, black_rating, white_ms, black_ms)
    values (${id}, ${code}, 'playing', true, true, ${o.minutes}, ${o.increment}, 'random', ${o.variant}, ${fen}, ${category}, ${o.arena ?? null}, ${o.swiss ?? null}, ${o.round ?? null},
      ${white.guest}, ${white.name}, ${wk}, ${white.profileRating}, ${black.guest}, ${black.name}, ${bk}, ${black.profileRating}, ${ms}, ${ms})`;
  return { id, code, wk, bk };
}
