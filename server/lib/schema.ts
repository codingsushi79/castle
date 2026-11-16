import type { NeonQueryFunction } from "@neondatabase/serverless";

/**
 * The server sets up its own tables. Each step runs once: the schema version
 * is kept in the database, so a warm server checks one row and moves on.
 * Steps only ever add (tables, columns, indexes), so older servers keep working.
 */
const STEPS: string[][] = [
  // 1: Castle Online 2.2
  [
    `create table if not exists guests (id text primary key, version integer not null default 0, created_at timestamptz not null default now())`,
    `create table if not exists games (
       id text primary key, code text unique not null, status text not null default 'waiting',
       public boolean not null default true, rated boolean not null default true,
       minutes real not null, increment integer not null, creator_color text not null,
       white_guest text, black_guest text, white_name text, black_name text, white_key text, black_key text,
       white_rating integer, black_rating integer, white_new integer, black_new integer,
       white_claimed boolean not null default false, black_claimed boolean not null default false,
       moves text not null default '', ply integer not null default 0,
       white_ms bigint not null, black_ms bigint not null, last_move_at bigint, draw_offer text,
       result text, reason text, rematch_id text,
       created_at timestamptz not null default now(), updated_at timestamptz not null default now())`,
    `create index if not exists games_status on games (status, updated_at desc)`,
    `create index if not exists games_white on games (white_guest, updated_at desc)`,
    `create index if not exists games_black on games (black_guest, updated_at desc)`,
    `create table if not exists signals (id bigserial primary key, game_id text not null, to_color text not null, body jsonb not null, created_at timestamptz not null default now())`,
    `create index if not exists signals_game on signals (game_id, to_color, id)`,
  ],
  // 2: Castle 2.3: variants, presence, challenges, spectators, puzzles, arenas
  [
    `alter table games add column if not exists variant text not null default 'chess'`,
    `alter table games add column if not exists initial_fen text`,
    `alter table games add column if not exists white_seen bigint`,
    `alter table games add column if not exists black_seen bigint`,
    `alter table games add column if not exists arena_id text`,
    `alter table guests add column if not exists name text`,
    `alter table guests add column if not exists last_seen timestamptz`,
    `create table if not exists challenges (
       id text primary key, from_guest text not null, from_name text not null, from_rating integer,
       to_guest text not null, game_id text not null, code text not null,
       minutes real not null, increment integer not null, rated boolean not null, variant text not null,
       status text not null default 'open', created_at timestamptz not null default now())`,
    `create index if not exists challenges_to on challenges (to_guest, status, created_at desc)`,
    `create index if not exists challenges_from on challenges (from_guest, created_at desc)`,
    `create table if not exists chat (id bigserial primary key, game_id text not null, name text not null, kind text not null, text text not null, created_at timestamptz not null default now())`,
    `create index if not exists chat_game on chat (game_id, id)`,
    `create table if not exists rush_scores (id bigserial primary key, guest text not null, name text not null, minutes integer not null, score integer not null, created_at timestamptz not null default now())`,
    `create index if not exists rush_best on rush_scores (minutes, score desc)`,
    `create table if not exists battles (
       id text primary key, code text unique not null, public boolean not null default true,
       minutes integer not null, puzzles jsonb not null, started_at bigint,
       a_guest text not null, a_name text not null, a_key text not null, a_score integer not null default 0, a_strikes integer not null default 0,
       b_guest text, b_name text, b_key text, b_score integer not null default 0, b_strikes integer not null default 0,
       created_at timestamptz not null default now())`,
    `create table if not exists arenas (
       id text primary key, name text not null, minutes real not null, increment integer not null,
       variant text not null default 'chess', starts_at bigint not null, ends_at bigint not null, created_by text)`,
    `create index if not exists arenas_end on arenas (ends_at)`,
    `create table if not exists arena_players (
       arena_id text not null, guest text not null, name text not null, rating integer,
       score integer not null default 0, streak integer not null default 0, games integer not null default 0,
       waiting_since bigint, last_poll bigint, paused boolean not null default false, last_opponent text, seat_game text, seat_key text, seat_color text,
       primary key (arena_id, guest))`,
  ],
];

let ready: Promise<void> | undefined;

export function ensureSchema(sql: NeonQueryFunction<false, false>): Promise<void> {
  ready ??= (async () => {
    await sql`create table if not exists schema_version (v integer not null)`;
    // Two servers starting at once may both get here: every step is "if not exists", so that is harmless.
    const rows = await sql`select max(v) as v from schema_version`;
    let v = Number(rows[0]?.v ?? 0);
    if (rows[0]?.v == null) await sql`insert into schema_version (v) values (0)`;
    for (; v < STEPS.length; v++) {
      for (const statement of STEPS[v]) await sql.query(statement);
      await sql`update schema_version set v = ${v + 1}`;
    }
  })().catch((e) => {
    ready = undefined; // try again on the next request
    throw e;
  });
  return ready;
}
