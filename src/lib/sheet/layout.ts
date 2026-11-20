/**
 * Sheet2PGN: the geometry of Castle's machine-readable scoresheet, shared by
 * the printed sheet (sheetSvg) and the scanner (scan.ts). Everything is in
 * millimetres from the top-left corner of the sheet's content box, which is
 * small enough to print on both A4 and US Letter.
 *
 * Each half-move has a box for the move written by hand (the record people
 * read) and three groups of circles the scanner reads: the piece that moved
 * (K Q R B N, none for a pawn), and the file and rank of the square it went to.
 * Only legal moves are possible, so those are almost always enough.
 */

export const SHEET = {
  width: 190,
  height: 262,
  /** 50 moves a page: enough for almost every game on one sheet. */
  rows: 50,
  rowTop: 26,
  rowHeight: 4.5,
  /** The corner squares the scanner finds first. The bottom-right one is hollow, which shows which way up the page is. */
  fiducial: 7,
  hole: 3.5,
  pitch: 2.9,
  radius: 1.15,
  handWidth: 20,
};

export const PIECES = ["K", "Q", "R", "B", "N"] as const;
export const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
export const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"] as const;
export type Group = "piece" | "file" | "rank";
export const GROUPS: { group: Group; labels: readonly string[] }[] = [
  { group: "piece", labels: PIECES },
  { group: "file", labels: FILES },
  { group: "rank", labels: RANKS },
];
export const RESULTS = ["1-0", "1/2-1/2", "0-1"] as const;

/** Centres of the four corner squares, in the order top-left, top-right, bottom-right (hollow), bottom-left. */
export function fiducialCentres(): [number, number][] {
  const f = SHEET.fiducial / 2;
  return [[f, f], [SHEET.width - f, f], [SHEET.width - f, SHEET.height - f], [f, SHEET.height - f]];
}

const NUMBER_WIDTH = 9.5;
const GROUP_GAP = 1.0;
const groupWidth = (n: number) => n * SHEET.pitch;
const BLOCK = SHEET.handWidth + 0.8 + groupWidth(5) + GROUP_GAP + groupWidth(8) + GROUP_GAP + groupWidth(8);

/** Where a half-move's block starts: White's, then Black's. */
const MIDDLE_GAP = 3;
const blockX = (color: "white" | "black") => NUMBER_WIDTH + (color === "white" ? 0 : BLOCK + MIDDLE_GAP);

export const rowCentre = (row: number) => SHEET.rowTop + (row + 0.5) * SHEET.rowHeight;

/** The handwriting box for a half-move. */
export function handBox(row: number, color: "white" | "black") {
  return { x: blockX(color), y: SHEET.rowTop + row * SHEET.rowHeight + 0.5, w: SHEET.handWidth, h: SHEET.rowHeight - 1 };
}

/** The centre of one circle. */
export function bubble(row: number, color: "white" | "black", group: Group, index: number): [number, number] {
  let x = blockX(color) + SHEET.handWidth + 0.8;
  if (group !== "piece") x += groupWidth(5) + GROUP_GAP;
  if (group === "rank") x += groupWidth(8) + GROUP_GAP;
  return [x + (index + 0.5) * SHEET.pitch, rowCentre(row)];
}

/**
 * The small marks at both ends and in the middle of every row, which let the
 * scanner follow a page that isn't quite flat.
 */
export type MarkSide = "left" | "middle" | "right";
export const MARK_SIDES: MarkSide[] = ["left", "middle", "right"];
export const ROW_MARK = { w: 2.4, h: 1.4, middleW: 1.4 };
export const markWidth = (side: MarkSide) => (side === "middle" ? ROW_MARK.middleW : ROW_MARK.w);
export const rowMark = (row: number, side: MarkSide): [number, number] =>
  [side === "left" ? ROW_MARK.w / 2 : side === "right" ? SHEET.width - ROW_MARK.w / 2 : NUMBER_WIDTH + BLOCK + MIDDLE_GAP / 2, rowCentre(row)];

/** The result circles. */
export const resultBubble = (i: number): [number, number] => [151 + i * 11, 17.9];

