// End-to-end tests of the Castle Online server against a real (in-process) Postgres.
// Run with: npm test (in server/)
import fs from "node:fs";
import { WebSocket } from "ws";
import { checks, loadServer, until, wait } from "./harness.mjs";

const { call, db, livePath } = await loadServer();
const { ok, section, done } = checks();

// Lichess is stubbed: a token "lichess:<name>" signs in as <name>.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === "https://lichess.org/api/account") {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const m = auth.match(/^Bearer lichess:(\w+)$/);
    return m ? new Response(JSON.stringify({ id: m[1], username: m[1] })) : new Response("{}", { status: 401 });
  }
  return realFetch(url, init);
};

const guest = async () => {
  const g = await call("guest", {});
  return { ...g, id: g.profile.id };
};
const play = async (id, seats, ucis, from = 0) => {
  let last;
  for (let i = 0; i < ucis.length; i++) {
    const ply = from + i;
    last = await call("move", { id, key: seats[ply % 2], uci: ucis[i], ply });
  }
  return last;
};
const puzzles = new Map(JSON.parse(fs.readFileSync(new URL("../lib/puzzles-data.ts", import.meta.url), "utf8").match(/= (".*");/)[1])
  .split("\n").map((l) => l.split("\t")).map(([id, fen, moves]) => [id, { fen, moves: moves.split(" ") }]));

const A = await guest(), B = await guest(), C = await guest();

section("Games, variants and clocks");
ok(A.token && B.token, "guests are created (the schema builds itself)");
const s1 = await call("games", { token: A.token, name: "Ann", minutes: 3, increment: 0, color: "white", variant: "chess960" });
let g = await call(`game?id=${s1.id}`);
ok(g.variant === "chess960" && g.fen && g.category === "chess960", `a Chess960 game has its own start and category (${g.fen})`);
const j1 = await call("join", { token: B.token, name: "Bob", code: s1.code });
ok(j1.color === "black", "joining takes the empty seat");
ok((await play(s1.id, [s1.key, j1.key], ["e2e4", "e7e5"])).ply === 2, "960 moves are accepted");

const s2 = await call("games", { token: A.token, name: "Ann", minutes: 3, increment: 0, color: "white", variant: "atomic" });
const j2 = await call("join", { token: B.token, name: "Bob", code: s2.code });
const atomic = await play(s2.id, [s2.key, j2.key], ["g1f3", "d7d5", "f3e5", "a7a6", "e5f7"]);
ok(atomic.result === "1-0" && atomic.reason === "king exploded", "an atomic capture next to the king wins");

section("Presence and abandoned games");
const s3 = await call("games", { token: A.token, name: "Ann", minutes: 5, increment: 0, color: "white" });
const j3 = await call("join", { token: B.token, name: "Bob", code: s3.code });
await play(s3.id, [s3.key, j3.key], ["e2e4", "e7e5"]);
ok((await call("action", { id: s3.id, key: s3.key, action: "claim" }))._status === 409, "no claim while the opponent is connected");
await db.query("update games set black_seen = $1 where id = $2", [Date.now() - 40000, s3.id]);
g = await call(`game?id=${s3.id}`);
ok(g.away.black > 30000, "the view reports who is away");
const claimed = await call("action", { id: s3.id, key: s3.key, action: "claim" });
ok(claimed.result === "1-0" && claimed.reason === "abandonment", "claiming an abandoned game wins it");
const s4 = await call("games", { token: A.token, name: "Ann", minutes: 5, increment: 0 });
ok((await call("action", { id: s4.id, key: s4.key, action: "cancel" })).reason === "cancelled", "cancel withdraws a waiting game");

