import { bubble, decodeId, fiducialCentres, GROUPS, Group, ID_BITS, idSquare, MARK_SIDES, markWidth, RESULTS, resultBubble, rowMark, SHEET } from "./layout";

/**
 * Sheet2PGN's scanner: finds a Castle scoresheet in a photo or scan and reads
 * which circles are filled in. Plain image processing, no learning:
 *
 * 1. Even out the lighting: each pixel's darkness is measured against the
 *    paper around it, so shadows and uneven light don't look like ink.
 * 2. Find the four corner squares (the bottom-right one is hollow, which says
 *    which way up the page is) and work out the perspective from them.
 * 3. Follow the marks at the ends of each row, so a page that isn't quite flat
 *    still lines up.
 * 4. Measure how dark the inside of every circle is, compared with the other
 *    circles in its group (most are empty).
 */

/** A greyscale image, 0 (black) to 255 (white). */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** How one group of circles was filled: the indices that are clearly filled, and ones that might be. */
export interface Mark {
  filled: number[];
  faint: number[];
  scores: number[];
}

export interface HalfMarks {
  piece: Mark;
  file: Mark;
  rank: Mark;
  /** Nothing filled in at all. */
  blank: boolean;
}

export interface PageScan {
  page: number;
  sheet: number;
  /** Whether the sheet's identity squares read correctly. */
  idValid: boolean;
  rows: { white: HalfMarks; black: HalfMarks }[];
  result?: (typeof RESULTS)[number];
  /** Maps sheet millimetres to image pixels, for cutting out the handwriting. */
  toImage: (x: number, y: number) => [number, number];
  /** The same, following a row's marks: for things inside a row. */
  inRow: (row: number, x: number, y: number) => [number, number];
  /** Pixels per millimetre, roughly. */
  scale: number;
}

export class ScanError extends Error {}

// MARK: Lighting

/** Darkness 0 (paper) to 1 (ink) for every pixel, relative to the paper nearby. */
export function darkness(img: GrayImage): Float32Array {
  const { width: w, height: h, data } = img;
  // The paper's brightness: the brightest pixels in coarse cells, spread out and smoothed.
  const cell = Math.max(4, Math.round(Math.max(w, h) / 300));
  const cw = Math.ceil(w / cell), ch = Math.ceil(h / cell);
  const cellMax = new Float32Array(cw * ch);
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell) * cw;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x];
      const i = cy + Math.floor(x / cell);
      if (v > cellMax[i]) cellMax[i] = v;
    }
  }
  // Wide enough to see past the corner squares, the largest dark things on the page.
  const reach = Math.max(2, Math.round(Math.min(w, h) / cell / 22));
  const spread = maxFilter(cellMax, cw, ch, reach);
  const bg = boxBlur(spread, cw, ch, reach);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(ch - 1.001, Math.max(0, y / cell - 0.5));
    const y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cw - 1.001, Math.max(0, x / cell - 0.5));
      const x0 = Math.floor(fx), tx = fx - x0;
      const b = (bg[y0 * cw + x0] * (1 - tx) + bg[y0 * cw + x0 + 1] * tx) * (1 - ty) + (bg[(y0 + 1) * cw + x0] * (1 - tx) + bg[(y0 + 1) * cw + x0 + 1] * tx) * ty;
      out[y * w + x] = b > 1 ? Math.min(1, Math.max(0, 1 - data[y * w + x] / b)) : 0;
    }
  }
  return out;
}

function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) { s += src[y * w + k]; n++; }
    tmp[y * w + x] = s / n;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) { s += tmp[k * w + x]; n++; }
    out[y * w + x] = s / n;
  }
  return out;
}

// MARK: Corner squares

interface Blob {
  cx: number;
  cy: number;
  area: number;
  /** The side of a filled square with the same spread: the blob's size, hole or not. */
  size: number;
  /** Area against spread: about 1 for a filled square or disc, about 0.6 for the hollow square. */
  solidity: number;
  /** How round the spread is: 1 for a square or disc, near 0 for a line. */
  isotropy: number;
}

/** Dark connected regions of the image (darkness above the threshold), with their shapes. */
export function blobs(dark: Float32Array, w: number, h: number, threshold = 0.4, minArea = 30): Blob[] {
  const label = new Int32Array(w * h).fill(-1);
  const out: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || dark[start] < threshold) continue;
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    stack.push(start);
    label[start] = out.length;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
      const near = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of near) {
        if (q >= 0 && label[q] === -1 && dark[q] >= threshold) { label[q] = out.length; stack.push(q); }
      }
    }
    if (n < minArea) { out.push({ cx: 0, cy: 0, area: n, size: 0, solidity: 0, isotropy: 0 }); continue; }
    const cx = sx / n, cy = sy / n;
    const vxx = sxx / n - cx * cx + 1 / 12, vyy = syy / n - cy * cy + 1 / 12, vxy = sxy / n - cx * cy;
    const tr = vxx + vyy, det = vxx * vyy - vxy * vxy;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    const l1 = tr / 2 + disc, l2 = Math.max(1e-6, tr / 2 - disc);
    const spread = 12 * Math.sqrt(l1 * l2);
    out.push({ cx, cy, area: n, size: Math.sqrt(spread), solidity: n / spread, isotropy: l2 / l1 });
  }
  return out.filter((b) => b.area >= minArea);
}

