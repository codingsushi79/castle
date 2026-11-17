// The two-player play test: two copies of Castle's online code, each in its own
// process, play each other through the real server over HTTP and a WebSocket.
// It covers what a person would try first: queueing at the same moment, a rated
// game with a premove, a casual game with a takeback and a rematch, an arena,
// correspondence, and a puzzle battle. Run with: npm run test:play
import { fork } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checks, loadServer } from "./harness.mjs";
import { buildClient } from "./client-build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const { api, db, livePath } = await loadServer();
const { ok, section, done } = checks();
await buildClient();

// The server, over real HTTP.
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://castle.test${req.url}`, { method: req.method, headers: req.headers, body: req.method === "POST" ? Buffer.concat(chunks) : undefined });
  const response = await (req.method === "POST" ? api.POST : req.method === "OPTIONS" ? api.OPTIONS : api.GET)(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((r) => server.listen(0, r));
const live = (await import(livePath)).default;
await new Promise((r) => live.listen(0, r));

function player(name) {
  const child = fork(path.join(here, "player.mjs"), [String(server.address().port), String(live.address().port)], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  let next = 0;
  const waiting = new Map();
  const ready = new Promise((r) => child.once("message", r));
  child.on("message", (m) => { if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); } });
  const run = async (code) => {
    await ready;
    const id = next++;
    const m = await new Promise((r) => { waiting.set(id, r); child.send({ id, code }); });
    if (m.error) throw new Error(`${name}: ${m.error}`);
    return m.value;
  };
  return { name, run, kill: () => child.kill() };
}
const ann = player("Ann"), bob = player("Bob");
const both = (code) => Promise.all([ann.run(code), bob.run(code)]);

