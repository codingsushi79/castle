// Bundles Castle's online code (src/lib) for the tests that run it in Node.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "../..");

export async function buildClient() {
  const entry = path.join(here, ".build/client-entry.ts");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `
export { useOnline, ratingWindow } from "${root}/src/lib/online";
export { useRace } from "${root}/src/lib/race";
export { usePuzzles } from "${root}/src/lib/puzzles";
export { useRepertoire, checkPrep } from "${root}/src/lib/repertoire";
export { encodeGif } from "${root}/src/lib/gif";
export { GameTree, positionOf, moveFromUci } from "${root}/src/lib/chess";
`);
  await build({
    entryPoints: [entry], bundle: true, platform: "node", format: "esm", outfile: path.join(here, ".build/client.mjs"), logLevel: "error",
    nodePaths: [path.join(root, "node_modules")],
    alias: { "@tauri-apps/plugin-notification": path.join(here, "notification-shim.mjs") },
  });
  return path.join(here, ".build/client.mjs");
}