/** Header fields written by hand, shown beside the scan so they can be typed in. */
export const FIELDS: { tag: string; label: string; x: number; y: number; w: number; h: number }[] = [
  { tag: "White", label: "White", x: 9.5, y: 9, w: 84, h: 5.6 },
  { tag: "Black", label: "Black", x: 99, y: 9, w: 84, h: 5.6 },
  { tag: "Event", label: "Event", x: 9.5, y: 15.4, w: 66, h: 5 },
  { tag: "Date", label: "Date", x: 79, y: 15.4, w: 34, h: 5 },
  { tag: "Round", label: "Round", x: 116, y: 15.4, w: 17, h: 5 },
];

/**
 * The sheet's identity, printed as 13 small squares: 2 bits of page number
 * (pages 1 to 4), 10 bits of sheet number, and a parity bit. A filled square
 * is a 1. The sheet number lets Castle fill in the names typed before printing.
 */
export const ID_BITS = 13;
export const idSquare = (i: number): [number, number] => [122 + i * 4.2, 3.5];
export const ID_SIZE = 2.6;

export function encodeId(sheet: number, page: number): number[] {
  const bits: number[] = [];
  for (let i = 0; i < 2; i++) bits.push(((page - 1) >> i) & 1);
  for (let i = 0; i < 10; i++) bits.push((sheet >> i) & 1);
  bits.push(bits.reduce((a, b) => a ^ b, 0));
  return bits;
}

export function decodeId(bits: number[]): { sheet: number; page: number; valid: boolean } {
  const page = 1 + (bits[0] | (bits[1] << 1));
  let sheet = 0;
  for (let i = 0; i < 10; i++) sheet |= bits[2 + i] << i;
  const valid = bits.slice(0, 12).reduce((a, b) => a ^ b, 0) === bits[12];
  return { sheet, page, valid };
}

/** The first move number on a page. */
export const firstMoveOf = (page: number) => (page - 1) * SHEET.rows + 1;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/**
 * The printable sheet as SVG, 190 × 262 mm. `headers` are printed into the
 * fields (typed before printing); empty fields are left for handwriting.
 */
