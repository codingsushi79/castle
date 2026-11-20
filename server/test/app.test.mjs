// Castle's own logic that needs no server: the personalities and their strength model,
// the coaches' courses and commentary, and Sheet2PGN's scanner and decoder (on
// photographs of a filled-in sheet drawn here, with perspective, curl, shadows and noise).
// Run with: npm run test:app
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checks } from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");
globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const out = path.join(here, ".build/app.mjs");
await build({
  stdin: {
    contents: `
export { PERSONALITIES, COACHES, bookMoves } from "./src/lib/personalities";
export { COURSES, parseLine } from "./src/lib/courses";
export { paramsForLevel, pickMove, levelForElo, eloForLevel, CALIBRATION, seeded, chances } from "./src/lib/strength";
export { Commentator, swing, reasonFor, styleBonus, factsOf } from "./src/lib/coach";
export { line } from "./src/lib/voices";
export * as layout from "./src/lib/sheet/layout";
export { scanPage, homography } from "./src/lib/sheet/scan";
export { decodeGame } from "./src/lib/sheet/decode";
export { positionOf, fenOf, uciOf, START_FEN } from "./src/lib/chess";
export { parseSan } from "chessops/san";
`,
    resolveDir: root, loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "error", nodePaths: [path.join(root, "node_modules")],
  alias: { "@tauri-apps/plugin-notification": path.join(here, "notification-shim.mjs") },
});
const L = await import(pathToFileURL(out).href);
const { ok, section, done } = checks();

// Plays SAN moves from the start; returns the UCI moves, or the first illegal SAN.
function replay(sans) {
  const pos = L.positionOf(L.START_FEN).clone();
  const ucis = [];
  for (const san of sans) {
    const m = L.parseSan(pos, san);
    if (!m) return { bad: san, ucis };
    ucis.push(L.uciOf(pos, m, false));
    pos.play(m);
  }
  return { ucis, fen: L.fenOf(pos) };
}

section("Personalities");
ok(new Set(L.PERSONALITIES.map((p) => p.id)).size === L.PERSONALITIES.length, `${L.PERSONALITIES.length} personalities, each with its own id`);
const badBooks = L.PERSONALITIES.flatMap((p) => p.book.map((line) => [p.id, replay(line.split(" ")).bad]).filter(([, bad]) => bad));
ok(!badBooks.length, "every opening line in every personality's book is legal" + (badBooks.length ? `: ${badBooks.map((b) => b.join(" ")).join(", ")}` : ""));
const ladder = L.PERSONALITIES.filter((p) => !p.coach && p.rating < 3000).map((p) => p.rating);
ok(ladder.every((r, i) => i === 0 || r > ladder[i - 1]) && ladder[0] <= 400 && ladder.at(-1) >= 2400, `opponents climb from ${ladder[0]} to ${ladder.at(-1)} without gaps or repeats`);
ok(L.COACHES.length === 5 && L.COACHES.every((c) => c.coach.courses.every((id) => L.COURSES.some((k) => k.id === id))), "five coaches, each teaching courses that exist");
ok(L.COURSES.every((c) => L.COACHES.some((k) => k.coach.courses.includes(c.id))), "every course has a coach");

section("Strength model");
for (const engine of ["stockfish", "wasabi"]) {
  const t = L.CALIBRATION[engine];
  ok(t.every(([l, e], i) => i === 0 || (l > t[i - 1][0] && e >= t[i - 1][1])), `${engine}: measured ratings rise with the level (${t[0][1]} to ${t.at(-1)[1]})`);
  const back = [600, 1200, 1800].map((e) => Math.round(L.eloForLevel(L.levelForElo(e, engine), engine)));
  ok(back.every((e, i) => Math.abs(e - [600, 1200, 1800][i]) <= 1 || e === t.at(-1)[1] || e === t[0][1]), `${engine}: a rating maps to a level and back`);
}
{
  const lo = Math.min(L.CALIBRATION.stockfish[0][1], L.CALIBRATION.wasabi[0][1]);
  const hi = Math.max(L.CALIBRATION.stockfish.at(-1)[1], L.CALIBRATION.wasabi.at(-1)[1]);
  const out = L.PERSONALITIES.filter((p) => !p.coach && p.rating < 3000 && (p.rating < lo || p.rating > hi));
  ok(!out.length, `every opponent's rating can be played by Stockfish or Wasabi (${lo} to ${hi})${out.length ? `: not ${out.map((p) => p.name).join(", ")}` : ""}`);
}
{
  // Candidates: the best move, a slightly worse one, and a blunder.
  const cands = [{ move: "a", score: { cp: 30 } }, { move: "b", score: { cp: 0 } }, { move: "c", score: { cp: -400 } }];
  const count = (level) => {
    const rnd = L.seeded(7);
    const n = { a: 0, b: 0, c: 0 };
    for (let i = 0; i < 4000; i++) n[L.pickMove(cands, L.paramsForLevel(level), rnd).move]++;
    return n;
  };
  const weak = count(0.1), strong = count(0.95);
  ok(weak.c > 400 && strong.c < 10, `weak levels blunder often (${(weak.c / 40).toFixed(0)}% of the time here), strong ones almost never (${(strong.c / 40).toFixed(1)}%)`);
  ok(strong.a > strong.b, "strong levels prefer the best move");
  const sharp = L.pickMove([{ move: "x", score: { mate: 2 } }, { move: "y", score: { cp: 500 } }], L.paramsForLevel(1), L.seeded(1));
  ok(sharp.move === "x" || sharp.loss < 5, "mate scores are understood");
  const bonus = L.styleBonus({ checks: 10 }, "rnbqkbnr/ppp2ppp/8/3pp3/4P3/5Q2/PPPP1PPP/RNB1KBNR w KQkq - 0 3", undefined);
  ok(bonus("f3f7") === 10 && bonus("f3f6") === 0, "an attacker's leaning favours checks");
}

section("Courses");
for (const c of L.COURSES) {
  let bad = "";
  let explained = 0, total = 0;
  for (const ch of c.chapters) {
    const moves = L.parseLine(ch.line);
    const r = replay(moves.map((m) => m.san));
    if (r.bad) bad ||= `${ch.title}: ${r.bad}`;
    total += moves.length;
    explained += moves.filter((m) => m.say).length;
  }
  ok(!bad && c.chapters.length >= 3 && explained >= total / 3, `${c.name}: ${c.chapters.length} chapters, all legal, ${explained} of ${total} moves explained${bad ? ` (illegal: ${bad})` : ""}`);
}
ok(L.parseLine("e4 {a} e5 Nf3 {b c}").map((m) => `${m.san}:${m.say ?? ""}`).join(" ") === "e4:a e5: Nf3:b c", "course lines parse into moves and explanations");

section("Commentary");
{
  const coach = L.COACHES[0];
  const c = new L.Commentator(coach, "black", L.seeded(3));
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4?: then 4.Nxe5 is fine; here White hangs the bishop with 4.Bb5?? a6.
  const before = "r1bqkbnr/pppp1ppp/8/4p3/2BnP3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4";
  // White blunders the knight: 4.Ng5?? Qxg5.
  const after = "r1bqkbnr/pppp1ppp/8/4p1N1/2BnP3/8/PPPP1PPP/RNBQK2R b KQkq - 5 4";
  const lines = c.yourMove(before, "f3g5", after, { score: { cp: 20 }, pv: ["f3d4", "e5d4"] }, { score: { cp: 350 }, pv: ["d8g5", "d2d3"] });
  const said = lines.map((l) => l.text).join(" ");
  ok(/knight on g5/.test(said) && /Nxd4/.test(said), `a coach explains a blunder: "${said}"`);
  ok(L.swing(after, ["d8g5", "d2d3"]).gain === 3 && L.swing(after, ["d8g5"]).gain === 3, "material won along a line is counted when the exchanges settle");
  const mateLine = L.reasonFor(before, undefined, after, { score: { mate: 1 }, pv: ["d8h4"] });
  ok(/mate/.test(mateLine), "allowing mate is spotted");
  const hint = c.hint(before, { score: { cp: 20 }, pv: ["f3d4"] }, 1);
  ok(hint.square === "f3" && /knight on f3/.test(hint.text), "a first hint points at the piece, not the move");
  const hint2 = c.hint(before, { score: { cp: 20 }, pv: ["f3d4"] }, 2);
  ok(hint2.arrow?.[0] === "f3" && hint2.arrow?.[1] === "d4" && /Nxd4/.test(hint2.text), "a second hint shows the move");
  const own = c.ownMove("r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R b KQkq - 0 4", "f8c5", "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 1 5");
  ok(own.some((l) => /developing my bishop/.test(l.text)), "a coach explains developing its own pieces");
  const castle = new L.Commentator(L.PERSONALITIES.find((p) => p.id === "amara"), "white", () => 0);
  const cs = castle.ownMove("r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4", "e1g1", "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 5 4");
  ok(cs.some((l) => /[Cc]astl/.test(l.text)), "castling is recognised from the engine's e1g1");
  const quiet = L.PERSONALITIES.find((p) => p.id === "titan");
  ok(!L.line(quiet, "youBlunder", {}), "Titan doesn't chat about your mistakes");
  ok(L.PERSONALITIES.every((p) => ["hello", "win", "loss", "draw"].every((e) => L.line(p, e, {}) !== undefined)), "everyone says hello, and something at the end");
}

section("Sheet2PGN");
const { layout } = L;
const S = layout.SHEET;
ok(layout.decodeId(layout.encodeId(613, 2)).sheet === 613 && layout.decodeId(layout.encodeId(613, 2)).page === 2 && layout.decodeId(layout.encodeId(613, 2)).valid, "a sheet's identity squares encode its number and page");
const svg = layout.sheetSvg({ sheet: 5, page: 1, headers: { White: "Morphy" } });
ok(svg.startsWith("<svg") && svg.includes("Morphy") && (svg.match(/<circle/g) || []).length === S.rows * 2 * 21 + 3, "the printed sheet has every circle, and the names typed in");

/** Draws a filled-in sheet as a photo: ink in millimetres, then perspective, a bowed page, a shadow and noise. */
function photograph(marks, { width, height, corners, curl, shade, noise, seed, sheet = 77, page = 1, result }) {
  const rnd = L.seeded(seed);
  const toImage = L.homography(layout.fiducialCentres(), corners);
  const toSheet = L.homography(corners, layout.fiducialCentres());
  const bits = layout.encodeId(sheet, page);
  const filled = [];
  for (const [row, color, group, index] of marks) filled.push(layout.bubble(row, color, group, index));
  if (result !== undefined) filled.push(layout.resultBubble(result));
  const [hx, hy] = layout.fiducialCentres()[2];
  const ink = (x, y) => {
    if (x < -2 || y < -2 || x > S.width + 2 || y > S.height + 2) return -1;
    const f = S.fiducial / 2;
    for (const [cx, cy] of layout.fiducialCentres()) {
      if (Math.abs(x - cx) <= f && Math.abs(y - cy) <= f) return cx === hx && cy === hy && Math.abs(x - cx) < S.hole / 2 && Math.abs(y - cy) < S.hole / 2 ? 0 : 0.95;
    }
    for (let i = 0; i < bits.length; i++) {
      const [cx, cy] = layout.idSquare(i);
      if (bits[i] && Math.abs(x - cx) <= layout.ID_SIZE / 2 && Math.abs(y - cy) <= layout.ID_SIZE / 2) return 0.95;
    }
    const row = Math.floor((y - S.rowTop) / S.rowHeight);
    if (row >= 0 && row < S.rows) {
      for (const side of layout.MARK_SIDES) {
        const [cx, cy] = layout.rowMark(row, side);
        if (Math.abs(x - cx) <= layout.markWidth(side) / 2 && Math.abs(y - cy) <= layout.ROW_MARK.h / 2) return 0.95;
      }
      // Handwriting: a few strokes in the boxes that have a move.
      for (const color of ["white", "black"]) {
        const b = layout.handBox(row, color);
        if (x > b.x + 1 && x < b.x + b.w - 2 && y > b.y + 1 && y < b.y + b.h - 1 && marks.some(([r, c]) => r === row && c === color)) {
          if (Math.abs(Math.sin(x * 2.1 + row) * 1.6 - (y - b.y - b.h / 2)) < 0.25) return 0.85;
        }
      }
    }
    for (const [cx, cy] of filled) {
      const d = Math.hypot(x - cx, y - cy);
      if (d < S.radius * 0.95) return 0.8;
    }
    // Printed circles in light grey.
    const near = Math.abs(((y - S.rowTop) % S.rowHeight) - S.rowHeight / 2) < S.radius + 0.2;
    if (near && row >= 0 && row < S.rows && x > 25 && x < 185) {
      for (const color of ["white", "black"]) for (const g of layout.GROUPS) for (let i = 0; i < g.labels.length; i++) {
        const [cx, cy] = layout.bubble(row, color, g.group, i);
        const d = Math.hypot(x - cx, y - cy);
        if (Math.abs(d - S.radius) < 0.12) return 0.32;
        if (d < 0.5) return 0.2;
      }
    }
    // Row numbers and other print.
    if (x > 5.5 && x < 8.3 && row >= 0 && row < S.rows && Math.abs(y - layout.rowCentre(row)) < 1.1) return (Math.floor(x * 3) + Math.floor(y * 3)) % 2 ? 0.9 : 0;
    return 0;
  };
  const data = new Float32Array(width * height);
  for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
    // The page bows: undo it approximately to find which part of the sheet this pixel shows.
    let [x, y] = toSheet(px, py);
    for (let k = 0; k < 2; k++) {
      const bow = curl * Math.sin((Math.PI * x) / S.width);
      [x, y] = toSheet(px, py - bow);
    }
    const light = 235 * (1 - shade * (px / width));
    const v = ink(x, y);
    const base = v < 0 ? 70 : light * (1 - v);
    data[py * width + px] = Math.max(0, Math.min(255, base + (rnd() - 0.5) * noise));
  }
  return { width, height, data };
}

