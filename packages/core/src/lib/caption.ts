/**
 * TikTok "titles" are raw captions that typically end with a stack of
 * hashtags (already rendered as tag pills) and sometimes begin with a
 * 📍/emoji marker. This splits the caption into a short title + a
 * description body for the expanded card, and cleans the shorter title
 * used in compact cards.
 */

const TRAILING_HASHTAGS = /(?:\s*#[\w-]+)+\s*$/u;
// Hashtag "stacks" — 2+ consecutive hashtags — are SEO blocks, not inline
// references. Strip them wherever they occur; the pills at the bottom already
// surface the tags.
const HASHTAG_STACK = /(?:\s*#[\w-]+){2,}/gu;
const LEADING_NOISE = /^[\s\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]+/u;

export function cleanCaption(raw: string): string {
  return raw
    .replace(TRAILING_HASHTAGS, "")
    .replace(HASHTAG_STACK, " ")
    .replace(LEADING_NOISE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split a cleaned caption into title + description. Title is the first
 * sentence (up to ~120 chars) if a sentence boundary exists, otherwise
 * a word-boundary cut near 80 chars. Short captions return all-title.
 */
export function splitCaption(raw: string): { title: string; description: string | null } {
  const s = cleanCaption(raw);
  if (s.length <= 80) return { title: s, description: null };

  const sentenceMatch = s.slice(0, 140).match(/^(.{10,}?[.!?])\s+(.+)/);
  if (sentenceMatch) {
    const rest = (sentenceMatch[2] + s.slice(sentenceMatch[0].length)).trim();
    return { title: sentenceMatch[1], description: rest || null };
  }

  const cut = s.lastIndexOf(" ", 80);
  if (cut > 20) {
    return { title: s.slice(0, cut), description: s.slice(cut + 1).trim() || null };
  }

  return { title: s, description: null };
}
