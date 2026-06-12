# Plan 012: Extract and unit-test the centroid-dedup merge in smart-assign discovery

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c55bf46..HEAD -- packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts`
> If the file changed since this plan was written, compare the excerpt below
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (behavior-preserving extraction of a self-contained block; the
  full suite is the regression guard)
- **Depends on**: none (disjoint from plan 011 — different module)
- **Category**: tests / tech-debt
- **Planned at**: commit `c55bf46`, 2026-06-10

## Why this matters

Smart Assign's category discovery merges near-duplicate proposed categories by
comparing their centroids — the audit flagged this exact block ("category
merging logic, step 2") as untested and a place a bug would silently mis-cluster
a user's whole library. The logic is currently **inline** inside the 230-line
`runClusteringStep2DiscoverAndScore`, which is otherwise LLM/embedder/vault
coupled and not cheaply testable. The merge logic itself, though, is **pure** —
it only needs embedding vectors and a threshold. Extracting it into a small pure
function makes it directly unit-testable (synthetic vectors, no mocks) and pins
the merge contract so future changes to discovery can't break it unnoticed.

## Current state

The inline block in `runClusteringStep2DiscoverAndScore`
(`packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts`,
lines 61–97 at `c55bf46`):

```ts
    if (discovered.length > 1) {
      const DEDUP_THRESHOLD = 0.90;
      type Entry = { d: typeof discovered[number]; centroid: number[] };
      const entries: Entry[] = [];
      for (const d of discovered) {
        const vecs = d.itemIds.map(id => ctx.cache[id]?.vec).filter((v): v is number[] => !!v);
        if (vecs.length === 0) { entries.push({ d, centroid: [] }); continue; }
        entries.push({ d, centroid: computeCentroid(vecs) });
      }
      entries.sort((a, b) => b.d.itemIds.length - a.d.itemIds.length);
      const merged = new Set<number>();
      const mergeLog: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        if (merged.has(i) || entries[i].centroid.length === 0) continue;
        for (let j = i + 1; j < entries.length; j++) {
          if (merged.has(j) || entries[j].centroid.length === 0) continue;
          const sim = cosineSimilarity(entries[i].centroid, entries[j].centroid);
          if (sim >= DEDUP_THRESHOLD) {
            const keeper = entries[i].d;
            const absorbed = entries[j].d;
            const before = keeper.itemIds.length;
            const seen = new Set(keeper.itemIds);
            for (const id of absorbed.itemIds) if (!seen.has(id)) keeper.itemIds.push(id);
            merged.add(j);
            mergeLog.push(
              `  merged ${absorbed.name} (${absorbed.itemIds.length}) → ${keeper.name} ` +
              `(${before}→${keeper.itemIds.length}, sim ${sim.toFixed(3)})`,
            );
          }
        }
      }
      if (merged.size > 0) {
        host.log(`\nCentroid dedup: merged ${merged.size} proposal(s) at cosine ≥${DEDUP_THRESHOLD}`);
        for (const line of mergeLog) host.log(line);
        discovered = entries.filter((_, i) => !merged.has(i)).map(e => e.d);
      }
    }
