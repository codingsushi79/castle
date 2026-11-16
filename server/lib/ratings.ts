import type { Variant } from "./chess.js";
import type { Profile } from "./token.js";

/**
 * Each guest has a rating per category. Standard chess is split by speed;
 * every variant (Chess960 included) has its own. `rating` on the profile stays
 * an overall number that moves by the same amount as each game's category,
 * which is what Castle 2.3.0 and older show.
 */
export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "correspondence"] as const;

/** Estimated game length (minutes + 40 moves of increment) picks the speed. */
export function categoryOf(variant: Variant, minutes: number, increment: number, days?: number | null): string {
  if (variant !== "chess") return variant;
  if (days) return "correspondence";
  const est = minutes * 60 + increment * 40;
  return est < 180 ? "bullet" : est < 480 ? "blitz" : est < 1500 ? "rapid" : "classical";
}

export function ratingIn(p: Profile, category: string): number {
  // A guest's first game in a speed starts from their overall rating; variants start fresh.
  return p.ratings?.[category]?.r ?? ((SPEEDS as readonly string[]).includes(category) ? p.rating : 1500);
}

export const gamesIn = (p: Profile, category: string) => p.ratings?.[category]?.g ?? 0;
