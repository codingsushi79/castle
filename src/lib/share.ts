import { notifications } from "@mantine/notifications";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { GameTree } from "./chess";
import { gameGif } from "./gif";
import { ONLINE_API } from "./online";
import { call, copyText, isTauri } from "./storage";

/** Sharing an online game: a link anyone can open, the PGN, or an animated GIF. */
const say = (message: string) => notifications.show({ message, autoClose: 2200 });

export const shareLink = (code: string) => `${ONLINE_API.replace(/\/api$/, "")}/g/${code}`;

export async function copyShareLink(code: string) {
  await copyText(shareLink(code));
  say("Link copied. Anyone can open it in a browser.");
}

export async function copyPgn(tree: GameTree) {
  await copyText(tree.toPgn());
  say("PGN copied");
}

const fileName = (tree: GameTree, ext: string) =>
  `${tree.tag("White", "White")} vs ${tree.tag("Black", "Black")}.${ext}`.replace(/[\\/:*?"<>|]/g, "_");

/** Saves bytes to a file the user picks, or downloads them outside the app. */
async function saveFile(name: string, ext: string, bytes: Uint8Array, type: string) {
  if (isTauri) {
    const path = await saveDialog({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return false;
    await call("write_bytes", { path, bytes: Array.from(bytes) });
  } else {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    a.click();
    URL.revokeObjectURL(url);
  }
  return true;
}

export async function savePgn(tree: GameTree) {
  if (await saveFile(fileName(tree, "pgn"), "pgn", new TextEncoder().encode(tree.toPgn()), "application/x-chess-pgn")) say("PGN saved");
}

export async function saveGif(tree: GameTree, flipped = false) {
  say("Making the GIF…");
  const bytes = await gameGif(tree, flipped);
  if (await saveFile(fileName(tree, "gif"), "gif", bytes, "image/gif")) say("GIF saved");
}