export function sheetSvg(opts: { sheet: number; page: number; headers?: Record<string, string> }): string {
  const { sheet, page } = opts;
  const S = SHEET;
  const out: string[] = [];
  const light = "#a8a8a8", ink = "#000";
  const text = (x: number, y: number, size: number, s: string, extra = "") => out.push(`<text x="${x}" y="${y}" font-size="${size}" font-family="Helvetica, Arial, sans-serif" ${extra}>${esc(s)}</text>`);

  // Corner squares.
  const [tl, tr, br, bl] = fiducialCentres();
  for (const [x, y] of [tl, tr, bl]) out.push(`<rect x="${x - S.fiducial / 2}" y="${y - S.fiducial / 2}" width="${S.fiducial}" height="${S.fiducial}" fill="${ink}"/>`);
  out.push(`<path d="M${br[0] - S.fiducial / 2} ${br[1] - S.fiducial / 2}h${S.fiducial}v${S.fiducial}h${-S.fiducial}z M${br[0] - S.hole / 2} ${br[1] - S.hole / 2}v${S.hole}h${S.hole}v${-S.hole}z" fill="${ink}" fill-rule="evenodd"/>`);

  // Title and identity.
  text(9.5, 4.4, 3.6, "Castle scoresheet", `font-weight="bold"`);
  text(9.5, 7.4, 2.1, `Sheet2PGN · page ${page} · moves ${firstMoveOf(page)}–${firstMoveOf(page) + S.rows - 1} · sheet ${sheet}`, `fill="#555"`);
  encodeId(sheet, page).forEach((bit, i) => {
    const [x, y] = idSquare(i);
    out.push(`<rect x="${x - ID_SIZE / 2}" y="${y - ID_SIZE / 2}" width="${ID_SIZE}" height="${ID_SIZE}" fill="${bit ? ink : "none"}" stroke="${bit ? "none" : light}" stroke-width="0.2"/>`);
  });

  // Header fields.
  for (const f of FIELDS) {
    out.push(`<rect x="${f.x}" y="${f.y}" width="${f.w}" height="${f.h}" fill="none" stroke="#777" stroke-width="0.25" rx="0.6"/>`);
    text(f.x + 0.8, f.y + 1.8, 1.6, f.label, `fill="#777"`);
    const v = opts.headers?.[f.tag];
    if (v) text(f.x + 2, f.y + f.h - 1.0, f.h > 5.3 ? 3.2 : 2.8, v);
  }
  text(136, 18.6, 1.9, "Result", `fill="#777"`);
  RESULTS.forEach((r, i) => {
    const [x, y] = resultBubble(i);
    out.push(`<circle cx="${x}" cy="${y}" r="${S.radius + 0.2}" fill="none" stroke="${light}" stroke-width="0.22"/>`);
    text(x + S.radius + 0.9, y + 0.7, 1.9, r === "1/2-1/2" ? "½-½" : r, `fill="#777"`);
  });

  // Column headings.
  for (const color of ["white", "black"] as const) {
    const hb = handBox(0, color);
    text(hb.x, S.rowTop - 1.0, 2.4, color === "white" ? "White" : "Black", `font-weight="bold"`);
    for (const { group, labels } of GROUPS) {
      const [x0] = bubble(0, color, group, 0);
      const [x1] = bubble(0, color, group, labels.length - 1);
      text((x0 + x1) / 2, S.rowTop - 3.1, 1.5, group === "piece" ? "piece" : group === "file" ? "to file" : "to rank", `fill="#777" text-anchor="middle"`);
      labels.forEach((l, i) => text(bubble(0, color, group, i)[0], S.rowTop - 0.8, 1.6, l, `fill="#555" text-anchor="middle"`));
    }
  }

  // Rows.
  for (let r = 0; r < S.rows; r++) {
    const y = S.rowTop + r * S.rowHeight;
    if (r % 5 === 0) out.push(`<line x1="${ROW_MARK.w + 1}" x2="${S.width - ROW_MARK.w - 1}" y1="${y}" y2="${y}" stroke="#ccc" stroke-width="0.2"/>`);
    for (const side of MARK_SIDES) {
      const [x, cy] = rowMark(r, side);
      const mw = markWidth(side);
      out.push(`<rect x="${x - mw / 2}" y="${cy - ROW_MARK.h / 2}" width="${mw}" height="${ROW_MARK.h}" fill="${ink}"/>`);
    }
    text(NUMBER_WIDTH - 1.2, rowCentre(r) + 0.85, 2.4, String(firstMoveOf(page) + r), `text-anchor="end" font-weight="bold"`);
    for (const color of ["white", "black"] as const) {
      const hb = handBox(r, color);
      out.push(`<rect x="${hb.x}" y="${hb.y}" width="${hb.w}" height="${hb.h}" fill="none" stroke="#999" stroke-width="0.2" rx="0.5"/>`);
      for (const { group, labels } of GROUPS) {
        labels.forEach((l, i) => {
          const [cx, cy] = bubble(r, color, group, i);
          out.push(`<circle cx="${cx}" cy="${cy}" r="${S.radius}" fill="none" stroke="${light}" stroke-width="0.2"/>`);
          out.push(`<text x="${cx}" y="${cy + 0.52}" font-size="1.45" font-family="Helvetica, Arial, sans-serif" fill="#bbb" text-anchor="middle">${l}</text>`);
        });
      }
    }
    if (r % 5 === 4) out.push(`<line x1="${ROW_MARK.w + 1}" x2="${S.width - ROW_MARK.w - 1}" y1="${y + S.rowHeight}" y2="${y + S.rowHeight}" stroke="#ccc" stroke-width="0.2"/>`);
  }

  // How to fill it in.
  const foot = S.rowTop + S.rows * S.rowHeight + 2.4;
  text(9.5, foot, 1.9, "Write each move in its box, then fill three circles with a dark pen: the piece that moved (none for a pawn), and the file and rank of its new square.");
  text(9.5, foot + 2.6, 1.9, "Castling: K and the king's new square (g1, c1, g8 or c8). Promotion: just the square. Leave the rest blank when the game ends. Scan it in Castle (Sheet2PGN).", `fill="#555"`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S.width}mm" height="${S.height}mm" viewBox="0 0 ${S.width} ${S.height}">${out.join("")}</svg>`;
}