try {
  section("Two players sign in");
  await ann.run(`o().setName("Ann"); await o().start(); await until(() => o().liveSocket);`);
  await bob.run(`o().setName("Bob"); await o().start(); await until(() => o().liveSocket);`);
  const [aReady, bReady] = await both(`return { ready: o().ready, live: o().liveSocket, id: o().profile.id };`);
  ok(aReady.ready && bReady.ready && aReady.live && bReady.live, "both apps sign in and connect live");

  section("Queueing at the same moment");
  await both(`o().quickPair({ minutes: 3, increment: 2, rated: true, variant: "chess" });`);
  await both(`await until(() => o().game?.status === "playing", 15000);`);
  const [ga, gb] = await both(`return { id: o().game?.id, color: o().seat?.color, status: o().game?.status };`);
  ok(ga.id && ga.id === gb.id && ga.color !== gb.color, "two players who queue together end up in the same game");
  const W = ga.color === "white" ? ann : bob, B = W === ann ? bob : ann;

  section("A rated game, with a premove");
  await W.run(`o().move("e2e4");`);
  await B.run(`await until(() => o().game.ply === 1); o().move("e7e5");`);
  await W.run(`await until(() => o().game.ply === 2); o().setPremove(["d1", "h5"]); o().move("f1c4");`);
  await B.run(`await until(() => o().game.ply === 3); o().move("b8c6");`);
  await W.run(`await until(() => o().game.ply >= 5, 5000);`);
  ok((await W.run(`return o().game.moves[4];`)) === "d1h5", "the premove plays as soon as Black moves");
  await B.run(`await until(() => o().game.ply === 5); o().move("g8f6");`);
  await W.run(`await until(() => o().game.ply === 6); o().move("h5f7");`);
  const [ea, eb] = await both(`await until(() => o().game.status === "finished"); return { result: o().game.result, reason: o().game.reason };`);
  ok(ea.result === "1-0" && eb.result === "1-0" && ea.reason === "checkmate", "both see Scholar's mate end the game");
  const ratings = await both(`await until(() => o().profile.ratings?.blitz); return o().profile.ratings.blitz.r;`);
  const winner = W === ann ? ratings[0] : ratings[1], loser = W === ann ? ratings[1] : ratings[0];
  ok(winner > 1500 && loser < 1500, `blitz ratings move both ways (${winner} / ${loser})`);

  section("Rematch, a casual game and a takeback");
  await B.run(`await o().act("rematch");`);
  await W.run(`await until(() => o().game?.rematch); await o().act("rematch");`);
  await both(`await until(() => o().game?.status === "playing" && o().game.ply === 0);`);
  const [ra, rb] = await both(`return { id: o().game.id, color: o().seat.color };`);
  ok(ra.id === rb.id && ra.id !== ga.id, "a rematch starts a new game for both");
  await both(`o().leave();`);
  const casual = await ann.run(`await o().create({ minutes: 10, increment: 0, color: "white", rated: false, public: false, variant: "chess" }); await until(() => o().game); return o().game.code;`);
  await bob.run(`await o().join(${JSON.stringify(casual)}); await until(() => o().game?.status === "playing");`);
  await ann.run(`await until(() => o().game.status === "playing"); o().move("e2e4");`);
  await bob.run(`await until(() => o().game.ply === 1); o().move("f7f6");`);
  await bob.run(`await until(() => o().game.ply === 2); await o().takeback();`);
  ok(await ann.run(`await until(() => o().game.takeback === "black"); return o().game.takeback;`) === "black", "Ann sees Bob's takeback request");
  await ann.run(`await o().takeback();`);
  const after = await both(`await until(() => o().game.ply === 1); return o().game.moves.join(" ");`);
  ok(after[0] === "e2e4" && after[1] === "e2e4", "after the takeback both boards are back to 1.e4");
  await bob.run(`o().move("e7e5");`);
  ok((await ann.run(`await until(() => o().game.ply === 2); return o().game.moves[1];`)) === "e7e5", "and play goes on");
  await ann.run(`await o().saveNotes("Bob likes f6");`);
  ok((await ann.run(`return await o().loadNotes();`)) === "Bob likes f6" && (await bob.run(`return await o().loadNotes();`)) === "", "notes stay private");
  await ann.run(`await o().act("resign");`);
  await both(`await until(() => o().game.status === "finished"); o().leave();`);

  section("An arena");
  const arena = await ann.run(`await o().createArena({ title: "Play test arena", minutes: 1, increment: 0, variant: "chess", startsIn: 0, duration: 20 }); return o().arena.info.id;`);
  await bob.run(`await o().refreshArenas(); await o().joinArena(${JSON.stringify(arena)});`);
  await both(`await until(() => o().game?.arena && o().game.status === "playing", 15000);`);
  const [aa, ab] = await both(`return { id: o().game.id, color: o().seat.color };`);
  ok(aa.id === ab.id, "the arena pairs the two players");
  const AW = aa.color === "white" ? ann : bob, AB = AW === ann ? bob : ann;
  await AW.run(`await o().act("berserk");`);
  ok(await AB.run(`await until(() => Object.values(o().game.berserk ?? {}).some(Boolean)); return true;`), "the opponent sees the berserk");
  await AW.run(`o().move("f2f3");`);
  await AB.run(`await until(() => o().game.ply === 1); o().move("e7e5");`);
  await AW.run(`await until(() => o().game.ply === 2); o().move("g2g4");`);
  await AB.run(`await until(() => o().game.ply === 3); o().move("d8h4");`);
  await both(`await until(() => o().game.status === "finished");`);
  const score = await AB.run(`await until(() => (o().arena.players.find((p) => p.guest === o().profile.id)?.score ?? 0) > 0, 10000); return o().arena.players.find((p) => p.guest === o().profile.id).score;`);
  ok(score === 2, "the winner gets 2 arena points");
  await both(`o().leaveArena(); o().leave();`);

  section("Correspondence");
  const bobId = bReady.id;
  await ann.run(`await o().challenge({ id: ${JSON.stringify(bobId)}, name: "Bob" }, { minutes: 5, increment: 0, days: 3, rated: true, variant: "chess", color: "white" });`);
  await bob.run(`await until(() => o().incoming.length > 0); await o().answer(o().incoming[0], true); await until(() => o().game?.status === "playing"); o().leave();`);
  await ann.run(`await until(() => o().game?.status === "playing"); o().move("d2d4"); await wait(300); o().leave();`);
  ok(await bob.run(`await until(() => o().correspondence.some((c) => c.myTurn)); return o().correspondence.find((c) => c.myTurn).days;`) === 3, "Bob's list shows it's his move, without the game open");
  await bob.run(`o().openCorrespondence(o().correspondence.find((c) => c.myTurn)); await until(() => o().game?.days); o().move("d7d5"); await wait(300); o().leave();`);
  ok(await ann.run(`await until(() => o().correspondence.some((c) => c.myTurn)); return true;`), "and then Ann's shows it's hers");

  section("A puzzle battle");
  const code = await ann.run(`o().leave(); await r().createBattle(2, false); return r().race.code;`);
  await bob.run(`await r().joinBattle(${JSON.stringify(code)});`);
  await db.query("update races set started_at = $1 where code = $2", [Date.now() + 200, code]);
  await db.query("update runs set started_at = $1, ends_at = $2 where race_id = (select id from races where code = $3)", [Date.now() + 200, Date.now() + 120_200, code]);
  await both(`await until(() => r().ready, 8000);`);
  const ids = (await db.query("select puzzles from races where code = $1", [code])).rows[0].puzzles;
  const tsv = JSON.parse(fs.readFileSync(path.join(here, "../lib/puzzles-data.ts"), "utf8").match(/= (".*");/)[1]);
  const first = tsv.split("\n").map((l) => l.split("\t")).find((c) => c[0] === ids[0])[2].split(" ");
  for (let step = 1; step < first.length; step += 2) {
    await ann.run(`await until(() => r().ready); r().attempt(lib.moveFromUci(lib.positionOf(r().fen), ${JSON.stringify(first[step])})); await wait(200);`);
  }
  ok(await bob.run(`await until(() => (r().race?.[r().side === "a" ? "b" : "a"].score ?? 0) >= 1, 8000); return true;`), "Bob sees Ann's checked score go up");
  await both(`r().leave();`);
} catch (e) {
  ok(false, String(e.message ?? e));
} finally {
  ann.kill(); bob.kill(); server.close(); live.close();
}
done();
