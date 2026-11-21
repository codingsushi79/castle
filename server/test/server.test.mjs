// End-to-end tests of the Castle Online server against a real (in-process) Postgres.
// Run with: npm test (in server/)
import fs from "node:fs";
import { WebSocket } from "ws";
import { checks, loadServer, until, wait } from "./harness.mjs";

const { api, call, db, livePath } = await loadServer();
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
for (const fine of ["Knights", "NigeriaFan", "Scunthorpe", "Grapes", "Peacock", "Dickens", "Shiitake"]) {
  const g9 = await call("games", { token: C.token, name: fine, minutes: 5 });
  const v9 = await call(`game?id=${g9.id}`);
  ok((v9.white.name ?? v9.black.name) === fine, `an ordinary name is kept: ${fine}`);
}
for (const bad of ["n1gg4", "F_U_C_K", "fagg0t"]) {
  const g9 = await call("games", { token: C.token, name: bad, minutes: 5 });
  const v9 = await call(`game?id=${g9.id}`);
  ok((v9.white.name ?? v9.black.name) === "Guest", `a disguised slur is caught: ${bad}`);
}
await call("chat", { id: s1.id, name: "Watcher", text: "the Knights of Nigeria" });
await call("chat", { id: s1.id, name: "Watcher", text: "what the fuck" });
const lines = await call(`chat?id=${s1.id}&after=0`);
ok(lines.lines.some((l) => l.text === "what the ****"), "offensive words are starred out in chat");
ok(lines.lines.some((l) => l.text === "the Knights of Nigeria"), "ordinary words in chat are left alone");

// Players' chat through the server, for games that aren't connected directly.
const said = await call("say", { id: c1.id, key: c1.key, text: "what the fuck, gg", token: A.token });
ok(said.ok && said.text === "what the ****, gg", "relayed player chat goes through the same word filter");
const forBob = await call(`signal?id=${c1.id}&key=${cj.key}&after=0`);
const forAnn = await call(`signal?id=${c1.id}&key=${c1.key}&after=0`);
ok(forBob.signals.some((x) => x.body.t === "chat" && x.body.text === "what the ****, gg") && !forAnn.signals.some((x) => x.body.t === "chat"), "it waits for the opponent only, behind their seat key");
ok((await call("say", { id: c1.id, key: "not-a-key", text: "hi" }))._status === 403, "only the players can send it");
ok((await call(`signal?id=${c1.id}&key=nope&after=0`))._status === 403, "or read it");
ok((await call("say", { id: c1.id, key: cj.key, text: "hi", token: C.token }))._status === 403, "a muted guest can't use it either");
let slow;
for (let i = 0; i < 8 && !slow; i++) { const r = await call("say", { id: c1.id, key: cj.key, text: `spam ${i}` }); if (r._status === 429) slow = i; }
ok(slow !== undefined && slow >= 5, `and it's rate limited like room chat (stopped after ${slow})`);

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
const lonely = await call("swiss/create", { token: C.token, name: "Cy", title: "Lonely Swiss", minutes: 3, increment: 0, rounds: 3, startsIn: 5 });
await db.query("update swiss set starts_at = $1 where id = $2", [Date.now() - 1000, lonely.id]);
ok((await call("swisses")).swisses.find((s) => s.id === lonely.id)?.status === "finished", "a Swiss nobody joined ends at its start time, even if only the list is opened");

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
sock.send(JSON.stringify({ t: "ping" }));
await until(() => got.some((m) => m.t === "pong"));
ok(got.find((m) => m.t === "pong")?.mode === "push", "the live server listens for changes (push mode)");
const before = got.length, t1 = Date.now();
await call("move", { id: lg.id, key: lj.key, uci: "e7e5", ply: 1 });
await until(() => got.slice(before).some((m) => m.t === "game" && m.game.ply === 2), 3000);
ok(Date.now() - t1 < 1000, `a pushed move arrives without waiting for a check (${Date.now() - t1} ms)`);
sock.close();
live.close();

