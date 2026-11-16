/**
 * Light moderation for a guest-only server: names and chat lose offensive
 * words, and a guest reported by several different players is muted for a day.
 * Each player can also block anyone: blocked players can't challenge them,
 * join their games or be paired with them.
 */

// Word stems that are not acceptable in a name, and are starred out in chat.
const STEMS = [
  "fuck", "shit", "cunt", "bitch", "whore", "slut", "dick", "cock", "pussy", "asshole", "bastard",
  "nigg", "nigga", "fag", "retard", "spic", "chink", "kike", "tranny", "rape", "nazi", "hitler",
];

/** Undoes the usual disguises: digits for letters, repeated letters, separators. */
function normalise(text: string): string {
  return text.toLowerCase()
    .replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/[4]/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")
    .replace(/[^a-z]/g, "")
    .replace(/(.)\1+/g, "$1");
}

export function isOffensiveName(name: string): boolean {
  const n = normalise(name);
  return STEMS.some((s) => n.includes(s.replace(/(.)\1+/g, "$1")));
}

/** Chat text with offensive words starred out (word by word, so "Scunthorpe" survives). */
export function cleanText(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!|]+/gu, (word) => {
    const n = normalise(word);
    return STEMS.some((s) => n.startsWith(s.replace(/(.)\1+/g, "$1"))) ? "*".repeat(word.length) : word;
  });
}

/** Distinct reporters within a day that mute a guest's chat. */
export const MUTE_AFTER_REPORTS = 3;
