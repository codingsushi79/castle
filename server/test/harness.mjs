// Builds the server against PGlite and gives tests a way to call it.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, ".build");

export async function loadServer() {
  process.env.RATING_KEY ??= "33".repeat(32);
  process.env.DATABASE_URL ??= "postgres://test";
  for (const name of ["index", "live"]) {
    await build({
      entryPoints: [path.join(here, `../api/${name}.ts`)], bundle: true, platform: "node", format: "esm",
      outfile: path.join(out, `${name}.mjs`), logLevel: "warning",
      alias: { "@neondatabase/serverless": path.join(here, "neon-shim.mjs") },
      external: ["@electric-sql/pglite", "ws"],
    });
  }
  const api = await import(pathToFileURL(path.join(out, "index.mjs")).href);
  const { db } = await import(pathToFileURL(path.join(here, "neon-shim.mjs")).href);
  const call = async (p, body) => {
    const req = new Request(`https://castle.test/api/${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
    const r = await (body === undefined ? api.GET : api.POST)(req);
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { text }; }
    data._status = r.status;
    data._type = r.headers.get("content-type");
    return data;
  };
  return { api, call, db, livePath: pathToFileURL(path.join(out, "live.mjs")).href };
}

/** A tiny test runner: named checks, a summary, and a failing exit code. */
export function checks() {
  let failed = 0, passed = 0;
  return {
    ok(cond, name) {
      if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}`); }
    },
    section(name) { console.log(`\n${name}`); },
    done() {
      console.log(`\n${passed} passed, ${failed} failed`);
      process.exit(failed ? 1 : 0);
    },
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(f, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await f()) return true; await wait(100); }
  return false;
}