section("Ratings per category");
const s5 = await call("games", { token: A.token, name: "Ann", minutes: 1, increment: 0, color: "white", rated: true });
const j5 = await call("join", { token: B.token, name: "Bob", code: s5.code });
await play(s5.id, [s5.key, j5.key], ["e2e4", "e7e5"]);
const r5 = await call("action", { id: s5.id, key: j5.key, action: "resign" });
ok(r5.category === "bullet" && r5.white.after > r5.white.rating, "a 1+0 game is bullet, and the winner gains");
const claimA = await call("claim", { token: A.token, id: s5.id });
A.token = claimA.token;
ok(claimA.profile.ratings.bullet.r === r5.white.after && claimA.profile.ratings.bullet.g === 1, "the bullet rating is stored in the token");
ok(claimA.profile.rating - 1500 === r5.white.after - r5.white.rating, "the overall rating moves by the same amount (for Castle 2.3.0)");
const bulletBoard = await call("leaderboard?category=bullet"), rapidBoard = await call("leaderboard?category=rapid");
ok(bulletBoard.players.find((p) => p.guest === A.id)?.rating === r5.white.after && !rapidBoard.players.some((p) => p.guest === A.id),
  "leaderboards are per category");
ok((await call("leaderboard")).players.length >= 1, "the old all-categories leaderboard still answers");

section("Correspondence");
const c1 = await call("games", { token: A.token, name: "Ann", days: 2, minutes: 5, color: "white" });
const cj = await call("join", { token: B.token, name: "Bob", code: c1.code });
await play(c1.id, [c1.key, cj.key], ["d2d4"]);
await db.query("update games set last_move_at = $1 where id = $2", [Date.now() - 3600_000, c1.id]);
const cm = await call("move", { id: c1.id, key: cj.key, uci: "d7d5", ply: 1 });
ok(cm.days === 2 && cm.category === "correspondence", "a game with days per move is correspondence");
ok(cm.clocks.black === 2 * 86400000, "each move refills the mover's days");
ok(cm.away.white === null, "correspondence games can't be claimed as abandoned");
const inboxA = await call("inbox", { token: A.token, name: "Ann" });
ok(inboxA.correspondence.some((x) => x.id === c1.id && x.myTurn && x.key === c1.key), "the inbox lists correspondence games, with keys and whose turn");

section("Blocks, reports and names");
await call("block", { token: B.token, guest: A.id });
const bSeek = await call("games", { token: B.token, name: "Bob", minutes: 5, increment: 0 });
ok((await call("join", { token: A.token, name: "Ann", code: bSeek.code }))._status === 403, "a blocked player can't join your game");
ok((await call("challenge", { token: A.token, name: "Ann", to: B.id, minutes: 3 }))._status === 403, "nor challenge you");
ok((await call("blocks", { token: B.token })).blocked.includes(A.id), "blocks are listed");
await call("block", { token: B.token, guest: A.id, block: false });
await call("action", { id: bSeek.id, key: bSeek.key, action: "cancel" });
for (const r of [A, B, await guest()]) await call("report", { token: r.token, guest: C.id, reason: "chat" });
const muted = await call("chat", { id: s1.id, name: "Cy", text: "hello", token: C.token });
ok(muted._status === 403, "three different reports mute a guest's chat");
const named = await call("games", { token: C.token, name: "sh1thead", minutes: 5 });
ok((await call(`game?id=${named.id}`)).white.name === "Guest" || (await call(`game?id=${named.id}`)).black.name === "Guest", "offensive names become Guest");
await call("chat", { id: s1.id, name: "Watcher", text: "what the fuck" });
const lines = await call(`chat?id=${s1.id}&after=0`);
ok(lines.lines.some((l) => l.text === "what the ****"), "offensive words are starred out in chat");

section("Challenges and presence");
const ch = await call("challenge", { token: A.token, name: "Ann", to: B.id, minutes: 3, increment: 2, variant: "crazyhouse" });
let inbox = await call("inbox", { token: B.token, name: "Bob" });
ok(inbox.incoming.some((x) => x.variant === "crazyhouse" && x.name === "Ann"), "a challenge arrives in the inbox");
ok((await call("presence", { ids: [B.id] })).players[0].online, "presence shows who is online");
const acc = await call("answer", { token: B.token, name: "Bob", id: inbox.incoming.find((x) => x.name === "Ann").id, accept: true });
ok(acc.id === ch.id && (await call(`game?id=${ch.id}`)).status === "playing", "accepting starts the game");
const cd = await call("challenge", { token: A.token, name: "Ann", to: B.id, minutes: 3, days: 3 });
inbox = await call("inbox", { token: B.token, name: "Bob" });
ok(inbox.incoming.some((x) => x.days === 3), "correspondence challenges carry their days");
await call("answer", { token: B.token, id: inbox.incoming.find((x) => x.days === 3).id, accept: false });
ok((await call(`game?id=${cd.id}`)).reason === "declined", "declining cancels the game");

