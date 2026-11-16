import { GameTree } from "./chess";
import { boardColors, useApp } from "./store";

/**
 * Animated GIFs of games, made here with no library: positions are drawn on a
 * canvas, reduced to a fixed 256-colour palette, and written as GIF89a with
 * LZW compression.
 */

/** A fixed palette: a 6×7×6 colour cube (252 colours) plus four greys. */
const PALETTE: number[] = (() => {
  const p: number[] = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) p.push(Math.round((r * 255) / 5), Math.round((g * 255) / 6), Math.round((b * 255) / 5));
  for (const v of [32, 96, 160, 224]) p.push(v, v, v);
  return p;
})();

function quantise(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    const r = Math.round((rgba[i] * 5) / 255), g = Math.round((rgba[i + 1] * 6) / 255), b = Math.round((rgba[i + 2] * 5) / 255);
    out[j] = r * 42 + g * 6 + b;
  }
  return out;
}

/** GIF LZW: variable-width codes from 9 to 12 bits, packed little-endian into 255-byte blocks. */
function lzw(indices: Uint8Array, out: number[]) {
  const min = 8, clear = 1 << min, eoi = clear + 1;
  let size = min + 1, next = eoi + 1;
  const table = new Map<number, number>();
  const bytes: number[] = [];
  let acc = 0, bits = 0;
  const emit = (code: number) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) { bytes.push(acc & 255); acc >>>= 8; bits -= 8; }
  };
  emit(clear);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = (cur << 8) | k;
    const code = table.get(key);
    if (code !== undefined) { cur = code; continue; }
    emit(cur);
    if (next === 4096) {
      emit(clear);
      table.clear();
      next = eoi + 1;
      size = min + 1;
    } else {
      if (next >= 1 << size) size++;
      table.set(key, next++);
    }
    cur = k;
  }
  emit(cur);
  emit(eoi);
  if (bits > 0) bytes.push(acc & 255);
  out.push(min);
  for (let i = 0; i < bytes.length; i += 255) {
    const block = bytes.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0);
}

export function encodeGif(frames: { pixels: Uint8Array; delay: number }[], width: number, height: number): Uint8Array {
  const out: number[] = [];
  const word = (n: number) => out.push(n & 255, (n >> 8) & 255);
  out.push(...[..."GIF89a"].map((c) => c.charCodeAt(0)));
  word(width); word(height);
  out.push(0xf7, 0, 0); // global colour table of 256 entries
  out.push(...PALETTE);
  // Loop forever.
  out.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0, f.delay & 255, (f.delay >> 8) & 255, 0, 0);
    out.push(0x2c); word(0); word(0); word(width); word(height); out.push(0);
    lzw(f.pixels, out);
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

const loadImage = (src: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => reject(new Error(`Could not load ${src}`));
  img.src = src;
});

/** Draws every position of the game's main line and returns the GIF. */
export async function gameGif(tree: GameTree, flipped = false, size = 400): Promise<Uint8Array> {
  const { settings } = useApp.getState();
  const colors = boardColors(settings.boardTheme);
  const set = settings.pieceSet === "letter" ? "cburnett" : settings.pieceSet;
  const names = ["K", "Q", "R", "B", "N", "P"];
  const pieces = new Map<string, HTMLImageElement>();
  for (const c of ["w", "b"]) for (const n of names) pieces.set(c + n, await loadImage(`/pieces/${set}/${c}${n}.svg`));
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const sq = size / 8;
  const nodes = [tree.root, ...tree.mainline];
  const frames = nodes.map((node, i) => {
    const last = node.lastMove;
    const placement = node.fen.split(" ")[0].split("/");
    for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
      const x = (flipped ? 7 - f : f) * sq, y = (flipped ? 7 - r : r) * sq;
      const name = "abcdefgh"[f] + (8 - r);
      ctx.fillStyle = (r + f) % 2 ? colors.dark : colors.light;
      ctx.fillRect(x, y, sq, sq);
      if (last && (last[0] === name || last[1] === name)) { ctx.fillStyle = "rgba(205, 210, 106, 0.55)"; ctx.fillRect(x, y, sq, sq); }
    }
    placement.forEach((row, r) => {
      let f = 0;
      for (const ch of row) {
        if (/\d/.test(ch)) { f += Number(ch); continue; }
        if (ch === "~") continue;
        const img = pieces.get((ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase());
        if (img) ctx.drawImage(img, (flipped ? 7 - f : f) * sq, (flipped ? 7 - r : r) * sq, sq, sq);
        f++;
      }
    });
    // The last position stays up longer before the animation starts again.
    return { pixels: quantise(ctx.getImageData(0, 0, size, size).data), delay: i === nodes.length - 1 ? 300 : i === 0 ? 120 : 80 };
  });
  return encodeGif(frames, size, size);
}
