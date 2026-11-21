import { ReactNode, useState } from "react";
import { avatarUrl, isBot, useOnline } from "../lib/online";

/**
 * A Castle Online player's profile picture, or `fallback` (the circle that was
 * there before) when they have none, it hasn't loaded yet, or it can't load.
 * `version` is when it last changed, from their profile; without it the picture
 * may be a few minutes old.
 */
export function PlayerAvatar({ guest, version, size, ring, fallback }: {
  guest?: string | null; version?: number | null; size: number; ring?: "white" | "black"; fallback: ReactNode;
}) {
  const local = useOnline((s) => (guest ? s.avatars[guest] : undefined));
  const v = local !== undefined ? local : version;
  const src = guest && !isBot(guest) && v !== null ? avatarUrl(guest, v) : undefined;
  // What happened to which picture, so a new one starts out loading again.
  const [seen, setSeen] = useState<{ src: string; ok: boolean }>();
  const state = !seen || seen.src !== src ? "loading" : seen.ok ? "ok" : "none";
  if (!src || state === "none") return <>{fallback}</>;
  return (
    <>
      {state === "loading" && fallback}
      <img src={src} alt="" className={"player-pic" + (ring ? ` ring-${ring}` : "")} width={size} height={size}
        style={{ width: size, height: size, display: state === "ok" ? undefined : "none" }}
        onLoad={() => setSeen({ src, ok: true })} onError={() => setSeen({ src, ok: false })} />
    </>
  );
}

/** A picture file shrunk to a 160 px square (cropped from the middle) as a JPEG data URL, small enough to upload. */
export async function shrinkPicture(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => { throw new Error("That file isn't a picture Castle can read."); });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const size = 160;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff"; // transparent PNGs get a white background rather than black
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}
