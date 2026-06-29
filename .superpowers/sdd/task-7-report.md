# Task 7 Report: Training mode feed controller wiring

## Status: DONE

## What was implemented

### `computeAdvance` pure helper (gallery-feed-mode.ts, module scope, exported)
Added at module scope. Takes `remainingIds: string[]` and `judgedIndex: number`, returns `string | null`. Clamps to last item when index exceeds length, returns null on empty queue.

### `GalleryFeedModeHost` interface extensions (gallery-feed-mode.ts)
Added two new required methods:
- `confirmAuto(roostId: string): Promise<void>`
- `rejectAuto(roostId: string): Promise<void>`

### `GalleryFeedModeController` new fields and methods (gallery-feed-mode.ts)
New fields: `trainingMode = false` (public), `private skipped`, `private lastActiveRoostId`, `private keydownHandler`, `private lastTrainingEntries` (tracks current feed state for judged-index lookup).

New public method `setTrainingMode(on: boolean)`: forces feed view when enabling; refreshes entries to training-filtered set; registers/deregisters keyboard; calls `host.onViewModeChanged()`.

New private methods: `trainingEntries()`, `advanceAfterAction(judgedId)`, `handleTrainingAction(action, roostId)`, `registerKeyboard()`, `deregisterKeyboard()`.

### `enterFeedMode()` modifications
- `FeedRenderContext` now includes `trainingMode: this.trainingMode` and `onTrainingAction` routing
- Initial entries: `trainingMode ? trainingEntries() : getScopedEntries()`
- `feedSync.subscribe` sets `lastActiveRoostId` (keyboard target)
- Registers keyboard if training mode is on at entry time

### `exitFeedMode()` modifications
Calls `deregisterKeyboard()` before teardown.

### `refreshEntries()` modifications
Uses `trainingMode ? trainingEntries() : getScopedEntries()` as entry source; keeps `lastTrainingEntries` in sync.

---

### `bookmarks-bases-view.ts` changes

#### New imports
```ts
import { confirmAutoItem, rejectAutoItem } from "@/pipeline/training-actions";
import { readGuess } from "@/views/feed/training-mode";
```

#### `confirmAuto` and `rejectAuto` host methods
Added before `openMoveModal`. Each resolves entry via `findEntryByRoostId`, resolves `TFile` via `app.vault.getFileByPath(entry.file.path)`, reads guessed category via `readGuess(entry).category`, no-ops if any is missing, calls the training-actions wrapper, wraps in try/catch → `console.warn`.

#### Training mode toggle in `buildToolbar()`
Added after `renderGalleryToolbar(...)` call (must be after since `renderGalleryToolbar` calls `toolbarEl.empty()`). Creates `div.roost-toolbar-mode > button.roost-mode-btn` (`.is-active` when `feedMode.trainingMode`), textContent "Train". Click: `feedMode.setTrainingMode(!feedMode.trainingMode)`.

---

## Test file created
`packages/core/src/views/__tests__/gallery-feed-training.test.ts` — 3 tests for `computeAdvance` (all pass).

## Results
- **Full suite**: 195 test files passed, 1 skipped; 1768 tests passed, 8 skipped — all green
- **`npx tsc --noEmit`**: clean
- **`npm run build`**: clean — 710 modules, `dist/main.js` built successfully

## No concerns
- Training mode off path is byte-for-byte unchanged
- Keyboard handler deregisters on `exitFeedMode` and `setTrainingMode(false)` — no leaks
- `lastTrainingEntries` cleanly handles judged-index lookup for both sync (skip) and async (confirm/reject) paths
