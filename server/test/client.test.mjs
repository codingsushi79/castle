// Drives Castle's real client code (src/lib) against the real server, in Node.
// Needs the app's dependencies installed at the repository root. Run with: npm run test:client
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket as WS } from "ws";
import { checks, loadServer, until, wait } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");

// Browser bits the client expects.
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.document = { hasFocus: () => true };

const { api, call, db, livePath } = await loadServer();
const { ok, section, done } = checks();

// Requests to the production server go to the local one instead.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith("https://castle-online.vercel.app/api/")) {
    const req = new Request(u.replace("https://castle-online.vercel.app", "https://castle.test"), init);
    return (req.method === "POST" ? api.POST : api.GET)(req);
  }
  return realFetch(url, init);
};
// So does the live socket.
const live = (await import(livePath)).default;
await new Promise((r) => live.listen(0, r));
const port = live.address().port;
globalThis.WebSocket = class extends WS {
  constructor(url) { super(String(url).replace("wss://castle-online.vercel.app/api/live", `ws://127.0.0.1:${port}`)); }
};

const { buildClient } = await import("./client-build.mjs");
await buildClient();
const { useOnline, ratingWindow, useRace, usePuzzles, useRepertoire, checkPrep, encodeGif, GameTree, positionOf, moveFromUci } = await import(pathToFileURL(path.join(here, ".build/client.mjs")).href);
const o = () => useOnline.getState();
const puzzles = new Map(JSON.parse(fs.readFileSync(path.join(here, "../lib/puzzles-data.ts"), "utf8").match(/= (".*");/)[1])
  .split("\n").map((l) => l.split("\t")).map(([id, fen, moves]) => [id, { fen, moves: moves.split(" ") }]));

section("Signing in and live updates");
await o().start();
ok(o().ready && o().profile?.rating === 1500, "the app signs in as a guest");
await until(() => o().liveSocket, 5000);
ok(o().liveSocket, "the live socket connects");
const B = await call("guest", {});
const bobId = B.profile.id;

section("Quick pairing by category rating");
ok(ratingWindow(0) === 150 && ratingWindow(12000) === 250 && ratingWindow(61000) === Infinity, "the rating window widens over time");
const far = await call("games", { token: B.token, name: "Bob", minutes: 3, increment: 2, rated: true, color: "random", public: true, variant: "chess960" });
await db.query("update games set white_rating = 2200, black_rating = 2200 where id = $1", [far.id]);
await o().quickPair({ minutes: 3, increment: 2, rated: true, variant: "chess960" });
await until(() => o().game);
ok(o().queue && o().seat.id !== far.id, "a seek far from your rating is skipped");
await call("action", { id: far.id, key: far.key, action: "cancel" });
await o().leaveQueue();
const near = await call("games", { token: B.token, name: "Bob", minutes: 3, increment: 2, rated: true, color: "white", public: true, variant: "chess960" });
await o().quickPair({ minutes: 3, increment: 2, rated: true, variant: "chess960" });
await until(() => o().game?.status === "playing");
ok(o().seat?.id === near.id && o().toTree().chess960, "a nearby 960 seek is joined");

section("Premoves and pushes");
o().setPremove(["e7", "e5"]);
const t0 = Date.now();
await call("move", { id: near.id, key: near.key, uci: "e2e4", ply: 0 });
await until(() => o().game?.ply >= 2, 6000);
const took = Date.now() - t0;
ok(o().game.moves[1] === "e7e5", "the premove plays when the opponent's move arrives");
ok(took < 2500, `the move arrived over the socket, not the slow poll (${took} ms)`);

section("Abandonment and category ratings");
await db.query("update games set white_seen = $1 where id = $2", [Date.now() - 45000, near.id]);
await until(() => (o().game?.away?.white ?? 0) > 30000, 6000);
await o().act("claim");
ok(o().game.reason === "abandonment" && o().game.result === "0-1", "the app claims an abandoned game");
await until(() => o().profile.ratings?.chess960, 5000);
ok(o().profile.ratings?.chess960?.r > 1500 && o().profile.ratings.chess960.g === 1, "the win counts in the Chess960 rating");
o().leave();

section("Rooms and blocks");
const room = await call("games", { token: B.token, name: "Bob", minutes: 5, increment: 0, color: "white", public: true });
o().watch(room.id);
await until(() => o().game?.id === room.id);
await call("chat", { id: room.id, name: "Bob", text: "hi from bob", token: B.token });
await o().sayToRoom("🔥", "react");
await until(() => o().room.some((l) => l.text === "hi from bob") && o().room.some((l) => l.kind === "react"), 6000);
ok(o().room.some((l) => l.text === "hi from bob" && l.guest === bobId), "room chat and reactions arrive, with who said them");
await o().block(bobId);
ok(!o().room.some((l) => l.guest === bobId), "blocking hides their chat");
await o().refreshLobby();
ok(!o().open.some((s) => s.guest === bobId), "and their seeks");
await o().unblock(bobId);
o().leave();
await call("action", { id: room.id, key: room.key, action: "cancel" });