/** The four corner squares in the image, as top-left, top-right, bottom-right, bottom-left. */
export function findCorners(list: Blob[], w: number, h: number): [number, number][] {
  const minSize = Math.min(w, h) * 0.012, maxSize = Math.min(w, h) * 0.12;
  const squares = list.filter((b) => b.isotropy > 0.55 && b.size >= minSize && b.size <= maxSize);
  const solid = squares.filter((b) => b.solidity > 0.82).sort((a, b) => b.size - a.size);
  const hollow = squares.filter((b) => b.solidity > 0.4 && b.solidity <= 0.82).sort((a, b) => b.size - a.size);
  const expected = SHEET.height / SHEET.width;
  let best: { corners: [number, number][]; score: number } | undefined;
  for (const hb of hollow.slice(0, 6)) {
    const peers = solid.filter((b) => Math.abs(b.size / hb.size - 1) < 0.4).slice(0, 8);
    for (let i = 0; i < peers.length; i++) for (let j = i + 1; j < peers.length; j++) for (let k = j + 1; k < peers.length; k++) {
      const three = [peers[i], peers[j], peers[k]];
      // Top-left is the one farthest from the hollow bottom-right square.
      three.sort((a, b) => Math.hypot(b.cx - hb.cx, b.cy - hb.cy) - Math.hypot(a.cx - hb.cx, a.cy - hb.cy));
      const tl = three[0];
      let [tr, bl] = [three[1], three[2]];
      // Going top-left, top-right, bottom-right turns clockwise on the image.
      if ((tr.cx - tl.cx) * (hb.cy - tl.cy) - (tr.cy - tl.cy) * (hb.cx - tl.cx) < 0) [tr, bl] = [bl, tr];
      const top = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy), bottom = Math.hypot(hb.cx - bl.cx, hb.cy - bl.cy);
      const left = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy), right = Math.hypot(hb.cx - tr.cx, hb.cy - tr.cy);
      const ratio = (left + right) / (top + bottom);
      // The squares should be about a sheet-width apart for their size.
      const span = (top + bottom) / 2 / ((tl.size + tr.size + bl.size + hb.size) / 4);
      if (Math.abs(ratio / expected - 1) > 0.35 || Math.abs(span / (SHEET.width / SHEET.fiducial) - 1) > 0.4) continue;
      const convex = [[tl, tr, hb], [tr, hb, bl], [hb, bl, tl], [bl, tl, tr]].every(([a, b, c]) => (b.cx - a.cx) * (c.cy - a.cy) - (b.cy - a.cy) * (c.cx - a.cx) > 0);
      if (!convex) continue;
      const score = Math.abs(ratio / expected - 1) + Math.abs(span / (SHEET.width / SHEET.fiducial) - 1) - (tl.size + hb.size) / Math.min(w, h);
      if (!best || score < best.score) best = { corners: [[tl.cx, tl.cy], [tr.cx, tr.cy], [hb.cx, hb.cy], [bl.cx, bl.cy]], score };
    }
  }
  if (!best) throw new ScanError("Couldn't find the four corner squares. Make sure the whole page is in the picture, flat and in focus.");
  return best.corners;
}

// MARK: Perspective

/** The projective transform taking four source points to four destination points. */
export function homography(src: [number, number][], dst: [number, number][]): (x: number, y: number) => [number, number] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting.
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    if (Math.abs(A[c][c]) < 1e-12) throw new ScanError("The page is seen too much from the side.");
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return (x, y) => {
    const d = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
  };
}

// MARK: Reading

const at = (dark: Float32Array, w: number, h: number, x: number, y: number) => {
  const xi = Math.round(x), yi = Math.round(y);
  return xi < 0 || yi < 0 || xi >= w || yi >= h ? 0 : dark[yi * w + xi];
};

/** Mean darkness in a disc. */
function discMean(dark: Float32Array, w: number, h: number, x: number, y: number, r: number): number {
  let s = 0, n = 0;
  const ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) for (let dx = -ri; dx <= ri; dx++) {
    if (dx * dx + dy * dy > r * r) continue;
    s += at(dark, w, h, x + dx, y + dy); n++;
  }
  return n ? s / n : 0;
}

/** The dark mark nearest a point, within a window: its centre, or undefined if there's nothing there. */
function findMark(dark: Float32Array, w: number, h: number, x: number, y: number, rx: number, ry: number): [number, number] | undefined {
  let s = 0, sx = 0, sy = 0;
  for (let yy = Math.round(y - ry); yy <= Math.round(y + ry); yy++) for (let xx = Math.round(x - rx); xx <= Math.round(x + rx); xx++) {
    const d = at(dark, w, h, xx, yy);
    if (d < 0.4) continue;
    s += d; sx += d * xx; sy += d * yy;
  }
  return s > 2 ? [sx / s, sy / s] : undefined;
}