section("Moving a rating, and Lichess");
const moveCode = await call("transfer/create", { token: A.token });
ok(/^[A-Z2-9]{8}$/.test(moveCode.code), "a transfer code is issued");
const moved = await call("transfer/claim", { code: moveCode.code.toLowerCase() });
ok(moved.profile?.id === A.id && moved.profile.ratings.bullet, "the code brings the rating, category ratings and all");
const oldMe = await call("me", { token: A.token });
ok(oldMe._status === 401 && oldMe.code === "moved", "the old computer's copy stops working and says it moved");
A.token = moved.token;
ok((await call("transfer/claim", { code: moveCode.code }))._status === 404, "a code works once");
ok((await call("lichess/link", { token: A.token, lichessToken: "lichess:annchess" })).lichess === "annchess", "a rating links to a Lichess account");
ok((await call("lichess/link", { token: B.token, lichessToken: "lichess:annchess" }))._status === 409, "one Lichess account links to one rating");
const recovered = await call("lichess/recover", { lichessToken: "lichess:annchess" });
ok(recovered.profile?.id === A.id, "signing in to Lichess recovers the rating");
A.token = recovered.token;
ok((await call("lichess/recover", { lichessToken: "bad" }))._status === 401, "a bad Lichess sign-in is refused");

section("Arenas and berserk");
const ar = await call("arena/create", { token: A.token, name: "Ann", title: "Test arena", minutes: 3, increment: 2, startsIn: 0, duration: 30 });
await call("arena/join", { token: A.token, name: "Ann", id: ar.id });
await call("arena/join", { token: B.token, name: "Bob", id: ar.id });
const pa = await call("arena/pair", { token: A.token, id: ar.id });
const pb = await call("arena/pair", { token: B.token, id: ar.id });
ok(pa.status === "seated" && pb.seat.id === pa.seat.id, "two waiting players are paired");
const w = pa.seat.color === "white" ? pa.seat : pb.seat, bl = w === pa.seat ? pb.seat : pa.seat;
const bz = await call("action", { id: w.id, key: w.key, action: "berserk" });
ok(bz.berserk.white && bz.clocks.white === 90000, "berserk halves the clock");
await play(w.id, [w.key, bl.key], ["g1f3", "g8f6", "b1c3", "b8c6", "e2e3", "e7e6", "d2d3", "d7d6", "f1e2", "f8e7", "c1d2", "c8d7", "e1g1", "e8g8"]);
const bzMove = await call(`game?id=${w.id}`);
ok(bzMove.clocks.white <= 90000, "a berserk player gets no increment");
await call("action", { id: w.id, key: bl.key, action: "resign" });
const st = await call(`arena?id=${ar.id}`);
const winner = st.players.find((p) => p.guest === (w === pa.seat ? A.id : B.id));
ok(winner.score === 3, `a berserk win scores 3 (${winner.score})`);
await call("arena/leave", { token: B.token, id: ar.id });
ok((await call("arena/pair", { token: B.token, id: ar.id })).status === "paused", "leaving pauses pairing");
const arenas = await call("arenas");
ok(arenas.arenas.filter((a) => a.name.startsWith("Hourly")).length >= 3, "hourly arenas exist");

