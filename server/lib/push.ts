import { createECDH, createHmac } from "node:crypto";
import webpush from "web-push";
import { CORS, fail, Handler, json, sql } from "./db.js";
import { verified } from "./game.js";

/**
 * Phone alerts (web push): a correspondence move or a challenge reaches a
 * player's phone even when Castle is closed. The desktop app shows a QR code
 * for /alerts?code=…; the phone opens it, allows notifications, and is linked to
 * that player. The web version of Castle can turn alerts on directly.
 *
 * The push signing key (VAPID) is derived from RATING_KEY, so there is no
 * extra secret to set up.
 */
let keys: { publicKey: string; privateKey: string } | undefined;
function vapid() {
  if (!keys) {
    const priv = createHmac("sha256", Buffer.from(process.env.RATING_KEY ?? "", "hex")).update("castle-web-push-vapid").digest();
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(priv);
    keys = { publicKey: ecdh.getPublicKey().toString("base64url"), privateKey: priv.toString("base64url") };
    webpush.setVapidDetails("https://castle-online.vercel.app", keys.publicKey, keys.privateKey);
  }
  return keys;
}

const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Sends an alert to every device a player linked. Gives up quickly: a request never waits long on it. */
export async function alert(guest: string | null | undefined, title: string, body: string, url = "/play/") {
  if (!guest || guest.startsWith("bot:")) return;
  try {
    vapid();
    const subs = await sql`select endpoint, sub from push_subs where guest = ${guest}`;
    await Promise.race([
      Promise.all(subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.sub, JSON.stringify({ title, body, url }), { TTL: 6 * 3600, urgency: "high" });
        } catch (e: any) {
          // The phone unsubscribed or the browser forgot it: drop it.
          if (e?.statusCode === 404 || e?.statusCode === 410) await sql`delete from push_subs where endpoint = ${s.endpoint}`;
        }
      })),
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (e) {
    console.error("alert failed", e);
  }
}

async function subscribe(guest: string, sub: any) {
  if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth || JSON.stringify(sub).length > 2000) return false;
  await sql`insert into push_subs (endpoint, guest, sub) values (${sub.endpoint}, ${guest}, ${JSON.stringify(sub)})
    on conflict (endpoint) do update set guest = excluded.guest, sub = excluded.sub`;
  return true;
}

export const pushRoutes: Record<string, Handler> = {
  "GET push/key": async () => json({ key: vapid().publicKey }),

  /** A code, good for 30 minutes, that links a phone to this player for alerts. */
  "POST alerts/code": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await sql`delete from alert_codes where guest = ${p.id} or created_at < now() - interval '1 day'`;
    let code = "";
    for (let i = 0; i < 8; i++) code += codeChars[Math.floor(Math.random() * codeChars.length)];
    await sql`insert into alert_codes (code, guest) values (${code}, ${p.id})`;
    return json({ code, url: `https://castle-online.vercel.app/alerts?code=${code}` });
  },

  /** The phone's subscription, with the code from the QR, or a signed-in web app's token. */
  "POST alerts/subscribe": async (_r, _u, b) => {
    let guest: string | undefined;
    if (b.code) guest = (await sql`select guest from alert_codes where code = ${String(b.code).toUpperCase()} and created_at > now() - interval '30 minutes'`)[0]?.guest;
    else guest = (await verified(b.token))?.id;
    if (!guest) return fail(b.code ? "That code has expired. Make a new one in Castle." : "Your rating token is not valid.", 401);
    if (!(await subscribe(guest, b.subscription))) return fail("That browser didn't give a usable subscription.");
    const name = (await sql`select name from guests where id = ${guest}`)[0]?.name ?? null;
    await alert(guest, "Castle alerts are on", "You'll hear about your correspondence moves and challenges here.");
    return json({ ok: true, name });
  },

  "POST alerts/devices": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    if (b.clear) await sql`delete from push_subs where guest = ${p.id}`;
    const n = (await sql`select count(*)::int as n from push_subs where guest = ${p.id}`)[0].n;
    return json({ devices: n });
  },

  "POST alerts/test": async (_r, _u, b) => {
    const p = await verified(b.token);
    if (!p) return fail("Your rating token is not valid.", 401);
    await alert(p.id, "Test alert from Castle", "If you can read this, alerts work on this device.");
    return json({ ok: true });
  },

  /** The page a phone opens from the QR code. */
  "GET alerts": async () => new Response(ALERTS_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }),

  /** The service worker that shows alerts and opens Castle when one is tapped. */
  "GET sw": async () => new Response(SERVICE_WORKER, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/", ...CORS } }),

  "GET manifest": async () => json({
    name: "Castle", short_name: "Castle", start_url: "/play/", scope: "/", display: "standalone",
    background_color: "#191817", theme_color: "#191817", icons: [{ src: "/play/icon-512.png", sizes: "512x512", type: "image/png" }],
  }),
};