section("Friends, challenges and correspondence");
await call("inbox", { token: B.token, name: "Bob" });
o().addFriend({ id: bobId, name: "Bob" });
await until(() => o().presence[bobId] === true, 7000);
ok(o().presence[bobId], "a friend shows as online");
await call("challenge", { token: B.token, name: "Bob", to: o().profile.id, minutes: 5, increment: 3, days: 2, variant: "chess" });
await until(() => o().incoming.length === 1, 8000);
ok(o().incoming[0]?.days === 2, "a correspondence challenge arrives at once (socket nudge)");
await o().answer(o().incoming[0], true);
await until(() => o().game?.status === "playing");
const corrId = o().game.id;
ok(o().game.days === 2, "accepting opens the correspondence game");
o().leave();
await until(() => o().correspondence.some((c) => c.id === corrId), 8000);
const corr = o().correspondence.find((c) => c.id === corrId);
ok(corr && corr.key, "it is listed under Correspondence with its key");
const bSeat = (await call("inbox", { token: B.token, name: "Bob" })).correspondence.find((c) => c.id === corrId);
if (bSeat.color === "white") await call("move", { id: corrId, key: bSeat.key, uci: "d2d4", ply: 0 });
await until(() => o().correspondence.find((c) => c.id === corrId)?.myTurn, 8000);
ok(o().correspondence.find((c) => c.id === corrId)?.myTurn, "it shows when it's your move");
o().openCorrespondence(o().correspondence.find((c) => c.id === corrId));
await until(() => o().game?.id === corrId);
o().move(o().game.ply === 0 ? "e2e4" : "d7d5");
await wait(400);
ok((await call(`game?id=${corrId}`)).ply >= 1, "a move from the correspondence list is played");
o().leave();
await o().challenge({ id: bobId, name: "Bob" }, { minutes: 3, increment: 0, rated: false, variant: "chess", color: "random" });
const bIn = await call("inbox", { token: B.token, name: "Bob" });
await call("answer", { token: B.token, id: bIn.incoming[0].id, accept: false });
await until(() => !o().challenging, 8000);
ok(/declined/.test(o().error ?? "") && !o().game, "a declined challenge is reported");
useOnline.setState({ error: undefined });

section("Arenas with berserk, and Swiss");
const ar = await call("arena/create", { token: B.token, name: "Bob", title: "Client arena", minutes: 1, increment: 0, startsIn: 0, duration: 20 });
await o().refreshArenas();
await call("arena/join", { token: B.token, name: "Bob", id: ar.id });
await o().joinArena(ar.id);
let bArena;
await until(async () => { const r = await call("arena/pair", { token: B.token, id: ar.id }); if (r.seat) bArena = r.seat; return o().game?.arena === ar.id && o().game.status === "playing"; }, 10000);
ok(o().game?.arena === ar.id, "the arena pairs the app with Bob");
await o().act("berserk");
ok(o().game.berserk?.[o().seat.color], "the app can berserk");
await call("action", { id: bArena.id, key: bArena.key, action: "resign" }).catch(() => {});
await call("action", { id: bArena.id, key: bArena.key, action: "abort" }).catch(() => {});
o().leaveArena();
o().leave();
const sw = await call("swiss/create", { token: B.token, name: "Bob", title: "Client Swiss", minutes: 3, increment: 0, rounds: 3, startsIn: 5 });
await call("swiss/join", { token: B.token, name: "Bob", id: sw.id });
await o().joinSwiss(sw.id);
await db.query("update swiss set starts_at = $1 where id = $2", [Date.now() - 1000, sw.id]);
await until(() => o().game?.swiss === sw.id, 10000);
ok(o().game?.swiss === sw.id && o().game.round === 1, "the Swiss seats the app in round 1");
ok(o().swiss?.standings.length === 2, "the standings are shown");
await o().withdrawSwiss();
o().leave();

section("Ranked rush and battles");
await useRace.getState().startRush(3);
const r = () => useRace.getState();
await until(() => r().ready, 5000);
ok(r().ready && r().run?.status === "running", "a ranked rush starts with the setup move played");
const runId = r().run.id;
const ids = (await db.query("select puzzles from runs where id = $1", [runId])).rows[0].puzzles;
const pz = puzzles.get(ids[0]);
for (let step = 1; step < pz.moves.length; step += 2) {
  await until(() => r().ready, 4000);
  r().attempt(moveFromUci(positionOf(r().fen), pz.moves[step]));
  await wait(150);
}
await until(() => r().run?.score === 1 && r().ready, 5000);
ok(r().run.score === 1 && r().run.index === 1, "solving the puzzle scores on the server");
const pos = positionOf(r().fen);
const legal = [...pos.allDests()].flatMap(([from, tos]) => [...tos].map((to) => ({ from, to })));
const sol = moveFromUci(pos, puzzles.get(ids[1]).moves[1]);
r().attempt(legal.find((m) => { const c = pos.clone(); c.play(m); return !c.isCheckmate() && !(m.from === sol.from && m.to === sol.to); }));
await until(() => r().run?.strikes === 1, 4000);
ok(r().run.strikes === 1 && r().answer, "a wrong move is a strike, and the answer is shown");
r().leave();
await r().createBattle(3, true);
ok(r().race?.status === "waiting" && r().race.code, "a battle is created");
const bj = await call("race/join", { token: B.token, name: "Bob", code: r().race.code });
await db.query("update races set started_at = $1 where id = $2", [Date.now() + 300, r().race.id]);
await db.query("update runs set started_at = $1, ends_at = $2 where race_id = $3", [Date.now() + 300, Date.now() + 180_300, r().race.id]);
await until(() => r().ready, 6000);
ok(r().ready && r().race.status === "running", "the battle starts on time");
await call("race/move", { id: bj.run, key: bj.key, index: 0, uci: "a1a1" });
await until(() => r().race?.b.strikes === 1, 4000);
ok(r().race.b.strikes === 1, "the opponent's checked score shows up");
r().leave();