section("Puzzle storm");
const storm = await call("race/storm", { token: A.token, name: "Ann" });
ok(storm.run.kind === "storm" && storm.run.status === "running", "a storm starts");
const stormIds = (await db.query("select puzzles, ends_at from runs where id = $1", [storm.id])).rows[0];
const endsBefore = Number(stormIds.ends_at);
const wrong = await call("race/move", { id: storm.id, key: storm.key, index: 0, uci: "a1a1" });
ok(wrong.result === "wrong" && wrong.run.status === "running" && wrong.run.endsAt === endsBefore - 10000, "a miss costs ten seconds, not a strike-out");
for (let i = 0; i < 3; i++) await call("race/move", { id: storm.id, key: storm.key, index: i + 1, uci: "a1a1" });
ok((await call(`race/run?id=${storm.id}&key=${storm.key}`)).status === "running", "storms have no three-strikes rule");
await db.query("update runs set combo = 4, idx = 10, step = 1 where id = $1", [storm.id]);
const p10 = puzzles.get(stormIds.puzzles[10]);
let sres;
for (let step = 1; step < p10.moves.length; step += 2) sres = await call("race/move", { id: storm.id, key: storm.key, index: 10, uci: p10.moves[step] });
ok(sres.result === "solved" && sres.run.combo === 5 && sres.run.endsAt === endsBefore - 40000 + 3000, "five in a row earns three seconds");
await db.query("update runs set ends_at = $1 where id = $2", [Date.now() - 1000, storm.id]);
ok((await call("rush?kind=storm")).scores.some((x) => x.name === "Ann"), "storms have their own leaderboard");

section("Takebacks and notes");
const casual = await call("games", { token: A.token, name: "Ann", minutes: 10, increment: 0, color: "white", rated: false });
const cj2 = await call("join", { token: B.token, name: "Bob", code: casual.code });
await play(casual.id, [casual.key, cj2.key], ["e2e4", "e7e5", "g1f3"]);
await call("action", { id: casual.id, key: cj2.key, action: "takeback" });
let tb = await call(`game?id=${casual.id}`);
ok(tb.takeback === "black", "a takeback is asked for");
tb = await call("action", { id: casual.id, key: casual.key, action: "takeback" });
ok(tb.ply === 1 && tb.moves.join(" ") === "e2e4" && tb.rev === 1, "accepting it undoes the asker's move and the reply");
ok((await call("action", { id: s5.id, key: s5.key, action: "takeback" }))._status === 409, "no takebacks in rated games");
await call("notes", { id: casual.id, key: casual.key, text: "Try the Italian next time" });
ok((await call(`notes?id=${casual.id}&key=${casual.key}`)).text === "Try the Italian next time", "notes are saved with the game");
ok((await call(`notes?id=${casual.id}&key=${cj2.key}`)).text === "", "and are private to each player");
ok((await call(`notes?id=${casual.id}&key=nope`))._status === 403, "nobody else can read them");

section("Stats and accuracy flags");
const stats = await call(`stats?guest=${A.id}`);
ok(stats.games.length >= 3 && stats.games.every((x) => ["white", "black"].includes(x.color) && typeof x.score === "number"), "stats list your games with colour and score");
ok(stats.games.some((x) => x.category === "bullet" && x.after), "with ratings by category");
process.env.ADMIN_KEY = "test-admin-key-123";
const cheat = await guest();
for (let i = 0; i < 8; i++) {
  const g1 = await call("games", { token: cheat.token, name: "Sus", minutes: 3, increment: 0, color: "white", rated: false });
  const j9 = await call("join", { token: B.token, name: "Bob", code: g1.code });
  await db.query("update games set status = 'finished', result = '1-0', ply = 30 where id = $1", [g1.id]);
  await call("accuracy", { id: g1.id, key: j9.key, white: 97, black: 70 });
  await call("accuracy", { id: g1.id, key: g1.key, white: 50, black: 50 });
}
const modList = await call("mod/list", { key: "test-admin-key-123" });
ok(modList.flagged.some((f) => f.guest === cheat.id && f.accuracy === 97 && f.games === 8), "eight opponent-reviewed games at 97% flag a player (their own reports don't count)");
ok(modList.reported.some((r) => r.guest === C.id && r.reporters === 3), "the moderation list shows reported players");
ok((await call("mod/list", { key: "wrong" }))._status === 401, "the moderation list needs the key");
ok((await call("g?id=x")).text !== undefined && (await call("mod")).text.includes("Castle Online moderation"), "the moderation page is served");

