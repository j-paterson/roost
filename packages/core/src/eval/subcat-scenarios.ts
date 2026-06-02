/**
 * Pure function: vault items → eval scenarios JSON.
 *
 * Inputs are flat records (one per markdown file with a roost_id) so this
 * module is independent of how the vault is read. The CLI wrapper at
 * scripts/build-subcat-scenarios.mjs is responsible for converting markdown
 * files into VaultItem[] and writing the result to disk.
 */

export interface VaultItem {
  itemId: string;
  category: string | null;
  subcategory: string | null;
  /** Item embedding vector. Optional — items without an embedding are excluded
   *  from the parentCentroid computation but still counted in positives/negatives. */
  vec?: number[];
}

export interface BuildScenariosOpts {
  /** Parent qualifies only if it has ≥ minSubcats subcategories meeting minItemsPerSubcat. */
  minSubcats: number;
  /** A subcategory must have ≥ this many labeled items to count toward minSubcats. */
  minItemsPerSubcat: number;
  /** Per-parent cap on negatives, also bounded by min(N, # positives). */
  maxNegativesPerParent: number;
}

export interface ScenarioPositive {
  itemId: string;
  trueSubcat: string;
}

export interface ScenarioNegative {
  itemId: string;
}

export interface ScenarioParent {
  parent: string;
  subcategories: string[];
  /** Mean-pooled vector of all positive items' embeddings within this parent.
   *  null when no positives have embeddings (corner case: corrupted cache). */
  parentCentroid: number[] | null;
  positives: ScenarioPositive[];
  negatives: ScenarioNegative[];
}

export interface ScenarioFile {
  generatedAt: string;
  stats: { parentsIncluded: number; totalPositives: number; totalNegatives: number };
  parents: ScenarioParent[];
}

export function buildScenarios(items: VaultItem[], opts: BuildScenariosOpts): ScenarioFile {
  // Bucket positives and negatives by parent.
  const positivesByParent = new Map<string, Map<string, string[]>>();
  const negativesByParent = new Map<string, string[]>();
  for (const item of items) {
    if (!item.category) continue;
    if (item.subcategory) {
      let subs = positivesByParent.get(item.category);
      if (!subs) { subs = new Map(); positivesByParent.set(item.category, subs); }
      let ids = subs.get(item.subcategory);
      if (!ids) { ids = []; subs.set(item.subcategory, ids); }
      ids.push(item.itemId);
    } else {
      let negs = negativesByParent.get(item.category);
      if (!negs) { negs = []; negativesByParent.set(item.category, negs); }
      negs.push(item.itemId);
    }
  }

  // Build a lookup: itemId → vec (only for items that have a vector).
  const vecById = new Map<string, number[]>();
  for (const item of items) {
    if (item.vec) vecById.set(item.itemId, item.vec);
  }

  const parents: ScenarioParent[] = [];
  for (const [parent, subs] of positivesByParent) {
    const qualifying = [...subs.entries()]
      .filter(([, ids]) => ids.length >= opts.minItemsPerSubcat)
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (qualifying.length < opts.minSubcats) continue;

    const subcategories = qualifying.map(([name]) => name);
    const positives: ScenarioPositive[] = [];
    for (const [subcat, ids] of qualifying) {
      const sortedIds = [...ids].sort();
      for (const itemId of sortedIds) positives.push({ itemId, trueSubcat: subcat });
    }

    // Compute parentCentroid as mean-pooled vec over positives that have an embedding.
    const positiveVecs: number[][] = [];
    for (const pos of positives) {
      const v = vecById.get(pos.itemId);
      if (v) positiveVecs.push(v);
    }
    let parentCentroid: number[] | null = null;
    if (positiveVecs.length > 0) {
      const dim = positiveVecs[0].length;
      const sum = new Array<number>(dim).fill(0);
      for (const v of positiveVecs) {
        for (let i = 0; i < dim; i++) sum[i] += v[i];
      }
      parentCentroid = sum.map(s => s / positiveVecs.length);
    }

    const rawNegs = (negativesByParent.get(parent) ?? []).slice().sort();
    const negCap = Math.min(opts.maxNegativesPerParent, positives.length);
    const negatives: ScenarioNegative[] = rawNegs.slice(0, negCap).map(itemId => ({ itemId }));

    parents.push({ parent, subcategories, parentCentroid, positives, negatives });
  }

  parents.sort((a, b) => a.parent.localeCompare(b.parent));
  const totalPositives = parents.reduce((n, p) => n + p.positives.length, 0);
  const totalNegatives = parents.reduce((n, p) => n + p.negatives.length, 0);
  return {
    generatedAt: new Date().toISOString(),
    stats: { parentsIncluded: parents.length, totalPositives, totalNegatives },
    parents,
  };
}
