import { isTauri } from "./storage";

let granted: boolean | undefined;

/** Shows a system notification when the window is not in front. */
export async function notify(title: string, body: string, always = false) {
  if (!always && document.hasFocus()) return;
  if (!isTauri) return;
  try {
    const n = await import("@tauri-apps/plugin-notification");
    if (granted === undefined) {
      granted = await n.isPermissionGranted();
      if (!granted) granted = (await n.requestPermission()) === "granted";
    }
    if (granted) n.sendNotification({ title, body });
  } catch {
    /* notifications unavailable */
  }
}