section("Bans");
await call("mod/ban", { key: "test-admin-key-123", guest: cheat.id, days: 7, reason: "engine use" });
const banned = await call("games", { token: cheat.token, name: "Sus", minutes: 3 });
ok(banned._status === 403 && banned.code === "banned" && banned.error.includes("engine use"), "a banned player can't start games, and is told why");
ok((await call("chat", { id: s1.id, name: "Sus", text: "hi", token: cheat.token }))._status === 403, "or chat");
ok((await call("me", { token: cheat.token })).banned?.reason === "engine use", "their app is told about the ban");
await call("mod/unban", { key: "test-admin-key-123", guest: cheat.id });
ok((await call("games", { token: cheat.token, name: "Sus", minutes: 3 })).key, "unbanning lifts it");

section("Teams and team battles");
const tA = await call("team/create", { token: A.token, name: "Ann", title: "Knights" });
ok(tA.team?.code && tA.team.members.length === 1, "a team is created with a join code");
ok((await call("team/create", { token: A.token, name: "Ann", title: "Other" }))._status === 409, "one team at a time");
const tB = await call("team/create", { token: B.token, name: "Bob", title: "Rooks" });
const D = await guest();
await call("team/join", { token: D.token, name: "Dee", code: tA.team.code });
ok((await call("team/mine", { token: A.token })).team.members.length === 2, "players join by code");
const tbattle = await call("arena/create", { token: A.token, name: "Ann", title: "Knights v Rooks", minutes: 3, increment: 0, startsIn: 0, duration: 30, teams: [tA.team.code, tB.team.code], leaders: 2 });
ok(tbattle.id, "a team battle is created");
ok((await call("arena/join", { token: C.token, name: "Cy", id: tbattle.id }))._status === 403, "only the teams' members can join");
for (const [p, n] of [[A, "Ann"], [D, "Dee"], [B, "Bob"]]) await call("arena/join", { token: p.token, name: n, id: tbattle.id });
const pA2 = await call("arena/pair", { token: A.token, id: tbattle.id });
const pD2 = await call("arena/pair", { token: D.token, id: tbattle.id });
ok(pA2.status !== "seated" || pA2.seat.id !== pD2.seat?.id, "teammates aren't paired against each other");
const pB2 = await call("arena/pair", { token: B.token, id: tbattle.id });
const tbGame = [pA2, pD2].find((x) => x.seat && x.seat.id === pB2.seat?.id);
ok(!!tbGame, "a Knight is paired with a Rook");
const kn = tbGame.seat, rk = pB2.seat;
const wk = kn.color === "white" ? kn : rk, bk = wk === kn ? rk : kn;
await play(wk.id, [wk.key, bk.key], ["e2e4", "e7e5"]);
await call("action", { id: rk.id, key: rk.key, action: "resign" });
const tst = await call(`arena?id=${tbattle.id}`);
ok(tst.arena.teamLeaders === 2 && tst.teams[0].name === "Knights" && tst.teams[0].score === 2, "the team table counts the winners' points");
await call("team/leave", { token: D.token });
ok((await call("team/mine", { token: D.token })).team === null, "players can leave a team");

section("Error reports");
const er = await call("error", { version: "2.3.1-3", platform: "macos", page: "play", message: "TypeError at /Users/sasha/code/x.js", stack: "at f (/Users/sasha/a.js:1)" });
ok(er.ok, "an error report is accepted");
const errs = (await call("mod/list", { key: "test-admin-key-123" })).errors;
ok(errs.length === 1 && errs[0].message === "TypeError at /Users/…/code/x.js" && !errs[0].stack.includes("sasha"), "home-folder paths are blanked out, and the moderation page lists it");