section("Storm, teams and stats");
await useRace.getState().startStorm();
await until(() => r().ready, 5000);
ok(r().kind === "storm" && r().run?.status === "running", "a storm starts from the app");
const stormRun = r().run;
const stormPos = positionOf(r().fen);
const stormIds = (await db.query("select puzzles from runs where id = $1", [stormRun.id])).rows[0].puzzles;
const stormSol = moveFromUci(stormPos, puzzles.get(stormIds[0]).moves[1]);
const miss = [...stormPos.allDests()].flatMap(([from, tos]) => [...tos].map((to) => ({ from, to }))).find((m) => { const c = stormPos.clone(); c.play(m); return !c.isCheckmate() && !(m.from === stormSol.from && m.to === stormSol.to); });
r().attempt(miss);
await until(() => r().run?.strikes === 1, 4000);
ok(r().run.endsAt === stormRun.endsAt - 10000 && r().run.status === "running", "a miss in a storm costs ten seconds and play goes on");
r().leave();
await o().createTeam("Play Testers");
ok(o().team?.name === "Play Testers" && o().team.code.length === 6, "the app makes a team");
await o().refreshTeam();
ok(o().team?.members[0]?.guest === o().profile.id, "and lists its members");
const myStats = await o().loadStats();
ok(myStats.length >= 1 && myStats.every((x) => x.color && typeof x.score === "number"), "the stats load");
await o().leaveTeam();
ok(o().team === null, "the app leaves a team");

section("Repertoire check and GIFs");
const rep = new GameTree();
for (const m of ["e2e4", "e7e5", "g1f3"]) rep.play(m);
useRepertoire.setState({ trees: { white: rep, black: new GameTree() } });
const game = new GameTree();
for (const m of ["e2e4", "e7e5", "f1c4", "g8f6"]) game.play(m);
const prep = checkPrep(game, "white");
ok(prep?.kind === "you" && prep.moveLabel === "2." && prep.played === "Bc4" && prep.expected[0] === "Nf3", "leaving your repertoire is spotted (2.Bc4 instead of Nf3)");
const game2 = new GameTree();
for (const m of ["e2e4", "c7c5"]) game2.play(m);
ok(checkPrep(game2, "white")?.kind === "them", "so is an opponent's move your repertoire doesn't cover");
const W = 24, H = 16, pixels = new Uint8Array(W * H).map((_, i) => (i * 7 + (i >> 4)) % 256);
const gif = encodeGif([{ pixels, delay: 10 }, { pixels: pixels.map((p) => 255 - p), delay: 10 }], W, H);
ok(String.fromCharCode(...gif.slice(0, 6)) === "GIF89a" && gif[gif.length - 1] === 0x3b, "the GIF has a header and trailer");
ok(decodeFirstFrame(gif, W * H).every((v, i) => v === pixels[i]), "the GIF decodes back to the same pixels");

live.close();
done();

/** A minimal GIF decoder for the first frame: enough to check the encoder. */
function decodeFirstFrame(bytes, count) {
  let i = 13 + 3 * 256;
  while (bytes[i] === 0x21) { i += 2; while (bytes[i]) i += bytes[i] + 1; i++; }
  i += 10; // image descriptor
  const min = bytes[i++];
  const data = [];
  while (bytes[i]) { data.push(...bytes.slice(i + 1, i + 1 + bytes[i])); i += bytes[i] + 1; }
  let pos = 0;
  const read = (n) => { let v = 0; for (let b = 0; b < n; b++, pos++) v |= ((data[pos >> 3] >> (pos & 7)) & 1) << b; return v; };
  const clear = 1 << min, eoi = clear + 1;
  let size = min + 1, dict = [], prev, out = [];
  const reset = () => { dict = Array.from({ length: clear + 2 }, (_, k) => [k]); size = min + 1; prev = undefined; };
  reset();
  while (out.length < count) {
    const code = read(size);
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    const entry = code < dict.length ? dict[code] : [...dict[prev], dict[prev][0]];
    out.push(...entry);
    if (prev !== undefined) dict.push([...dict[prev], entry[0]]);
    prev = code;
    if (dict.length === 1 << size && size < 12) size++;
  }
  return out.slice(0, count);
}
