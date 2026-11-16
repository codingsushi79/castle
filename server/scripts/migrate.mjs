// Creates the tables. Run with DATABASE_URL set: npm run migrate
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL);
const statements = [
  `create table if not exists guests (
     id text primary key,
     version integer not null default 0,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists games (
     id text primary key,
     code text unique not null,
     status text not null default 'waiting',      -- waiting, playing, finished
     public boolean not null default true,
     rated boolean not null default true,
     minutes real not null,
     increment integer not null,
     creator_color text not null,                 -- white, black or random
     white_guest text, black_guest text,
     white_name text, black_name text,
     white_key text, black_key text,
     white_rating integer, black_rating integer,
     white_new integer, black_new integer,
     white_claimed boolean not null default false,
     black_claimed boolean not null default false,
     moves text not null default '',
     ply integer not null default 0,
     white_ms bigint not null, black_ms bigint not null,
     last_move_at bigint,
     draw_offer text,
     result text, reason text,
     rematch_id text,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists games_status on games (status, updated_at desc)`,
  `create index if not exists games_white on games (white_guest, updated_at desc)`,
  `create index if not exists games_black on games (black_guest, updated_at desc)`,
  `create table if not exists signals (
     id bigserial primary key,
     game_id text not null,
     to_color text not null,
     body jsonb not null,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists signals_game on signals (game_id, to_color, id)`,
];
for (const s of statements) await sql.query(s);
console.log("Tables ready.");