section("Phone alerts (web push)");
const crypto = await import("node:crypto");
// A stand-in push service: push services are HTTPS, so this one gets a throwaway self-signed certificate.
const https = await import("node:https");
const { execFileSync } = await import("node:child_process");
const certDir = fs.mkdtempSync((await import("node:os")).tmpdir() + "/castle-push-");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${certDir}/key.pem`, "-out", `${certDir}/cert.pem`, "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const pushes = [];
const sink = https.createServer({ key: fs.readFileSync(`${certDir}/key.pem`), cert: fs.readFileSync(`${certDir}/cert.pem`) },
  (req, res) => { pushes.push({ url: req.url, auth: req.headers.authorization ?? "", encoding: req.headers["content-encoding"] }); req.resume(); res.writeHead(201); res.end(); });
await new Promise((r) => sink.listen(0, r));
const phoneKey = crypto.createECDH("prime256v1"); phoneKey.generateKeys();
const subscription = { endpoint: `https://127.0.0.1:${sink.address().port}/push/bob-phone`, keys: { p256dh: phoneKey.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
ok((await call("push/key")).key.length > 80, "the server publishes its push key");
const acode = await call("alerts/code", { token: B.token });
ok(/^[A-Z2-9]{8}$/.test(acode.code) && acode.url.includes(acode.code), "a phone-link code and URL are made");
ok((await call("alerts")).text.includes("Castle alerts") && (await call("sw"))._type.startsWith("text/javascript"), "the alerts page and service worker are served");
const sub = await call("alerts/subscribe", { code: acode.code, subscription });
await until(() => pushes.length >= 1, 4000);
ok(sub.ok && pushes.length === 1 && pushes[0].auth.startsWith("vapid t=") && pushes[0].encoding === "aes128gcm", "the phone is linked and gets a signed, encrypted test alert");
ok((await call("alerts/devices", { token: B.token })).devices === 1, "the player sees one linked device");
const pc = await call("games", { token: A.token, name: "Ann", days: 1, minutes: 5, color: "white" });
const pj = await call("join", { token: B.token, name: "Bob", code: pc.code });
await call("move", { id: pc.id, key: pc.key, uci: "e2e4", ply: 0 });
await until(() => pushes.length >= 2, 4000);
ok(pushes.length === 2, "a correspondence move alerts the opponent's phone");
await call("challenge", { token: A.token, name: "Ann", to: B.id, minutes: 3 });
await until(() => pushes.length >= 3, 4000);
ok(pushes.length === 3, "so does a challenge");
await call("alerts/devices", { token: B.token, clear: true });
ok((await call("alerts/devices", { token: B.token })).devices === 0, "devices can be removed");
sink.close();
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

section("Bots");
ok((await call("bots")).bots.length === 6, "six bots are listed");
const bw = await call("bot/play", { token: A.token, name: "Ann", bot: "amara", minutes: 5, increment: 0, color: "white" });
let bg = await call(`game?id=${bw.id}`);
ok(bg.status === "playing" && !bg.rated && bg.black.guest === "bot:amara" && bg.black.name === "Amara (bot)", "a bot game starts at once, unrated and marked as a bot");
bg = await call("move", { id: bw.id, key: bw.key, uci: "e2e4", ply: 0 });
ok(bg.ply === 2, `the bot answers at once (${bg.moves[1]})`);
const bb = await call("bot/play", { token: A.token, name: "Ann", bot: "pip", minutes: 5, increment: 0, color: "black" });
ok((await call(`game?id=${bb.id}`)).ply === 1, "a bot with White moves first");
for (let i = 0; i < 6; i++) {
  const v = await call(`game?id=${bb.id}`);
  if (v.status !== "playing") break;
  const { positionAfter } = await import("./.build/bot-entry.mjs");
  const pos = positionAfter(v.moves);
  const [from, tos] = [...pos.allDests()].find(([, t]) => t.nonEmpty());
  const to = [...tos][0];
  const f = "abcdefgh"[from & 7] + ((from >> 3) + 1), t = "abcdefgh"[to & 7] + ((to >> 3) + 1);
  await call("move", { id: bb.id, key: bb.key, uci: f + t, ply: v.ply });
}
ok((await call(`game?id=${bb.id}`)).ply >= 7, "a game against a bot goes on move after move");
const { chooseMove, BOTS, positionFromFen } = await import("./.build/bot-entry.mjs");
const mateIn1 = positionFromFen("6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1");
const m1 = chooseMove(mateIn1, BOTS.find((b) => b.id === "ingrid"));
ok(m1.from === 0 && m1.to === 56, "Ingrid finds a back-rank mate in one");
const hang = positionFromFen("4k3/8/8/8/8/8/3q4/4K3 w - - 0 1");
const m2 = chooseMove(hang, BOTS.find((b) => b.id === "dmitri"));
ok(m2.to === 11, "Dmitri takes a hanging queen");

