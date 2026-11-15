import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Color, GameTree } from "./chess";
import { call } from "./storage";
import { boardColors, useApp } from "./store";

const images = new Map<string, Promise<HTMLImageElement>>();
function pieceImage(set: string, code: string): Promise<HTMLImageElement> {
  const url = `/pieces/${set}/${code}.svg`;
  if (!images.has(url)) {
    images.set(url, new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    }));
  }
  return images.get(url)!;
}

/** Draws a position onto a canvas using the board colours and piece set from Settings. */
export async function renderBoard(fen: string, size = 800, orientation: Color = "white", lastMove?: [string, string]): Promise<HTMLCanvasElement> {
  const { boardTheme, pieceSet } = useApp.getState().settings;
  const theme = boardColors(boardTheme);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const sq = size / 8;
  const xy = (file: number, rank: number) => (orientation === "white" ? [file * sq, (7 - rank) * sq] : [(7 - file) * sq, rank * sq]);
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const [x, y] = xy(file, rank);
      ctx.fillStyle = (file + rank) % 2 ? theme.light : theme.dark;
      ctx.fillRect(x, y, sq, sq);
      const name = "abcdefgh"[file] + (rank + 1);
      if (lastMove?.includes(name)) {
        ctx.fillStyle = "rgba(255,221,51,0.42)";
        ctx.fillRect(x, y, sq, sq);
      }
    }
  }
  const rows = fen.split(" ")[0].split("[")[0].split("/");
  const jobs: Promise<void>[] = [];
  rows.forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { file += parseInt(ch, 10); continue; }
      if (ch === "~") continue;
      const code = (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase();
      const [x, y] = xy(file, 7 - r);
      jobs.push(pieceImage(pieceSet, code).then((img) => ctx.drawImage(img, x, y, sq, sq)).catch(() => {}));
      file++;
    }
  });
  await Promise.all(jobs);
  return canvas;
}

const toBlob = (c: HTMLCanvasElement) => new Promise<Blob>((res) => c.toBlob((b) => res(b!), "image/png"));

export async function copyBoardImage(fen: string, orientation: Color, lastMove?: [string, string]) {
  const blob = toBlob(await renderBoard(fen, 800, orientation, lastMove));
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

export async function saveBoardImage(fen: string, orientation: Color, lastMove?: [string, string]): Promise<boolean> {
  const path = await saveDialog({ defaultPath: "Position.png", filters: [{ name: "PNG image", extensions: ["png"] }] });
  if (!path) return false;
  const blob = await toBlob(await renderBoard(fen, 1200, orientation, lastMove));
  await call("write_bytes", { path, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) });
  return true;
}

// MARK: GIF

/** LZW compression as the GIF format requires it. */
function lzw(indices: Uint8Array, minCode: number): number[] {
  const out: number[] = [];
  let buffer = 0, bits = 0;
  const emit = (code: number, size: number) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) { out.push(buffer & 255); buffer >>= 8; bits -= 8; }
  };
  const clear = 1 << minCode, end = clear + 1;
  let size = minCode + 1, next = end + 1;
  let table = new Map<number, number>();
  emit(clear, size);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const hit = table.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(clear, size);
      table = new Map();
      size = minCode + 1;
      next = end + 1;
    }
    prefix = k;
  }
  emit(prefix, size);
  emit(end, size);
  if (bits > 0) out.push(buffer & 255);
  return out;
}

/** Encodes frames as a looping GIF with a fixed 6x6x6 colour cube. */
export function encodeGif(frames: ImageData[], delays: number[]): Uint8Array {
  const w = frames[0].width, h = frames[0].height;
  const bytes: number[] = [];
  const word = (n: number) => bytes.push(n & 255, (n >> 8) & 255);
  bytes.push(...[..."GIF89a"].map((c) => c.charCodeAt(0)));
  word(w); word(h);
  bytes.push(0xf7, 0, 0);
  for (let i = 0; i < 256; i++) {
    if (i < 216) bytes.push(Math.floor(i / 36) * 51, (Math.floor(i / 6) % 6) * 51, (i % 6) * 51);
    else bytes.push(0, 0, 0);
  }
  bytes.push(0x21, 0xff, 11, ...[..."NETSCAPE2.0"].map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  frames.forEach((frame, f) => {
    bytes.push(0x21, 0xf9, 4, 0);
    word(Math.round(delays[f] / 10));
    bytes.push(0, 0, 0x2c);
    word(0); word(0); word(w); word(h);
    bytes.push(0, 8);
    const idx = new Uint8Array(w * h);
    const d = frame.data;
    for (let i = 0; i < idx.length; i++) {
      idx[i] = Math.round(d[i * 4] / 51) * 36 + Math.round(d[i * 4 + 1] / 51) * 6 + Math.round(d[i * 4 + 2] / 51);
    }
    const data = lzw(idx, 8);
    for (let i = 0; i < data.length; i += 255) {
      const chunk = data.slice(i, i + 255);
      bytes.push(chunk.length, ...chunk);
    }
    bytes.push(0);
  });
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

/** Writes the main line of a game as a looping GIF, one frame per move. */
export async function saveGameGif(tree: GameTree, orientation: Color): Promise<boolean> {
  const path = await saveDialog({ defaultPath: `${tree.tag("White", "White")} vs ${tree.tag("Black", "Black")}.gif`, filters: [{ name: "GIF", extensions: ["gif"] }] });
  if (!path) return false;
  const nodes = [tree.root, ...tree.mainline];
  const frames: ImageData[] = [];
  for (const n of nodes) {
    const c = await renderBoard(n.fen, 400, orientation, n.lastMove);
    frames.push(c.getContext("2d")!.getImageData(0, 0, 400, 400));
  }
  const gif = encodeGif(frames, nodes.map((_, i) => (i === nodes.length - 1 ? 3000 : 700)));
  await call("write_bytes", { path, bytes: Array.from(gif) });
  return true;
}