const SERVICE_WORKER = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = { title: "Castle", body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(d.title || "Castle", { body: d.body || "", icon: "/play/icon-512.png", badge: "/play/icon-512.png", data: { url: d.url || "/play/" }, tag: d.tag }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data && event.notification.data.url || "/play/", self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin + "/play") && "focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
`;

const ALERTS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Castle alerts</title><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#191817">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="robots" content="noindex">
<style>
:root{--bg:#f4f1ea;--fg:#1d1b18;--muted:#6b665d;--accent:#2f9e77;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#191817;--fg:#ece8e1;--muted:#a19a8e;--panel:#232220}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-rounded,system-ui,sans-serif;display:flex;justify-content:center;padding:24px 16px}
main{max-width:420px;width:100%}h1{font-size:24px;margin:0 0 8px}.card{background:var(--panel);border-radius:12px;padding:16px;margin-top:16px}
button{width:100%;font:inherit;font-weight:700;padding:14px;border:0;border-radius:10px;background:var(--accent);color:#fff;margin-top:12px}
button:disabled{opacity:.5}.muted{color:var(--muted);font-size:14px}.ok{color:var(--accent);font-weight:700}.err{color:#c0392b}
</style></head><body><main>
<h1>♜ Castle alerts</h1>
<p class="muted">Get a notification on this device when it's your move in a correspondence game, or someone challenges you, even when Castle is closed.</p>
<div class="card" id="box"><p class="muted" id="msg">Checking this browser…</p><button id="go" disabled>Turn on alerts</button></div>
<p class="muted">You can turn alerts off at any time in your browser's settings, or remove every linked device from Castle.</p>
</main>
<script>
const code = new URLSearchParams(location.search).get("code") || "";
const msg = document.getElementById("msg"), go = document.getElementById("go");
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
const say = (t, cls) => { msg.className = cls || "muted"; msg.textContent = t; };
const b64 = (s) => { const p = "=".repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(r, (c) => c.charCodeAt(0)); };
if (!code) say("Open this page from the QR code in Castle (Play → Online → Ratings & transfer → Phone alerts).", "err");
else if (ios && !standalone) say("On iPhone and iPad, alerts need this page on your Home Screen first: tap Share, then Add to Home Screen, then open Castle from there.", "muted");
else if (!("serviceWorker" in navigator) || !("PushManager" in window)) say("This browser can't receive alerts. Try Chrome or Firefox, or Safari from the Home Screen on iPhone.", "err");
else { say("Ready. You'll be asked to allow notifications."); go.disabled = false; }
go.onclick = async () => {
  go.disabled = true;
  try {
    if (await Notification.requestPermission() !== "granted") { say("Notifications weren't allowed. You can allow them in this browser's site settings and try again.", "err"); go.disabled = false; return; }
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    const { key } = await (await fetch("/api/push/key")).json();
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) });
    const r = await fetch("/api/alerts/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, subscription: sub.toJSON() }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || r.status);
    say("Alerts are on" + (d.name ? " for " + d.name : "") + ". A test alert is on its way.", "ok");
    go.textContent = "Done";
  } catch (e) { say("That didn't work: " + e.message, "err"); go.disabled = false; }
};
</script></body></html>`;