section("Simuls");
const sim = await call("simul/create", { token: A.token, name: "Ann", title: "Ann's simul", minutes: 10, increment: 5, seats: 4, color: "white" });
ok(sim.id, "a simul is created");
await call("simul/join", { token: B.token, name: "Bob", id: sim.id });
await call("simul/join", { token: C.token, name: "Cy", id: sim.id });
ok((await call("simul/join", { token: A.token, name: "Ann", id: sim.id }))._status === 409, "the host can't join their own simul");
ok((await call("simuls")).simuls.find((x) => x.id === sim.id)?.players.length === 2, "players sign up");
ok((await call("simul/start", { token: B.token, id: sim.id }))._status === 409, "only the host can start it");
await call("simul/start", { token: A.token, id: sim.id });
const hostSeats = (await call("simul/seats", { token: A.token, id: sim.id })).seats;
const bobSeat = (await call("simul/seats", { token: B.token, id: sim.id })).seats;
ok(hostSeats.length === 2 && hostSeats.every((x) => x.color === "white") && bobSeat.length === 1 && bobSeat[0].color === "black", "the host has a board with each player, as White");
const simView = await call(`simul?id=${sim.id}`);
ok(simView.simul.status === "running" && simView.games.length === 2 && simView.games.every((x) => !x.rated), "the simul runs two casual games");
for (const hs of hostSeats) await call("action", { id: hs.id, key: hs.key, action: "abort" });
ok((await call(`simul?id=${sim.id}`)).simul.status === "finished", "it ends when every game has");