// Morphy's Opera Game, with castling queenside and a mate.
const opera = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");
function marksFor(sans) {
  const pos = L.positionOf(L.START_FEN).clone();
  const marks = [];
  sans.forEach((san, i) => {
    const m = L.parseSan(pos, san);
    const uci = L.uciOf(pos, m, false);
    const role = pos.board.get(m.from).role;
    const row = Math.floor(i / 2), color = i % 2 ? "black" : "white";
    const pi = ["king", "queen", "rook", "bishop", "knight"].indexOf(role);
    if (pi >= 0) marks.push([row, color, "piece", pi]);
    marks.push([row, color, "file", uci.charCodeAt(2) - 97]);
    marks.push([row, color, "rank", Number(uci[3]) - 1]);
    pos.play(m);
  });
  return marks;
}
const halvesOf = (scan) => scan.rows.flatMap((r) => [r.white, r.black]);
const sanList = (plies) => plies.map((p) => p.san).join(" ");
/** On a mismatch, what was read for each half-move, to see where it went wrong. */
const readout = (plies) => plies.map((p) => `${p.read}→${p.san ?? "?"}(${p.status})`).join(" ");

{
  const marks = marksFor(opera);
  const started = Date.now();
  const flat = photograph(marks, { width: 1300, height: 1760, corners: [[60, 70], [1240, 62], [1236, 1690], [64, 1700]], curl: 0, shade: 0.1, noise: 12, seed: 1, result: 0 });
  const scan = L.scanPage(flat);
  const game = L.decodeGame(halvesOf(scan));
  ok(scan.idValid && scan.sheet === 77 && scan.page === 1, "a flat scan: the sheet's identity reads back");
  ok(scan.result === "1-0", "the result circle is read");
  ok(sanList(game.plies) === opera.join(" ") && game.plies.every((p) => p.status === "ok" || p.status === "inferred") && game.plies[21].status === "inferred", `a flat scan decodes the Opera Game exactly, working out 11...Nbd7 from the moves after it (${((Date.now() - started) / 1000).toFixed(1)} s)${sanList(game.plies) === opera.join(" ") ? "" : `: ${readout(game.plies)}`}`);

  const photo = photograph(marks, { width: 1500, height: 2000, corners: [[210, 160], [1330, 230], [1400, 1880], [90, 1830]], curl: 14, shade: 0.45, noise: 30, seed: 2 });
  const p2 = L.scanPage(photo);
  const g2 = L.decodeGame(halvesOf(p2));
  ok(p2.idValid && sanList(g2.plies) === opera.join(" "), `a phone photo at an angle, bowed, shadowed and noisy still decodes exactly${sanList(g2.plies) === opera.join(" ") ? "" : `: ${readout(g2.plies)}`}`);

  // Upside down: the hollow corner tells the scanner which way up the page is.
  const flipped = photograph(marks, { width: 1300, height: 1760, corners: [[1240, 1690], [60, 1700], [64, 70], [1236, 62]], curl: 0, shade: 0.2, noise: 15, seed: 3 });
  ok(sanList(L.decodeGame(halvesOf(L.scanPage(flipped))).plies) === opera.join(" "), "a page photographed upside down decodes too");

  // A slip: the rank circle for 6.Bc4 filled one too high (c5). Bc5 isn't legal, so Castle guesses Bc4 and says so.
  const slipped = marks.map((m) => (m[0] === 5 && m[1] === "white" && m[2] === "rank" ? [5, "white", "rank", 4] : m));
  const g3 = L.decodeGame(halvesOf(L.scanPage(photograph(slipped, { width: 1300, height: 1760, corners: [[60, 70], [1240, 62], [1236, 1690], [64, 1700]], curl: 0, shade: 0.1, noise: 12, seed: 4 }))));
  const slip = g3.plies[10];
  ok(slip.san === "Bc4" && slip.status === "guessed" && sanList(g3.plies) === opera.join(" "), `a wrongly filled circle is caught and the legal move guessed (${slip.san}, ${slip.status})`);

  // Choosing a move by hand: the rest is decoded again from there.
  const chosen = L.decodeGame(halvesOf(scan), new Map([[0, "d2d4"]]));
  ok(chosen.plies[0].san === "d4" && chosen.plies[0].status === "chosen" && chosen.plies[1].fenBefore !== game.plies[1].fenBefore, "a move chosen by hand replaces the read one, and later moves follow from it");

  // Two knights that can reach the same square: the circles can't tell them apart.
  // After 1.d4 d5 2.Nf3 Nf6, "N to d2" could be either knight.
  const amb = marksFor("d4 d5 Nf3 Nf6".split(" ")).concat([[2, "white", "piece", 4], [2, "white", "file", 3], [2, "white", "rank", 1]]);
  const ga = L.decodeGame(halvesOf(L.scanPage(photograph(amb, { width: 1100, height: 1500, corners: [[50, 50], [1050, 50], [1050, 1450], [50, 1450]], curl: 0, shade: 0, noise: 8, seed: 5 }))));
  ok(ga.plies[4].status === "ambiguous" && ga.plies[4].options.length === 2, "when two knights can reach the square, both are offered");
}

done();