```

Facts:
- `computeCentroid` and `cosineSimilarity` are pure functions exported from
  `@/pipeline/shared` (imported at line 10). Reuse them — do NOT reimplement.
- `discovered` is `Array<{ name: string; itemIds: string[] }>` (the elements have
  at least those two fields; preserve any others via a generic).
- `ctx.cache` is `Record<string, EmbeddingCacheEntry>`; `EmbeddingCacheEntry.vec`
  is `number[] | null | undefined` (type from `@/types/roost`).
- Behavior to preserve EXACTLY: sort by `itemIds.length` desc; skip entries with
  no usable vectors; pairwise compare; on `sim >= 0.90`, the larger (keeper)
  absorbs the smaller's itemIds (de-duped), the smaller is dropped; the keeper's
  `itemIds` array is **mutated in place** (callers rely on identity); the log
  lines are emitted only when ≥1 merge happened.
- Test patterns to copy: `packages/core/src/pipeline/__tests__/blended-centroid.test.ts`
  and `evaluate-none.test.ts` use a `vec(value, dim=768)` helper to build
  deterministic embedding vectors. Vitest, no Obsidian needed for a pure function.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| This file's tests | `npx vitest run packages/core/src/ui/lib/smart-assign/__tests__/dedup-discovered.test.ts` | all pass |
| All tests | `npm test` | 955+ pass (baseline at `c55bf46`) |

## Scope

**In scope** (the only files you should create/modify):
- `packages/core/src/ui/lib/smart-assign/dedup-discovered.ts` (create)
- `packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts` (rewire the inline block to call the extracted function — no behavior change)
- `packages/core/src/ui/lib/smart-assign/__tests__/dedup-discovered.test.ts` (create)

**Out of scope** (do NOT touch):
- The rest of `clustering-step-2-discover.ts` (the LLM/embedder/vault flow) — only the lines-61–97 block changes.
- Any other smart-assign step file, `@/pipeline/shared`, `@/pipeline/evaluate`.
- `packages/core/src/sync/vault-writer.ts` — a different plan (011) is editing it; stay out of `sync/`.

## Git workflow

- Branch: `advisor/012-centroid-dedup`
- Commit style: `refactor(smart-assign): extract + unit-test centroid dedup of discovered categories`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Create the pure function

Create `packages/core/src/ui/lib/smart-assign/dedup-discovered.ts`:

```ts
import type { EmbeddingCacheEntry } from "@/types/roost";
import { computeCentroid, cosineSimilarity } from "@/pipeline/shared";

export const CENTROID_DEDUP_THRESHOLD = 0.90;

/**
 * Merge near-duplicate discovered categories by centroid similarity.
 * Larger categories absorb smaller ones whose centroid cosine-similarity is
 * >= threshold. Mutates the surviving entries' `itemIds` in place (callers rely
 * on identity) and returns the surviving subset plus a count + log lines.
 * Pure: depends only on the embedding vectors in `cache`.
 */
export function dedupDiscoveredByCentroid<T extends { name: string; itemIds: string[] }>(
  discovered: T[],
  cache: Record<string, EmbeddingCacheEntry>,
  threshold: number = CENTROID_DEDUP_THRESHOLD,
): { discovered: T[]; mergedCount: number; mergeLog: string[] } {
  if (discovered.length <= 1) return { discovered, mergedCount: 0, mergeLog: [] };
  // ... move the exact entries/sort/pairwise/merge logic here, verbatim ...
  // return { discovered: survivors, mergedCount: merged.size, mergeLog };
}
```

Move the lines-61–97 logic into the function body **verbatim** (same sort, same
`>= threshold`, same in-place `keeper.itemIds.push`, same mergeLog strings). When
`mergedCount === 0`, return the original `discovered` unchanged.

**Verify**: `npm run typecheck` → exit 0 (the new file compiles standalone)

### Step 2: Rewire the call site

In `clustering-step-2-discover.ts`, replace the entire `if (discovered.length > 1) { ... }`
block (lines 61–97) with a call to the extracted function, preserving the host
logging behavior:

```ts
    const dedup = dedupDiscoveredByCentroid(discovered, ctx.cache);
    if (dedup.mergedCount > 0) {
      host.log(`\nCentroid dedup: merged ${dedup.mergedCount} proposal(s) at cosine ≥${CENTROID_DEDUP_THRESHOLD}`);
      for (const line of dedup.mergeLog) host.log(line);
    }
    discovered = dedup.discovered;
```

Add the import: `import { dedupDiscoveredByCentroid, CENTROID_DEDUP_THRESHOLD } from "@/ui/lib/smart-assign/dedup-discovered";`
Remove the now-unused local `computeCentroid`/`cosineSimilarity` imports ONLY if
nothing else in the file uses them (grep first: `grep -n "computeCentroid\|cosineSimilarity" packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts` — `computeCohesion` is a different symbol; leave it).

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "DEDUP_THRESHOLD = 0.90" packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts` → no matches (logic moved out)

