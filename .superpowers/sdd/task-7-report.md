# Task 7 Report — Per-item rejected-class suppression in the cascade

## Status: DONE

**Commit:** `1a9573e`

---

## TDD Red/Green

### Red (failing test output)
```
FAIL  packages/core/src/pipeline/__tests__/evaluate-suppression.test.ts
AssertionError: expected 'Tech' not to be 'Tech' // Object.is equality
```
`suppressedClasses` did not exist yet; centroid assigned Tech (nearest centroid, sim=1.0 >= CENTROID_REJECT_TAU).

### Green (passing)
```
Test Files  3 passed (3)
     Tests  8 passed (8)
```
After implementation: `x` is unmatched (Tech suppressed, Food has sim=0 < CENTROID_REJECT_TAU).

---

## Exact lines changed in evaluate.ts

### ScoreOpts interface (after `fullCanon?: boolean;`):
```ts
/** Per-item set of category names the cascade must not assign (rejected by the user).
 *  Applied at BOTH the head tier (if head picks a banned class, defer to centroid) and
 *  the centroid tier (banned centroids are excluded before picking the top candidate).
 *  Has no effect when undefined/absent — existing cascade behavior is fully preserved. */
suppressedClasses?: Map<string, Set<string>>;
```

### embeddingOnly cascade block — per-item loop, after vec guard (real local variable names):
```ts
const banned = opts.suppressedClasses?.get(id);
```

### Head tier suppression (after the stacked/head assignment blocks):
```ts
// Suppression — if head placed the item in a banned class, defer to centroid.
if (tier !== null && banned?.has(cat)) { tier = null; cat = ""; conf = 0; }
```

### Centroid tier suppression (after building `ranked`, before picking `ranked[0]`):
```ts
// Suppression — exclude banned classes before picking the top centroid candidate
// so a banned class is never the top pick and never appears in topCentroids.
if (banned) ranked = ranked.filter(c => !banned.has(c.name));
```
`ranked` is then used by the existing `ranked[0].sim >= CENTROID_REJECT_TAU` pick and by the `topCentroids` slice — both naturally see the filtered list.

---

## How head-tier AND centroid-tier suppression was confirmed

**Centroid-tier** (direct test): `evaluate-suppression.test.ts` — no `classifierHead` or `stackedHeads`, so `rawHead === null` and `rawStackedHeads === null`; item goes straight to centroid tier. Tech centroid is nearest (sim=1.0); suppression filter removes it from `ranked`; next candidate Food has sim=0 < CENTROID_REJECT_TAU -> item is unmatched.

**Head-tier** (structural confirmation): the suppression check `if (tier !== null && banned?.has(cat)) { tier = null; ... }` is inserted immediately after the stacked/head assignment blocks. If either head assigns a banned class, the check clears `tier` to `null`, which causes the `if (tier === null)` centroid block to run. The centroid block's filter then also applies. Cross-tier suppression is guaranteed by the two independent checks in sequence.

---

## TypeScript result

```
npx tsc --noEmit -p tsconfig.json
(no output — clean)
```

---

## Full pipeline test suite

```
Test Files  59 passed (59)
     Tests  690 passed (690)
Duration  2.70s
```

All pre-existing tests unchanged.

---

## Head-tier test (follow-up)

### Test code added to `packages/core/src/pipeline/__tests__/evaluate-suppression.test.ts`

```typescript
describe("scoreAgainstCategories suppression (head tier)", () => {
  beforeEach(() => __resetScoreCacheForTests());

  it("does not assign a suppressed class when the stacked head confidently predicts it; falls through to centroid fallback", async () => {
    // Stacked head with classes ["A","B","C"]: item vec at dim-0 fires "A" with
    // conf ≈ 1.0, well above HEAD_REJECT_TAU=0.6149.
    const stacked = mkStackedHeads(["A", "B", "C"]);

    // Item "x": unit vector at dim 0 → head emits "A" confidently.
    const cache: Record<string, EmbeddingCacheEntry> = {
      x: { vision: null, vec: [9, 0, 0, 0], vecText: [9, 0, 0, 0], summary: "s", category: null },
    };

    // Categories: "A" (same centroid direction as item) and "B" (fallback).
    // Both centroids align with item so after "A" is suppressed from ranked,
    // "B" remains at sim=1.0 ≥ CENTROID_REJECT_TAU=0.50 → centroid fallback.
    const cats: CategoryDef[] = [
      { name: "A", description: "", centroid: unit(0) },
      { name: "B", description: "", centroid: unit(0) },
    ];

    // Control: WITHOUT suppression → head tier fires and assigns "A".
    const resControl = await scoreAgainstCategories({
      itemIds: ["x"], cache, categories: cats,
      embeddingOnly: true, stackedHeads: stacked,
    });
    expect(resControl.assignments.get("x")).toBe("A");

    // WITH suppression: "A" is banned for item "x".
    // Head emits "A" → suppression drops it → centroid tier picks "B" → assigned "B".
    const res = await scoreAgainstCategories({
      itemIds: ["x"], cache, categories: cats,
      embeddingOnly: true, stackedHeads: stacked,
      suppressedClasses: new Map([["x", new Set(["A"])]]),
    });
    expect(res.assignments.get("x")).not.toBe("A");
    expect(res.assignments.get("x")).toBe("B");
    expect(res.unmatched).not.toContain("x");
  });
});
```

### Run output

```
Test Files  1 passed (1)
     Tests  2 passed (2)
Duration  274ms
```

Full pipeline suite:

```
Test Files  59 passed (59)
     Tests  691 passed (691)
Duration  2.55s
```

TypeScript: clean (`npx tsc --noEmit -p tsconfig.json` — no output).

### Production code changed

None. Only `packages/core/src/pipeline/__tests__/evaluate-suppression.test.ts` was modified.
