import type { App } from "obsidian";
import { CATEGORY_FIELD, SUBCATEGORY_FIELD, PLATFORM_DISPLAY } from "@/config";
import { getSyncFiles, matchesCategoryFilter } from "@/lib/vault-utils";
import type { RoostSettings } from "@/settings";

export interface LibraryTreeSubcategory {
  name: string;
  count: number;
}

export interface LibraryTreeCategory {
  name: string;
  count: number;
  subcategories?: LibraryTreeSubcategory[];
}

export interface LibraryTreeData {
  total: number;
  unsorted: number;
  categories: LibraryTreeCategory[];
  platforms: { name: string; display: string; total: number }[];
}

function sortByCustomOrder<T extends [string, number]>(
  entries: T[],
  order: string[],
): T[] {
  if (!order.length) return entries.sort((a, b) => b[1] - a[1]);
  const ranked = new Map(order.map((n, i) => [n, i] as const));
  return entries.sort((a, b) => {
    const ra = ranked.get(a[0]);
    const rb = ranked.get(b[0]);
    if (ra != null && rb != null) return ra - rb;
    if (ra != null) return -1;
    if (rb != null) return 1;
    return b[1] - a[1];
  });
}

/** Scan sync-folder bookmarks and build library-tree counts for the sidebar. */
export function scanLibraryTree(
  app: App,
  syncFolder: string,
  settings: Pick<RoostSettings, "categoryOrder" | "subcategoryOrder" | "emptySubcategories">,
): LibraryTreeData {
  const files = getSyncFiles(app.vault, syncFolder);
  const platformTotals = new Map<string, number>();
  const categories = new Map<string, number>();
  const subcatCounts = new Map<string, Map<string, number>>();
  let grandTotal = 0;

  for (const file of files) {
    const fm = app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm?.roost_id) continue;
    const platform = fm.platform || "other";
    platformTotals.set(platform, (platformTotals.get(platform) || 0) + 1);
    grandTotal++;
    if (matchesCategoryFilter(fm, null)) {
      categories.set("__unsorted__", (categories.get("__unsorted__") || 0) + 1);
    } else {
      const cat = fm[CATEGORY_FIELD];
      categories.set(cat, (categories.get(cat) || 0) + 1);
      const subcat = fm[SUBCATEGORY_FIELD];
      if (subcat && typeof subcat === "string" && subcat.trim()) {
        if (!subcatCounts.has(cat)) subcatCounts.set(cat, new Map());
        const subs = subcatCounts.get(cat)!;
        subs.set(subcat.trim(), (subs.get(subcat.trim()) || 0) + 1);
      }
    }
  }

  const emptySubs = settings.emptySubcategories ?? {};
  for (const [cat, names] of Object.entries(emptySubs)) {
    if (!categories.has(cat)) continue;
    if (!subcatCounts.has(cat)) subcatCounts.set(cat, new Map());
    const subs = subcatCounts.get(cat)!;
    for (const name of names) {
      if (!subs.has(name)) subs.set(name, 0);
    }
  }

  return {
    total: grandTotal,
    unsorted: categories.get("__unsorted__") || 0,
    categories: sortByCustomOrder(
      [...categories.entries()].filter(([k]) => k !== "__unsorted__"),
      settings.categoryOrder ?? [],
    ).map(([k, v]) => ({
      name: k,
      count: v,
      subcategories: subcatCounts.has(k)
        ? sortByCustomOrder(
            [...subcatCounts.get(k)!.entries()],
            settings.subcategoryOrder?.[k] ?? [],
          ).map(([subName, subCount]) => ({ name: subName, count: subCount }))
        : undefined,
    })),
    platforms: [...platformTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => ({
        name,
        display: PLATFORM_DISPLAY[name] || name,
        total,
      })),
  };
}
