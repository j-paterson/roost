/**
 * Surface-form → canonical-slug map. Stored in Memory/aliases.json. Used by
 * the concept-router to bypass the LLM when a cluster headline contains a
 * known alias substring. See spec §11 + §8.2.
 */

export type AliasMap = Record<string, string>;

export function parseAliases(json: string): AliasMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: AliasMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export function serializeAliases(a: AliasMap): string {
  const sorted: AliasMap = {};
  for (const k of Object.keys(a).sort()) sorted[k] = a[k];
  return JSON.stringify(sorted, null, 2);
}

/**
 * Case-insensitive substring match against alias keys. Longest-match-wins
 * when multiple aliases match the same headline. Returns the canonical slug
 * or null.
 */
export function lookupAlias(headline: string, aliases: AliasMap): string | null {
  if (!headline) return null;
  const h = headline.toLowerCase();
  let bestKey: string | null = null;
  let bestLen = -1;
  for (const key of Object.keys(aliases)) {
    if (h.includes(key) && key.length > bestLen) {
      bestKey = key;
      bestLen = key.length;
    }
  }
  return bestKey ? aliases[bestKey] : null;
}

/**
 * Add new alias entries pointing at `slug`. Existing entries are NOT
 * overwritten — first-write-wins so user-edited aliases are durable.
 * Surface forms are lowercased + trimmed before insertion. Empty /
 * whitespace-only entries are skipped.
 */
export function addAliases(
  existing: AliasMap,
  slug: string,
  surfaceForms: string[],
): AliasMap {
  const out = { ...existing };
  for (const raw of surfaceForms) {
    const key = raw.toLowerCase().trim();
    if (!key) continue;
    if (key in out) continue;
    out[key] = slug;
  }
  return out;
}
