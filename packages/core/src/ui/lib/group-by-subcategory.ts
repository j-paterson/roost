/**
 * Group item IDs by their assigned subcategory. Subcategories sort alphabetically;
 * the `[no subcategory]` bucket (key: null) sorts last.
 *
 * Used by the staging panel to render the 3-level proposal tree (top-level →
 * subcategory → items).
 */
export function groupBySubcategory(
  itemIds: string[],
  assignedSubcategories: Map<string, string | null>,
): { subcategory: string | null; itemIds: string[] }[] {
  if (itemIds.length === 0) return [];
  const groups = new Map<string | null, string[]>();
  for (const id of itemIds) {
    const subcat = assignedSubcategories.get(id) ?? null;
    let bucket = groups.get(subcat);
    if (!bucket) { bucket = []; groups.set(subcat, bucket); }
    bucket.push(id);
  }
  const sorted: { subcategory: string | null; itemIds: string[] }[] = [];
  const keys = [...groups.keys()].filter(k => k !== null).sort() as string[];
  for (const k of keys) sorted.push({ subcategory: k, itemIds: groups.get(k)! });
  if (groups.has(null)) sorted.push({ subcategory: null, itemIds: groups.get(null)! });
  return sorted;
}

/**
 * Subcategory groups for a single parent folder. Excludes the loose-items
 * bucket (subcategory: null). Includes empty subcategories from the explicit
 * `emptySubcategories` list so manually-created subcats with zero items still
 * appear in the staging tree. Sorted alphabetically by name.
 *
 * Used by TreeExplorer to render subcategory tree nodes as filesystem-like
 * children of the parent folder.
 */
export function subcategoriesForFolder(
  itemIds: string[],
  assignedSubcategories: Map<string, string | null>,
  emptySubcategories: string[],
): { name: string; itemIds: string[] }[] {
  const buckets = new Map<string, string[]>();
  for (const id of itemIds) {
    const subcat = assignedSubcategories.get(id) ?? null;
    if (subcat === null) continue;
    let arr = buckets.get(subcat);
    if (!arr) { arr = []; buckets.set(subcat, arr); }
    arr.push(id);
  }
  for (const name of emptySubcategories) {
    if (!buckets.has(name)) buckets.set(name, []);
  }
  return [...buckets.keys()]
    .sort()
    .map(name => ({ name, itemIds: buckets.get(name)! }));
}
