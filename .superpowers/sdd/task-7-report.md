# Task 7 Report — "Start review pass" control + thread humanAssignedRoostIds

Date: 2026-07-01

## What was built

### 1. "Start review pass" button (RoostView.tsx)

Added a "Review Pass" `Button` (variant `"secondary"`) in the staging footer, adjacent to "Confirm Categories". It appears when `mode === "staging" && pipelineStep === 5`, disabled while confirming. On click:

```ts
const ids = seedReviewIds(folders, (id) => smartAssign.matchDetailMap?.get(id)?.score);
plugin.fireItemClick({ action: "startReviewPass", itemIds: ids });
```

Proposal ids are ordered lowest-score-first via `seedReviewIds` from `review-pass.ts` (Task 1). Scores come from `matchDetailMap` (already available in the hook's return value).

### 2. Threading humanAssignedRoostIds end-to-end

**Architecture decision — class-field vs React state:**

The gallery view's `humanAssignedRoostIds` class field (already written by `reviewConfirm`/`reviewMove`/`reviewReject` in Task 6) is kept as the SINGLE authoritative Set. A parallel React state was NOT introduced. Instead, each of the three review methods now calls `this.syncHumanAssignedToPlugin()` immediately after mutating the Set — this assigns the SAME Set instance to `plugin.humanAssignedRoostIds`. The hook's `handleConfirm` then reads `plugin.humanAssignedRoostIds` at confirm time.

No second divergent Set is created. The gallery card handlers (`galleryCardHandlers()`) and the layout state (`applyLayoutState()` via `sinkGreenIndices`) already read `this.humanAssignedRoostIds` directly — these were already wired to the class field by Tasks 4 and 5.

**Wiring table:**
| Consumer | Source |
|---|---|
| Gallery card hydration (`hydrateGalleryCard`) | `this.humanAssignedRoostIds` (class field) — Task 4, unchanged |
| Gallery card sync (`syncKeptGalleryCard`) | `this.humanAssignedRoostIds` (passed to `syncGalleryCardFromEntry`) — new in Task 7 |
| Folder ordering (`sinkGreenIndices` in `applyLayoutState`) | `this.humanAssignedRoostIds` (class field) — Task 5, unchanged |
| `confirmSmartAssign` (via hook) | `plugin.humanAssignedRoostIds` (same Set instance, synced by `syncHumanAssignedToPlugin`) — new in Task 7 |

**The confirmSmartAssign wiring point (Task 3 guard now live):**

In `confirm.ts`, `SmartAssignConfirmHost` gained a new optional field `humanAssignedRoostIds?: Set<string>`. Inside `confirmSmartAssign`, both calls now pass it:

```ts
// buildItemCategory — excludes judged ids from the vault-write map
const itemCategory = buildItemCategory({ ..., humanAssigned: host.humanAssignedRoostIds });

// captureLoopUpdates — excludes judged ids from positives/negatives/eval
const { trainingSet, evalRecords } = captureLoopUpdates({
  ..., humanAssigned: host.humanAssignedRoostIds,
});
```

In `use-smart-assign.ts`, `handleConfirm` passes:
```ts
humanAssignedRoostIds: plugin.humanAssignedRoostIds ?? undefined,
```

### 3. startReviewPass event routing

Added `{ action: "startReviewPass"; itemIds: string[] }` to `ItemClickData` in `roost.d.ts`. This uses the existing `fireItemClick`/`onItemClick` pub-sub channel rather than a new plugin event — it is the established seam for React→gallery communication. In `bookmarks-bases-view.ts`'s `onload()`, a new `unsubItemClick` subscription handles the action:

```ts
this.unsubItemClick = plugin.onItemClick((data) => {
  if (data?.action === "startReviewPass") {
    // Set review ids FIRST so enterFeedMode sees them during trainingEntries()
    this.feedMode.startReviewPass(data.itemIds);
    this.feedMode.setTrainingMode(true);
  }
});
```

Order matters: `startReviewPass` sets `reviewPassIds` before `setTrainingMode(true)` calls `enterFeedMode()` → `trainingEntries()`. Cleaned up in `onunload()`.

### 4. Clear data-assigned on re-hydration (carry-forward from Task 4)

Added `humanAssignedRoostIds?: Set<string> | null` to `SyncGalleryCardOpts`. `syncGalleryCardFromEntry` now mirrors the `data-matched` clearing pattern:

```ts
if (opts?.humanAssignedRoostIds !== undefined) {
  const isHuman = opts.humanAssignedRoostIds?.has(roostId) ?? false;
  if (isHuman) el.dataset.assigned = "human";
  else delete el.dataset.assigned;
}
```

The `if (opts?.humanAssignedRoostIds !== undefined)` guard means: when the caller omits the option entirely (non-review-pass call sites), `data-assigned` is NOT cleared — no regression for existing code paths. `syncKeptGalleryCard` in the view now always passes `humanAssignedRoostIds: this.humanAssignedRoostIds` so recycled cards are corrected on every reconcile.

## TDD evidence RED→GREEN

### Tests added to `gallery-cards-sync.test.ts`

Three new test cases in the `syncGalleryCardFromEntry` describe block:
1. **Clears `data-assigned` when id NOT in set** — proves stale green ring removed on recycled element
2. **Keeps `data-assigned=human` when id IS in set** — proves re-hydration re-asserts the ring
3. **Leaves `data-assigned` untouched when `humanAssignedRoostIds` is not provided** — proves no regression for non-review-pass call sites

### Tests added to `confirm.test.ts`

New integration describe block `"confirmSmartAssign integration — humanAssigned exclusion end-to-end"`:
- Calls `buildItemCategory` + `captureLoopUpdates` together (mirroring exactly what `confirmSmartAssign` executes after wiring) with a `humanAssigned` set containing one judged id and one un-judged auto id.
- Verifies: judged id absent from `itemCategory` (no vault write), no positive/rejection/eval record for judged id.
- Verifies: un-judged auto id present in `itemCategory` (committed), eval record emitted for it.
- Proves Task 3's guard is now live: the same code paths that `confirmSmartAssign` delegates to now correctly exclude judged ids when `humanAssignedRoostIds` is passed.

## Gate results

```
npx tsc --noEmit              → 0 errors (exit 0, no output)
npx vitest run packages/core/src
  → Test Files  234 passed | 2 skipped (236)
  → Tests  1980 passed | 9 skipped (1989)
  → Duration  8.80s
```

## Files changed

- `packages/core/src/types/roost.d.ts` — added `startReviewPass` action to `ItemClickData`
- `packages/core/src/types/plugin.ts` — added `humanAssignedRoostIds: Set<string> | null` to `IRoostPlugin`
- `packages/core/src/main.ts` — initialized `humanAssignedRoostIds = null`
- `packages/core/src/views/gallery-cards.ts` — extended `SyncGalleryCardOpts`, added `data-assigned` clearing in `syncGalleryCardFromEntry`
- `packages/core/src/ui/lib/smart-assign/confirm.ts` — added `humanAssignedRoostIds` to `SmartAssignConfirmHost`, threaded into `buildItemCategory` + `captureLoopUpdates`
- `packages/core/src/views/bookmarks-bases-view.ts` — added `syncHumanAssignedToPlugin`, `unsubItemClick`, `onItemClick` subscription for `startReviewPass`, `syncKeptGalleryCard` passes `humanAssignedRoostIds`
- `packages/core/src/ui/hooks/use-smart-assign.ts` — passed `humanAssignedRoostIds` to `confirmSmartAssign`
- `packages/core/src/ui/components/RoostView.tsx` — added `seedReviewIds` import, "Review Pass" button
- `packages/core/src/views/__tests__/gallery-cards-sync.test.ts` — 3 new test cases for `data-assigned` clearing
- `packages/core/src/ui/lib/smart-assign/__tests__/confirm.test.ts` — 1 new integration test for combined pipeline with `humanAssigned`

## Manual smoke steps (for controller)

After `npm run build && npm run install:vault` and Obsidian restart:

1. **Run Smart Assign** on bookmarks with 5–10 items. Wait for staging (pipeline step 5, "Confirm Categories" visible).

2. **Click "Review Pass"** (secondary button, left of "Confirm Categories") — split pane opens, feed shows items ordered lowest-match-score-first (most uncertain first), "Train" button auto-activates.

3. **Judge items one by one:**
   - Press `Y` (confirm) → card in grid shows green ring (`data-assigned="human"`) and sinks to bottom of its group on next repaint.
   - Press `N` (reject) → same green ring + sink.
   - Click recategorize → fuzzy picker opens; after picking, green ring + sink.

4. **Verify training-set writes:** After each action, check the vault's training-set JSON. Confirmed/moved items have new positive entries; rejected items have rejection entries; all judged items have eval records.

5. **Click "Confirm Categories"** after judging some items:
   - The bulk-write log must NOT include judged ids (excluded by `buildItemCategory`'s `humanAssigned` guard).
   - Un-judged items DO get written with `roost_assigned_by: "auto"`.
   - Training-set: no double-capture for judged ids (`captureLoopUpdates` also guards them).

6. **Stale-green regression check:** Start a second Smart Assign run. Cards that were green from the previous pass should NOT show a green ring after reconcile (`syncGalleryCardFromEntry` clears `data-assigned` because `humanAssignedRoostIds` is null/empty for the new run).

## Carry-forward items addressed

1. ✅ Critical safety wiring (Task 3 guard now live) — `confirmSmartAssign` receives `humanAssignedRoostIds` via `SmartAssignConfirmHost` and passes it to both `buildItemCategory` and `captureLoopUpdates`.
2. ✅ `data-assigned` re-hydration clearing (Task 4 carry-forward) — `syncGalleryCardFromEntry` clears stale attribute; `syncKeptGalleryCard` always passes the set.
3. ✅ Single Set instance (Task 6 carry-forward) — view class field is authoritative; synced to `plugin.humanAssignedRoostIds` (same instance) by `syncHumanAssignedToPlugin`.
4. ✅ `startReviewPass(ids)` entry point (Task 6 carry-forward) — button seeds via `seedReviewIds(proposedFolders, scoreFrom(matchDetailMap))`, fires event, gallery view calls `feedMode.startReviewPass(ids)` then `feedMode.setTrainingMode(true)`.

## Concerns

None. Implementation is minimal and follows existing patterns exactly. The `feedMode` stays private; the `onItemClick` event channel is the established seam. `syncHumanAssignedToPlugin` is the only new coupling point — it assigns the same Set instance with no copying overhead.