section("Studies");
const stu = await call("study/create", { token: A.token, name: "Ann", title: "Italian ideas", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 *" });
let sd = await call(`study?id=${stu.id}`);
ok(sd.title === "Italian ideas" && sd.chapters.length === 1 && sd.chapters[0].pgn.includes("Bc4") && sd.chapters[0].rev === 0, "a study starts with a chapter");
const ch1 = sd.chapters[0];
ok((await call("study/chapter", { id: stu.id, edit: "wrong", chapter: ch1.id, rev: 0, pgn: "1. d4 *" }))._status === 403, "editing needs the edit code");
const saved = await call("study/chapter", { id: stu.id, edit: stu.edit, chapter: ch1.id, rev: 0, pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 *" });
ok(saved.chapter.rev === 1, "a save moves the chapter to the next revision");
const stale = await call("study/chapter", { id: stu.id, edit: stu.edit, chapter: ch1.id, rev: 0, pgn: "1. e4 c5 *" });
ok(stale._status === 409 && stale.conflict && stale.chapter.pgn.includes("Bc5"), "a save from an old revision is refused with the current text");
await call("study/chapter", { id: stu.id, edit: stu.edit, title: "Two Knights", pgn: "1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 *" });
await call("study/rename", { id: stu.id, edit: stu.edit, title: "Italian Game" });
sd = await call(`study?id=${stu.id}`);
ok(sd.chapters.length === 2 && sd.chapters[1].title === "Two Knights" && sd.title === "Italian Game", "chapters are added and studies renamed");
ok((await call("study/mine", { token: A.token })).studies.some((x) => x.id === stu.id && x.edit === stu.edit), "your studies are listed with their edit codes");
await call("study/delete-chapter", { id: stu.id, edit: stu.edit, chapter: sd.chapters[1].id });
ok((await call(`study?id=${stu.id}`)).chapters.length === 1, "chapters can be deleted");

section("Opening explorer");
const ex = await call(`explorer?fen=${encodeURIComponent("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")}`);
const f3 = ex.moves.find((m) => m.san === "f3");
ok(f3 && f3.black >= 1, "games played before the explorer existed are counted (the arena's fool's mate)");
const e4 = ex.moves.find((m) => m.san === "e4");
const before4 = e4 ? e4.white + e4.draws + e4.black : 0;
const xg = await call("games", { token: A.token, name: "Ann", minutes: 5, increment: 0, color: "white", rated: false });
const xj = await call("join", { token: B.token, name: "Bob", code: xg.code });
await play(xg.id, [xg.key, xj.key], ["e2e4", "c7c5", "g1f3", "d7d6"]);
await call("action", { id: xg.id, key: xj.key, action: "resign" });
const ex2 = await call(`explorer?fen=${encodeURIComponent("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")}`);
const e4b = ex2.moves.find((m) => m.san === "e4");
ok(e4b.white + e4b.draws + e4b.black === before4 + 1, "each new game is added as it ends");
const sic = await call(`explorer?fen=${encodeURIComponent("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1")}`);
ok(sic.moves.some((m) => m.san === "c5" && m.white >= 1), "with results from each side");

section("Profiles and team pages");
await db.query("update arenas set ends_at = $1 where id = $2", [Date.now() - 1000, ar.id]);
const prof = await call(`profile?guest=${A.id}`);
ok(prof.name && prof.ratings.bullet && prof.recent.length > 0, "a profile has ratings and recent games");
ok(prof.trophies.some((t) => t.kind === "arena" && t.rank <= 3), "and trophies from arenas");
const ppage = await call(`p?id=${A.id}`);
ok(ppage._type.startsWith("text/html") && ppage.text.includes("Recent games"), "the profile page is served");

// Profile pictures: a 1×1 PNG, and the same bytes claiming to be a JPEG.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
ok(prof.avatar === null && (await call(`avatar?guest=${A.id}`))._status === 404, "a profile has no picture to begin with");
ok((await call("avatar", { token: A.token, image: `data:image/jpeg;base64,${PNG}` }))._status === 400, "a picture must be what it says it is");
ok((await call("avatar", { token: A.token, image: `data:image/svg+xml;base64,${Buffer.from("<svg/>").toString("base64")}` }))._status === 400, "and a JPEG, PNG or WebP (no SVG)");
ok((await call("avatar", { token: A.token, image: `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(70_000)]).toString("base64")}` }))._status === 400, "and small");
ok((await call("avatar", { token: "nope", image: `data:image/png;base64,${PNG}` }))._status === 401, "and needs a valid token");
const setPic = await call("avatar", { token: A.token, image: `data:image/png;base64,${PNG}` });
ok(setPic.avatar > 0, "a player sets a picture");
const picRes = await api.GET(new Request(`https://castle.test/api/avatar?guest=${A.id}&v=${setPic.avatar}`));
ok(picRes.status === 200 && picRes.headers.get("content-type") === "image/png" && Buffer.from(await picRes.arrayBuffer()).equals(Buffer.from(PNG, "base64")) && picRes.headers.get("cache-control").includes("immutable"),
  "it's served as it was sent, cached for good with its version");
ok((await call(`profile?guest=${A.id}`)).avatar === setPic.avatar, "the profile gives its version");
ok((await call(`p?id=${A.id}`)).text.includes(`/api/avatar?guest=${A.id}`), "and the profile page shows it");
ok((await call("avatar", { token: A.token, image: null })).avatar === null && (await call(`avatar?guest=${A.id}`))._status === 404, "a player removes their picture");
await call("avatar", { token: A.token, image: `data:image/png;base64,${PNG}` });
ok((await call("report", { token: B.token, guest: A.id, reason: "picture" })).ok, "a picture can be reported");
ok((await call("mod/avatar", { key: "wrong", guest: A.id }))._status === 401, "only moderators remove someone's picture");
await call("mod/avatar", { key: "test-admin-key-123", guest: A.id });
ok((await call(`avatar?guest=${A.id}`))._status === 404, "and they can");
const banPic = await guest();
await call("mod/ban", { key: "test-admin-key-123", guest: banPic.id, days: 1, reason: "test" });
ok((await call("avatar", { token: banPic.token, image: `data:image/png;base64,${PNG}` }))._status === 403, "a banned player can't change their picture");

const tp = await call("team/page", { token: A.token });
ok(tp.team?.room?.startsWith(`team:${tp.team.id}:`) && tp.team.members[0].rating && tp.team.battles.length === 1 && tp.team.battles[0].rank === 1, "the team page has members' ratings and its battles");
await call("chat", { id: tp.team.room, name: "Ann", text: "gg team", token: A.token });
ok((await call(`chat?id=${encodeURIComponent(tp.team.room)}&after=0`)).lines.some((l) => l.text === "gg team"), "team chat works");
ok((await call("chat", { id: `team:${tp.team.id}:WRONG1`, name: "Eve", text: "hi" }))._status === 404, "and needs the team's code");

section("Castle TV channels");
const tvBullet = await call("tv?category=correspondence");
ok(tvBullet.none === true, "correspondence games are never on TV");
ok((await call("tv?category=atomic")).none || (await call("tv?category=atomic")).variant === "atomic", "a channel shows only its category");

done();
