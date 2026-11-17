/**
 * Light moderation for a guest-only server: names and chat lose offensive
 * words, and a guest reported by several different players is muted for a day.
 * Each player can also block anyone: blocked players can't challenge them,
 * join their games or be paired with them.
 *
 * The patterns are deliberately specific, so that ordinary words and names
 * ("Knights", "Nigeria", "Scunthorpe", "grapes", "peacock") are left alone.
 */
const PATTERNS = [
  /fuck/, /shit(?!ake)/, /cunt(?!horpe)/, /bitch/, /whore/, /slut/, /pussy/, /asshole/, /bastard/,
  /n+i+g{2,}(e+r|a+h?|uh)/, /fag{2,}ot|^fags?$/, /retard/, /^spics?$/, /chink/, /^kikes?$/, /tranny/, /rapist/, /nazi/, /hitler/,
];

/** Undoes the usual disguises: digits and symbols for letters, separators between letters. */
function normalise(text: string): string {
  return text.toLowerCase()
    .replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/3/g, "e").replace(/4/g, "a").replace(/[5$]/g, "s").replace(/7/g, "t")
    .replace(/[^a-z]/g, "");
}

const offensive = (text: string) => {
  const n = normalise(text);
  return n.length > 0 && PATTERNS.some((p) => p.test(n));
};

export function isOffensiveName(name: string): boolean {
  return offensive(name);
}

/** Chat text with offensive words starred out, word by word. */
export function cleanText(text: string): string {
  return text.replace(/[\p{L}\p{N}@$!|]+/gu, (word) => (offensive(word) ? "*".repeat(word.length) : word));
}

/** Distinct reporters within a day that mute a guest's chat. */
export const MUTE_AFTER_REPORTS = 3;