/** Which circles of a group are filled, judged against the group's emptiest circles. */
export function judge(means: number[]): Mark {
  const sorted = [...means].sort((a, b) => a - b);
  const empty = sorted[Math.floor(sorted.length / 2)];
  const scores = means.map((m) => m - empty);
  const top = Math.max(...scores);
  const filled = scores.map((s, i) => (s >= 0.28 && s >= top * 0.6 ? i : -1)).filter((i) => i >= 0);
  const faint = scores.map((s, i) => (s >= 0.14 && !filled.includes(i) ? i : -1)).filter((i) => i >= 0);
  return { filled, faint, scores };
}

/** Reads a whole page. */
export function scanPage(img: GrayImage): PageScan {
  const { width: w, height: h } = img;
  const dark = darkness(img);
  const corners = findCorners(blobs(dark, w, h, 0.45, Math.max(20, Math.round((w * h) / 400000))), w, h);
  const toImage = homography(fiducialCentres(), corners);
  const [ax, ay] = toImage(0, 0), [bx, by] = toImage(SHEET.width, 0);
  const scale = Math.hypot(bx - ax, by - ay) / SHEET.width;

  // Follow each row's marks; between them, shift every circle by the interpolated correction.
  const shifts: [number, number][][] = [];
  for (let r = 0; r < SHEET.rows; r++) {
    shifts.push(MARK_SIDES.map((side) => {
      const [mx, my] = rowMark(r, side);
      const [px, py] = toImage(mx, my);
      const found = findMark(dark, w, h, px, py, scale * (markWidth(side) / 2 + 0.6), scale * 2.2);
      return found ? [found[0] - px, found[1] - py] : [NaN, NaN];
    }));
  }
  // A missing mark borrows from the nearest rows that have one.
  for (let k = 0; k < MARK_SIDES.length; k++) {
    for (let r = 0; r < SHEET.rows; r++) {
      if (!Number.isNaN(shifts[r][k][0])) continue;
      let best: [number, number] = [0, 0], dist = Infinity;
      for (let q = 0; q < SHEET.rows; q++) if (!Number.isNaN(shifts[q][k][0]) && Math.abs(q - r) < dist) { dist = Math.abs(q - r); best = shifts[q][k]; }
      shifts[r][k] = best;
    }
  }
  const markX = MARK_SIDES.map((side) => rowMark(0, side)[0]);
  const place = (r: number, x: number, y: number): [number, number] => {
    const [px, py] = toImage(x, y);
    const k = x <= markX[1] ? 0 : 1;
    const t = Math.min(1, Math.max(0, (x - markX[k]) / (markX[k + 1] - markX[k])));
    const a = shifts[r][k], b = shifts[r][k + 1];
    return [px + a[0] * (1 - t) + b[0] * t, py + a[1] * (1 - t) + b[1] * t];
  };
  const inner = SHEET.radius * 0.72 * scale;

  const readGroup = (r: number, color: "white" | "black", group: Group, n: number) =>
    judge(Array.from({ length: n }, (_, i) => { const [x, y] = bubble(r, color, group, i); const [px, py] = place(r, x, y); return discMean(dark, w, h, px, py, inner); }));

  const rows = Array.from({ length: SHEET.rows }, (_, r) => {
    const half = (color: "white" | "black"): HalfMarks => {
      const [piece, file, rank] = GROUPS.map((g) => readGroup(r, color, g.group, g.labels.length));
      return { piece, file, rank, blank: !piece.filled.length && !file.filled.length && !rank.filled.length };
    };
    return { white: half("white"), black: half("black") };
  });

  // The page's identity squares, and the result.
  // The header has no marks of its own: it follows the first row's.
  const bits = Array.from({ length: ID_BITS }, (_, i) => { const [x, y] = idSquare(i); const [px, py] = place(0, x, y); return discMean(dark, w, h, px, py, scale * 0.8) > 0.45 ? 1 : 0; });
  const id = decodeId(bits);
  const res = judge([...RESULTS.map((_, i) => { const [x, y] = resultBubble(i); const [px, py] = place(0, x, y); return discMean(dark, w, h, px, py, inner); }), 0, 0]);
  const result = res.filled.length === 1 && res.filled[0] < 3 ? RESULTS[res.filled[0]] : undefined;
  return { page: id.valid ? id.page : 1, sheet: id.sheet, idValid: id.valid, rows, result, toImage, inRow: place, scale };
}

/** Turns decoded image pixels (RGBA) into the scanner's greyscale, making it smaller if it's very large. */
export function grayFromRgba(rgba: Uint8ClampedArray, width: number, height: number, maxSide = 2400): GrayImage {
  const f = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * f)), h = Math.max(1, Math.round(height * f));
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / f));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / f));
      const i = (sy * width + sx) * 4;
      data[y * w + x] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    }
  }
  return { width: w, height: h, data };
}