### Step 3: Unit tests

Create `packages/core/src/ui/lib/smart-assign/__tests__/dedup-discovered.test.ts`.
Use a `vec` helper (copy from `blended-centroid.test.ts`) and build cache
entries with controlled vectors so similarity is predictable (identical vectors
→ cosine 1.0 ≥ 0.90 → merge; orthogonal one-hot vectors → cosine 0 → no merge).
Cases:

1. **Merges two near-identical categories**: A (`itemIds:["a1","a2"]`) and B
   (`itemIds:["b1"]`), all cache vecs identical (e.g. `vec(1)`). →
   result `discovered.length === 1`, the survivor is the larger (A) and its
   `itemIds` contains `["a1","a2","b1"]`, `mergedCount === 1`.
2. **Does not merge dissimilar categories**: A vecs = one-hot dim0, B vecs =
   one-hot dim1 (cosine 0). → both survive, `mergedCount === 0`, itemIds untouched.
3. **Skips categories with no embeddings**: A has items present in cache, X has
   an itemId absent from cache (centroid empty). → X is never merged into / out;
   no crash; `mergedCount === 0` (or only legitimate merges among vec-having ones).
4. **Single category is a no-op**: `discovered.length === 1` → returns it
   unchanged, `mergedCount === 0`.
5. **Largest absorbs multiple**: A(size 3), B(size 2), C(size 1) all identical
   vecs → B and C merged into A; survivor `itemIds` length 6, `mergedCount === 2`.
6. **De-dups overlapping itemIds on merge**: keeper `["x","y"]`, absorbed
   `["y","z"]`, identical vecs → survivor itemIds `["x","y","z"]` (no duplicate `y`).

Assert on the returned `discovered` contents and `mergedCount` — real behavior,
not mocks.

**Verify**: `npx vitest run packages/core/src/ui/lib/smart-assign/__tests__/dedup-discovered.test.ts` → all pass (6)

### Step 4: Full suite (behavior preserved)

The extraction must not change end-to-end behavior — the existing suite is the
regression guard.

**Verify**: `npm test` → all pass (955+ plus the 6 new)

## Test plan

Covered by Step 3 — pure-function tests with synthetic vectors, no LLM/embedder
mocking needed. Pattern: `blended-centroid.test.ts`. The behavior-preservation of
the rewire (Step 2) is guarded by the full suite staying green.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; the 6 new dedup tests exist and pass
- [ ] `dedup-discovered.ts` exports `dedupDiscoveredByCentroid` + `CENTROID_DEDUP_THRESHOLD`
- [ ] `grep -n "DEDUP_THRESHOLD = 0.90" packages/core/src/ui/lib/smart-assign/clustering-step-2-discover.ts` → no matches (logic extracted)
- [ ] Only the 3 in-scope files changed (`git status`); nothing under `sync/`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The lines-61–97 excerpt doesn't match the live code (drift).
- Extracting the block changes the full suite's results (a test that passed now
  fails) — that means the rewire altered behavior; STOP, don't paper over it.
- The `discovered` element type can't be preserved through the generic without a
  cast that weakens types elsewhere — report what you see.

## Maintenance notes

- This is the cheap, high-value slice of the broader TESTS-03 finding (smart-assign
  clustering coverage). The heavier integration tests for steps 0/1/2 (which need
  a `SmartAssignClusteringHost` mock + `__setRequestUrlImpl` LLM stubbing) remain
  open backlog — scope them separately.
- Reviewer focus: confirm the extracted function's merge/sort/threshold logic is
  byte-for-byte equivalent to the original (especially the in-place `itemIds`
  mutation and the "larger absorbs smaller" direction), and that the full suite is
  still green (no behavior drift).
- Runs in parallel with plan 011 (VaultWriter) — disjoint files, no merge conflict.
