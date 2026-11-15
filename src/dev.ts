// Development only: lets a script drive the running app by editing public/dev-command.json.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GameTree } from "./lib/chess";
import { useLichess } from "./lib/lichess";
import { usePuzzles } from "./lib/puzzles";
import { useRepertoire } from "./lib/repertoire";
import { call } from "./lib/storage";
import { useApp } from "./lib/store";
import { useOpenings } from "./lib/openings";
import { usePlay } from "./lib/play";
import { useFics } from "./lib/fics";
import { usePacks } from "./lib/packs";
import { useBatch } from "./lib/batch";
import { useEngines } from "./lib/engines";
import { useShortcuts } from "./lib/shortcuts";

let last = "";
const cgMove = async (from: string, to: string) => {
  const b = document.querySelector("cg-board")!;
  const r = b.getBoundingClientRect();
  const flipped = document.querySelector(".cg-wrap")!.classList.contains("orientation-black");
  const sq = r.width / 8;
  for (const s of [from, to]) {
    let f = s.charCodeAt(0) - 97, rk = +s[1] - 1;
    if (flipped) { f = 7 - f; rk = 7 - rk; }
    const x = r.left + (f + 0.5) * sq, y = r.top + (7 - rk + 0.5) * sq;
    b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y }));
    await new Promise((res) => setTimeout(res, 80));
  }
};
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const text = (sel: string) => (document.querySelector(sel) as HTMLElement | null)?.innerText.replace(/\n+/g, " | ") ?? "";
const click = (label: string) => ([...document.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(label)) as HTMLElement | undefined)?.click();
(window as any).castle = { useApp, usePuzzles, useRepertoire, useLichess, GameTree, cgMove, sleep, text, click, useOpenings, usePlay, useFics, usePacks, useBatch, useEngines, useShortcuts };
Object.assign(window, { cgMove, sleep, text, click, invoke, listen });
setInterval(async () => {
  try {
    const cmd = await fetch("/dev-command.json?" + Date.now()).then((r) => r.json());
    if (!cmd?.id || cmd.id === last) return;
    last = cmd.id;
    // eslint-disable-next-line no-eval
    let result: unknown;
    try {
      result = await (0, eval)(`(async () => { ${cmd.js} })()`);
    } catch (e: any) {
      result = "ERROR: " + (e?.stack ?? String(e));
    }
    console.log("dev", cmd.id, result);
    if (cmd.out) await call("write_text", { path: cmd.out, text: typeof result === "string" ? result : JSON.stringify(result ?? null) }).catch(() => {});
  } catch {
    /* no command file */
  }
}, 700);