section("Swiss");
const sw = await call("swiss/create", { token: A.token, name: "Ann", title: "Test Swiss", minutes: 3, increment: 2, rounds: 3, startsIn: 5 });
for (const [p, n] of [[A, "Ann"], [B, "Bob"], [C, "Cy"]]) await call("swiss/join", { token: p.token, name: n, id: sw.id });
await db.query("update swiss set starts_at = $1 where id = $2", [Date.now() - 1000, sw.id]);
let sv = await call(`swiss?id=${sw.id}`);
ok(sv.swiss.status === "running" && sv.swiss.round === 1 && sv.pairings.length === 1, "round 1 pairs two players");
ok(sv.standings.filter((p) => p.points === 1).length === 1, "the odd player out gets a bye worth a point");
const seats = await Promise.all([A, B, C].map((p) => call("swiss/pair", { token: p.token, id: sw.id })));
const seated = seats.filter((s) => s.status === "seated");
ok(seated.length === 2 && seats.some((s) => s.status === "bye"), "two players are seated, one has the bye");
const sW = seated.find((s) => s.seat.color === "white").seat, sB = seated.find((s) => s.seat.color === "black").seat;
await play(sW.id, [sW.key, sB.key], ["f2f3", "e7e5", "g2g4", "d8h4"]);
await db.query("update swiss set round_done_at = $1 where id = $2", [Date.now() - 60_000, sw.id]);
await call(`swiss?id=${sw.id}`);
await db.query("update swiss set round_done_at = $1 where id = $2 and round_done_at is not null", [Date.now() - 60_000, sw.id]);
sv = await call(`swiss?id=${sw.id}`);
ok(sv.swiss.round === 2, `the next round starts when the round is over (round ${sv.swiss.round})`);
ok(sv.standings[0].points === 1 && sv.standings.some((p) => p.buchholz > 0), "standings carry points and Buchholz");
const r2 = await Promise.all([A, B, C].map((p) => call("swiss/pair", { token: p.token, id: sw.id })));
ok(r2.filter((s) => s.status === "bye").length === 1, "round 2 gives the bye to someone else");
const r2s = r2.filter((s) => s.seat);
await db.query("update games set updated_at = now() - interval '2 minutes' where id = $1", [r2s[0].seat.id]);
const forfeit = await call(`game?id=${r2s[0].seat.id}`);
ok(forfeit.result === "0-1" && forfeit.reason === "forfeit", "in a Swiss, not moving loses the game");
ok((await call("swisses")).swisses.some((s) => s.name === "Daily Swiss"), "a Daily Swiss is scheduled");

section("Checked puzzle rush and battles");
const rush = await call("race/rush", { token: A.token, name: "Ann", minutes: 3 });
ok(rush.run.status === "running" && rush.run.puzzle.played.length === 1, "a rush starts with a position and the setup move");
ok(!("moves" in rush.run.puzzle), "the app is never sent the solution");
const runRow = (await db.query("select puzzles from runs where id = $1", [rush.id])).rows[0];
let pz = puzzles.get(runRow.puzzles[0]);
let res;
for (let step = 1; step < pz.moves.length; step += 2) {
  res = await call("race/move", { id: rush.id, key: rush.key, index: 0, uci: pz.moves[step] });
  if (step + 1 < pz.moves.length - 1 || step + 2 < pz.moves.length) ok(res.result === "correct" ? res.reply === pz.moves[step + 1] : true, "a correct move gets the opponent's reply");
}
ok(res.result === "solved" && res.run.score === 1 && res.run.index === 1, "solving the puzzle scores a point");
pz = puzzles.get(runRow.puzzles[1]);
const bad = await call("race/move", { id: rush.id, key: rush.key, index: 1, uci: "a1a1" });
ok(bad.result === "wrong" && bad.answer === pz.moves[1] && bad.run.strikes === 1, "a wrong move is a strike, and the answer is shown");
ok((await call("race/move", { id: rush.id, key: rush.key, index: 1, uci: pz.moves[1] })).result === "stale", "a move for an old puzzle doesn't count");
await call("rush", { token: B.token, name: "Bob", minutes: 3, score: 99 });
await db.query("update runs set ends_at = $1 where id = $2", [Date.now() - 5000, rush.id]);
const board = await call("rush?minutes=3");
ok(board.scores.length === 1 && board.scores[0].score === 1 && board.scores[0].name === "Ann", "the rush board counts only checked runs (a made-up 99 doesn't appear)");
const race = await call("race/battle", { token: A.token, name: "Ann", minutes: 3 });
ok((await call("lobby")).races.some((r) => r.id === race.race), "an open battle is listed in the lobby");
const rj = await call("race/join", { token: B.token, name: "Bob", code: race.code });
ok((await call(`race?id=${race.race}`)).status === "countdown", "a battle counts down once joined");
await db.query("update races set started_at = $1 where id = $2", [Date.now() - 1000, race.race]);
await db.query("update runs set started_at = $1, ends_at = $2 where race_id = $3", [Date.now() - 1000, Date.now() + 170_000, race.race]);
const rr = (await db.query("select puzzles from runs where id = $1", [race.run])).rows[0];
const first = puzzles.get(rr.puzzles[0]);
for (let step = 1; step < first.moves.length; step += 2) await call("race/move", { id: race.run, key: race.key, index: 0, uci: first.moves[step] });
await call("race/move", { id: rj.run, key: rj.key, index: 0, uci: "h1h1" });
const rv = await call(`race?id=${race.race}`);
ok(rv.status === "running" && rv.a.score === 1 && rv.b.strikes === 1, "both players' scores come from checked moves");
const old = await call("battle", { token: A.token, name: "Ann", minutes: 3, puzzles: Array.from({ length: 12 }, (_, i) => ({ id: "p" + i, fen: "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1", moves: ["g1f1", "g8h8", "a1a8"] })) });
ok(old.code && (await call("lobby")).battles.some((x) => x.id === old.id), "Castle 2.3.0 battles still work");

