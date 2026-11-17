// One player for the two-player play test: Castle's real online code (src/lib) in
// its own process, with its own storage, talking to the test server over HTTP and a
// WebSocket. The parent sends it snippets to run against its stores.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket as WS } from "ws";

const [apiPort, livePort] = process.argv.slice(2).map(Number);
const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
globalThis.document = { hasFocus: () => true };
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(String(url).replace("https://castle-online.vercel.app", `http://127.0.0.1:${apiPort}`), init);
globalThis.WebSocket = class extends WS {
  constructor(url) { super(String(url).replace("wss://castle-online.vercel.app/api/live", `ws://127.0.0.1:${livePort}`)); }
};

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = await import(pathToFileURL(path.join(here, ".build/client.mjs")).href);
const o = () => lib.useOnline.getState();
const r = () => lib.useRace.getState();
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const until = async (f, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await wait(50); } return false; };
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

process.on("message", async ({ id, code }) => {
  try {
    const value = await new AsyncFunction("o", "r", "lib", "wait", "until", code)(o, r, lib, wait, until);
    process.send({ id, value: value === undefined ? null : JSON.parse(JSON.stringify(value)) });
  } catch (e) {
    process.send({ id, error: String(e?.stack ?? e) });
  }
});
process.send({ ready: true });
