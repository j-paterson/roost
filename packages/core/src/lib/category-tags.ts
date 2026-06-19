/**
 * Shared category-tag slug helpers used by both the Smart Assign pipeline
 * (confirm.ts) and the bulk migration script (scripts/migrate-to-tags.mjs).
 *
 * SLUG CONTRACT (must match scripts/migrate-to-tags.mjs tagSlug):
 *   - Lowercase the input.
 *   - Replace every run of non-alphanumeric characters with a single "-".
 *   - Trim leading and trailing "-".
 *   - "Places & Travel" → "places-travel"
 *   - "Content Creation" → "content-creation"
 *
 * NESTED TAGS:
 *   "Parent/Child" splits on "/" and slugifies each part, producing
 *   "category/parent/child" (Obsidian nested-tag convention).
 */

// ── Slug contract ────────────────────────────────────────────────────────────

/**
 * Convert a display name to a tag-safe slug.
 *
 * Exactly mirrors the `tagSlug` function in scripts/migrate-to-tags.mjs:
 *   .toLowerCase()
 *   .replace(/[^a-z0-9]+/g, "-")
 *   .replace(/^-|-$/g, "")
 *   || "untitled"
 */
export function categorySlug(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "untitled";
}

/**
 * Convert a category display name to an Obsidian native tag string.
 *
 * Exactly mirrors `tagToObsidianTag` in scripts/migrate-to-tags.mjs:
 *   - Split on "/" to support nested tags.
 *   - Slugify each part (trim whitespace, then categorySlug).
 *   - Join with "/" and prepend "category/".
 *
 * Examples:
 *   "Tech"            → "category/tech"
 *   "Places & Travel" → "category/places-travel"
 *   "Parent/Child"    → "category/parent/child"
 */
export function tagToObsidianTag(name: string): string {
  const parts = name.split("/").map((p) => categorySlug(p.trim()));
  return "category/" + parts.join("/");
}

/**
 * Append `category/<slug>` Obsidian tags for each provided category name to
 * an existing tag array, deduplicating against what is already present.
 * Never removes existing tags.
 *
 * @param existingTags  The note's current `tags` array (not mutated).
 * @param names         Category display names to append (e.g. ["Tech", "Humor"]).
 * @returns             A new array with the new tags appended, no duplicates.
 */
export function appendCategoryTags(existingTags: string[], names: string[]): string[] {
  const existing = new Set(existingTags);
  const toAdd: string[] = [];
  for (const name of names) {
    const obsTag = tagToObsidianTag(name);
    if (!existing.has(obsTag)) {
      toAdd.push(obsTag);
      existing.add(obsTag); // prevent double-add within `names`
    }
  }
  return [...existingTags, ...toAdd];
}