section("Castle TV and sharing");
const tv = await call("tv");
ok(tv.id && tv.status === "playing" && tv.ply >= 2, "Castle TV picks a live game");
const page = await call(`g?id=${s2.code}`);
ok(page._type.startsWith("text/html") && page.text.includes("Ann vs Bob") && page.text.includes("Nxf7"), "the share page shows the game");
const pgn = await call(`g?id=${s2.code}.pgn`);
ok(pgn.text.includes('[Variant "Atomic"]') && pgn.text.includes("1. Nf3 d5 2. Ne5 a6 3. Nxf7") && pgn.text.includes("1-0"), "the PGN download has headers and moves");
ok((await call("g?id=NOPE99"))._status === 404, "an unknown game is a 404");

section("Live updates over a WebSocket");
const live = (await import(livePath)).default;
await new Promise((r) => live.listen(0, r));
const port = live.address().port;
const sock = new WebSocket(`ws://127.0.0.1:${port}`);
const got = [];
sock.on("message", (m) => got.push(JSON.parse(String(m))));
await new Promise((r) => sock.on("open", r));
const lg = await call("games", { token: A.token, name: "Ann", minutes: 5, increment: 0, color: "white" });
const lj = await call("join", { token: B.token, name: "Bob", code: lg.code });
sock.send(JSON.stringify({ t: "watch", games: [lg.id] }));
sock.send(JSON.stringify({ t: "rooms", rooms: [lg.id] }));
sock.send(JSON.stringify({ t: "hello", token: B.token }));
await until(() => got.some((m) => m.t === "game" && m.game.id === lg.id));
ok(got.some((m) => m.t === "game" && m.game.ply === 0), "watching sends the game at once");
const t0 = Date.now();
await call("move", { id: lg.id, key: lg.key, uci: "e2e4", ply: 0 });
await until(() => got.some((m) => m.t === "game" && m.game.ply === 1));
ok(got.some((m) => m.t === "game" && m.game.ply === 1), `a move is pushed (${Date.now() - t0} ms)`);
await call("chat", { id: lg.id, name: "Watcher", text: "nice" });
await until(() => got.some((m) => m.t === "room"));
ok(got.some((m) => m.t === "room" && m.lines[0].text === "nice"), "room chat is pushed");
await call("challenge", { token: A.token, name: "Ann", to: B.id, minutes: 3 });
await until(() => got.some((m) => m.t === "inbox"), 6000);
ok(got.some((m) => m.t === "inbox"), "a new challenge nudges the player's inbox");
sock.close();
live.close();

done();
