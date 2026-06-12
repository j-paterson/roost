# Plan 017: Decompose VaultWriter — Phase 3: Extract MediaDownloader

> **Executor instructions**: This is a SINGLE-PHASE plan. Read it fully before
> touching any file. Execute every step in order. Run every verification command
> and confirm the expected result before moving to the next step. If a STOP
> condition triggers, stop immediately and report — do NOT improvise a fix.
> When done, update `plans/README.md` status row.
>
> **Drift check (run first)**:
> `git diff --stat 7a82da2..HEAD -- packages/core/src/sync/vault-writer.ts`
> If `vault-writer.ts` changed since this plan was written (any output means
> a change), re-read the file and reconcile every line number in the method map
> below. On any change to `downloadAndSave`, `clearLegacyCarousel`, or
> `backfillWithOembed`, STOP and report before proceeding.
>
> **Base commit**: `main @ 7a82da2` (post-Phase-2, VaultIndex + NoteFileWriter already extracted)

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (stop-signal threading is the #1 risk; `tiktokWc` injection is a
  close second — confirm both via the detailed notes in Steps 1 and 2)
- **Depends on**: plan 015 (NoteFileWriter extracted — **MERGED in `main`**);
  plan 011 (VaultIndex extracted — **MERGED in `main`**); plan 006
  (characterization tests — **MERGED in `main`**)
- **Category**: tech-debt / architecture
- **Planned at**: commit `7a82da2`, 2026-06-10

## Why this matters

After Phase 2, `VaultWriter` is ~890 lines. `VaultIndex` and `NoteFileWriter`
are clean collaborators. The three remaining media methods (`downloadAndSave`,
`clearLegacyCarousel`, `backfillWithOembed`) are the next coherent group: they
own all binary-download logic, all legacy-file cleanup, and the TikTok oEmbed
backfill command — concerns the platform writers and resync should not reach
into directly. Extracting a `MediaDownloader` collaborator reduces the class by
~100 lines, isolates the download surface for targeted testing, and unblocks
Phase 4 (platform writers) where `downloadAndSave` callers will eventually move
to their own collaborator.

## Current state — method map (verified against `main @ 7a82da2`)

### Methods being moved into MediaDownloader

| Method | Lines | Vis | Notes |
|---|---|---|---|
| `clearLegacyCarousel` | 208–217 | private | Deletes legacy numbered images + card.png from an attach folder |
| `downloadAndSave` | 219–247 | private | Core download-and-persist helper; checks `currentStopSignal`, calls `ensureFolder` + `vault.createBinary` |
| `backfillWithOembed` | 818–891 | **PUBLIC** | TikTok oEmbed enrichment; has its OWN local `stopSignal` param (not `currentStopSignal`) |

**Current source excerpts (verbatim from `main @ 7a82da2`):**

**`clearLegacyCarousel`** (lines 208–217):
```typescript
  private async clearLegacyCarousel(attachFolder: string): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(attachFolder);
    if (!(folder instanceof TFolder)) return;
    const victims = folder.children.filter(c =>
      c instanceof TFile && (/^\d+\.(jpg|png)$/.test(c.name) || c.name === "card.png")
    );
    for (const v of victims) {
      try { await this.vault.delete(v); } catch { /* ignore */ }
    }
  }
```

**`downloadAndSave`** (lines 219–247):
```typescript
  private async downloadAndSave(
    downloadFn: () => Promise<ArrayBuffer | null>,
    attachFolder: string,
    filename: string,
    skipIfExists = false,
  ): Promise<string | null> {
    const destPath = `${attachFolder}/${filename}`;
    if (skipIfExists && this.vault.getAbstractFileByPath(destPath)) {
      return `![[${destPath}]]`;
    }
    if (this.currentStopSignal?.stopped) return null;
    const t0 = Date.now();
    const data = await downloadFn();
    const dlMs = Date.now() - t0;
    if (!data) {
      if (dlMs > 5000) this.log(`[timeout?] ${filename} download returned null after ${(dlMs / 1000).toFixed(1)}s`);
      return null;
    }
    if (dlMs > 5000) {
      const sizeMB = (data.byteLength / 1024 / 1024).toFixed(1);
      this.log(`[slow] ${filename} download: ${(dlMs / 1000).toFixed(1)}s (${sizeMB} MB)`);
    }
    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    if (this.vault.getAbstractFileByPath(destPath)) {
      return `![[${destPath}]]`;
    }
    await this.vault.createBinary(destPath, data);
    return `![[${destPath}]]`;
  }
```

**`backfillWithOembed`** (lines 818–891):
```typescript
  async backfillWithOembed(
    incompleteIds: Set<string>,
    stopSignal?: { stopped: boolean },
  ): Promise<{ attempted: number; success: number; failed: number }> {
    // ... uses: stopSignal?.stopped (LOCAL param, not currentStopSignal),
    //           this.index.notePathMap.get(roostId),
    //           this.vault.getAbstractFileByPath / this.vault.read / this.vault.modify,
    //           ensureFolder(this.vault, attachFolder, this.ensuredFolders),
    //           this.noteWriter.writeSidecar(...),
    //           fetchTikTokOembed, buildOembedRawJson,
    //           noteDirPath, parseFrontmatterEntries, updateNoteFrontmatter
    ...
  }
```

### Critical design question: `currentStopSignal`

`downloadAndSave` at line 229 checks `this.currentStopSignal?.stopped`.
`currentStopSignal` is set by `writeBatch` at line 154:
```typescript
this.currentStopSignal = stopSignal || null;
```

`backfillWithOembed` does NOT use `currentStopSignal` — it receives its own
`stopSignal` parameter and checks `stopSignal?.stopped` directly (line 829).

After extraction, `MediaDownloader.downloadAndSave` must still see the CURRENT
stop signal so a download aborts when the user stops a sync mid-batch.

**Chosen mechanism: `setStopSignal(signal)` method on MediaDownloader.**

`MediaDownloader` holds a private field `private stopSignal: { stopped: boolean } | null = null`.
`VaultWriter.writeBatch` calls `this.mediaDownloader.setStopSignal(stopSignal || null)`
immediately after `this.currentStopSignal = stopSignal || null` at line 154
(or can REPLACE the VaultWriter-side assignment entirely since nothing else on
VaultWriter reads `currentStopSignal` after extraction).

This is a push-model: VaultWriter explicitly synchronizes the signal to
MediaDownloader at the same point it sets its own copy. It is minimal (one
extra call), makes the data-flow explicit in writeBatch, and requires no shared
mutable reference. It is also more testable than injecting a ref-holder.

**Exact change in VaultWriter.writeBatch** (line 154 area):
```typescript
// BEFORE:
this.currentStopSignal = stopSignal || null;

// AFTER:
this.currentStopSignal = stopSignal || null;
this.mediaDownloader.setStopSignal(this.currentStopSignal);
```

`VaultWriter.currentStopSignal` can be removed once no other method on
VaultWriter reads it. Verify with:
```bash
grep -n "currentStopSignal" packages/core/src/sync/vault-writer.ts
```
After extraction, it appears only in writeBatch (line 154) and writeBatch's
break check (line 157: `if (stopSignal?.stopped) break;` — this uses the LOCAL
`stopSignal` parameter, NOT `this.currentStopSignal`). So `this.currentStopSignal`
is safe to remove from VaultWriter entirely, leaving only the `setStopSignal` call.

This is the **#1 review focus** — see STOP conditions.

### `backfillWithOembed` dependency audit

`backfillWithOembed` uses the following, which must all be injected or available:

| Dependency | Source | Injection |
|---|---|---|
| `this.index.notePathMap.get(roostId)` | VaultIndex | inject `index: VaultIndex` |
| `this.vault.getAbstractFileByPath(...)` | Vault | inject `vault: Vault` |
| `this.vault.read(noteFile)` | Vault | same |
| `this.vault.modify(noteFile, updated)` | Vault | same |
| `ensureFolder(this.vault, attachFolder, this.ensuredFolders)` | vault-helpers | inject `ensuredFolders: Set<string>` |
| `this.noteWriter.writeSidecar(...)` | NoteFileWriter | inject `noteWriter: NoteFileWriter` |
| `this.log(...)` | log fn | inject `log: (msg: string) => void` |
| `noteDirPath(...)` | top-level fn in vault-writer.ts | MOVE verbatim to media-downloader.ts |
| `parseFrontmatterEntries(...)` | `@/lib/vault-helpers` | import in media-downloader.ts |
| `updateNoteFrontmatter(...)` | `@/lib/vault-helpers` | import in media-downloader.ts |
| `fetchTikTokOembed, buildOembedRawJson` | `./oembed-fallback` | import in media-downloader.ts |
| `buildTikTokVideoUrl` | `../lib/extract` | import in media-downloader.ts |

**`tiktokWc`**: `downloadAndSave` itself does NOT reference `tiktokWc`. The
webview is passed as the closure argument (e.g., `() => downloadTikTokVideo(wc, ...)`)
by the caller — `writeTikTokRecord` and `resyncRecord` close over `this.tiktokWc`
before the call. `clearLegacyCarousel` does not use `tiktokWc`.
`backfillWithOembed` does not use `tiktokWc`. Therefore **MediaDownloader does
NOT need `tiktokWc` injected** — the callers that stay on VaultWriter continue
to supply it via closure. No injection required.

### Caller map — methods that STAY on VaultWriter but call the 3 moving methods

Every call site below must be rewired to `this.mediaDownloader.<method>(...)`.

| Caller (stays on VaultWriter) | Calls (moves to MediaDownloader) | Line(s) |
|---|---|---|
| `writeTwitterRecord` | `this.downloadAndSave(...)` | 281, 287, 291, 295, 299, 310 |
| `renderThreadPages` | `this.downloadAndSave(...)` | 401, 426, 453, 471 |
| `writeTikTokRecord` | `this.downloadAndSave(...)` | 533, 541, 544, 551 |
| `resyncRecord` (tiktok branch) | `this.downloadAndSave(...)` | 641, 646, 649 |
| `resyncRecord` (twitter branch) | `this.downloadAndSave(...)` | 719, 723, 725, 729, 741 |
| `resyncRecord` (twitter branch) | `this.clearLegacyCarousel(...)` | 707 |

Total call-site rewires: 17 `downloadAndSave` calls + 1 `clearLegacyCarousel` call = **18 sites**.

`backfillWithOembed` is PUBLIC — keep a delegating wrapper on VaultWriter (same
pattern as `rewriteNoteBody` and `stampEnrichmentVersion`).

### Methods staying on VaultWriter (NOT moved)

`constructor`, `getExistingIds`, `hydrateThreadFromCache`, `writeBatch`,
`writeTwitterRecord`, `renderThreadPages`, `writeTikTokRecord`,
`rewriteNoteBody` (delegation wrapper), `stampEnrichmentVersion` (delegation wrapper),
`resyncRecord`, `scanIncompleteIds`

Private fields staying: `vault`, `syncFolder`, `tiktokWc`, `log`, `index`,
`noteWriter`, `ensuredFolders`, `cumulative`

`currentStopSignal` is removed from VaultWriter after extraction (replaced by
the push via `this.mediaDownloader.setStopSignal(...)`).

### Top-level helpers that move with MediaDownloader

`noteDirPath` (lines 44–46) — used ONLY by `backfillWithOembed`. Move verbatim
into `media-downloader.ts` as a module-private function. Remove from `vault-writer.ts`.

No other top-level helpers are exclusively used by the 3 moving methods.

## Target architecture

`MediaDownloader` is a new class in
`packages/core/src/sync/vault-writer/media-downloader.ts`. It owns the 3 methods
above plus `stopSignal` state. It is constructed by `VaultWriter` and accessed via
`this.mediaDownloader`.

**IMPORTANT**: There is already a file `packages/core/src/sync/media-downloader.ts`
(the existing low-level download functions: `downloadTwitterImage`,
`downloadTwitterVideo`, `downloadTikTokVideo`, etc.). The new class lives at a
DIFFERENT path: `packages/core/src/sync/vault-writer/media-downloader.ts`. The
existing `./media-downloader` module is unchanged and is imported BY the new class
(the class calls those functions internally just as VaultWriter did). Do NOT rename
or touch the existing module.

### Constructor interface

```typescript
interface MediaDownloaderOpts {
  vault: Vault;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  ensuredFolders: Set<string>;
}
```

### Class structure

```typescript
export class MediaDownloader {
  private vault: Vault;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private ensuredFolders: Set<string>;
  private stopSignal: { stopped: boolean } | null = null;

  constructor(opts: MediaDownloaderOpts) { ... }

  setStopSignal(signal: { stopped: boolean } | null): void {
    this.stopSignal = signal;
  }

  async clearLegacyCarousel(attachFolder: string): Promise<void> { ... }

  async downloadAndSave(
    downloadFn: () => Promise<ArrayBuffer | null>,
    attachFolder: string,
    filename: string,
    skipIfExists?: boolean,
  ): Promise<string | null> { ... }

  async backfillWithOembed(
    incompleteIds: Set<string>,
    stopSignal?: { stopped: boolean },
  ): Promise<{ attempted: number; success: number; failed: number }> { ... }
}
```

**In `downloadAndSave`**: replace `this.currentStopSignal?.stopped` with
`this.stopSignal?.stopped`. All other logic verbatim.

**In `backfillWithOembed`**:
- `noteDirPath(...)` is now a module-level fn in this file (moved from vault-writer.ts)
- `this.index.notePathMap.get(roostId)` → `this.index.notePathMap.get(roostId)`
- `this.noteWriter.writeSidecar(...)` → `this.noteWriter.writeSidecar(...)`
- `ensureFolder(this.vault, attachFolder, this.ensuredFolders)` → same shape
- `this.vault.read / modify / getAbstractFileByPath` → same shape
- `this.log(...)` → `this.log(...)`

### Shared state: ensuredFolders

Same injection model as NoteFileWriter. VaultWriter OWNS `ensuredFolders` and
injects it into both `NoteFileWriter` and `MediaDownloader`. All three
collaborators mutate the same Set — folder-creation deduplication works across
all of them within a single `writeBatch`.

### Public API preservation

`VaultWriter.backfillWithOembed` signature is unchanged — the public wrapper
delegates verbatim:
```typescript
async backfillWithOembed(
  incompleteIds: Set<string>,
  stopSignal?: { stopped: boolean },
): Promise<{ attempted: number; success: number; failed: number }> {
  return this.mediaDownloader.backfillWithOembed(incompleteIds, stopSignal);
}
```

The 5 external construction sites are unchanged. The 8 public methods are
unchanged. `VaultWriterOpts` is unchanged.

## Scope

**In scope** (only these 3 files may be created or modified):
1. `packages/core/src/sync/vault-writer/media-downloader.ts` — CREATE
2. `packages/core/src/sync/vault-writer.ts` — MODIFY (wire delegation, remove
   moved methods, add `setStopSignal` call in `writeBatch`, remove
   `currentStopSignal` field)
3. `packages/core/src/sync/__tests__/media-downloader.test.ts` — CREATE

**Out of scope** (do NOT touch):
- `packages/core/src/sync/media-downloader.ts` — the existing low-level download
  functions module; leave untouched
- Any platform writer, note writer, index, or resync method beyond the delegation
  rewiring described above
- The public method signatures of `VaultWriter`, `VaultWriterOpts`,
  `backfillWithOembed`, `IncompleteByCategory`, `IncompleteIdsResult`
- The 5 external construction sites
- Any file outside `packages/core/src/sync/`
- `packages/core/src/sync/__tests__/vault-writer.test.ts` (006's tests — must
  remain byte-unchanged)
- `packages/core/src/sync/__tests__/note-file-writer.test.ts` (Phase 2 tests —
  must remain byte-unchanged)
- Phases 4–5

## Steps

### Step 1: Create MediaDownloader

Create `packages/core/src/sync/vault-writer/media-downloader.ts`.

**Imports the file will need:**

```typescript
import { Vault, TFile, TFolder } from "obsidian";
import { ensureFolder, parseFrontmatterEntries, updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { buildTikTokVideoUrl } from "../../lib/extract";
import { fetchTikTokOembed, buildOembedRawJson } from "../oembed-fallback";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter } from "./note-file-writer";
```

**Module-level helper to move verbatim from vault-writer.ts (lines 44–46):**

```typescript
function noteDirPath(filePath: string): string {
  return filePath.replace(/\/[^/]+\.md$/, "");
}
```

**Constructor interface:**

```typescript
interface MediaDownloaderOpts {
  vault: Vault;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  ensuredFolders: Set<string>;
}
```

**Class fields and constructor:**

```typescript
export class MediaDownloader {
  private vault: Vault;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private ensuredFolders: Set<string>;
  private stopSignal: { stopped: boolean } | null = null;

  constructor(opts: MediaDownloaderOpts) {
    this.vault = opts.vault;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.ensuredFolders = opts.ensuredFolders;
  }

  setStopSignal(signal: { stopped: boolean } | null): void {
    this.stopSignal = signal;
  }
  ...
}
```

**Move methods verbatim**, with only these mechanical substitutions:

| Old reference | New reference |
|---|---|
| `this.currentStopSignal?.stopped` | `this.stopSignal?.stopped` |
| `this.vault.*` | `this.vault.*` (unchanged) |
| `this.log(...)` | `this.log(...)` (unchanged) |
| `ensureFolder(this.vault, ..., this.ensuredFolders)` | same shape |
| `this.index.notePathMap.get(...)` | same shape |
| `this.noteWriter.writeSidecar(...)` | same shape |

Do NOT refactor, rename variables, or change any logic.

**Verify (typecheck only — VaultWriter will still fail until Step 2):**
```bash
npx tsc --noEmit 2>&1 | grep "media-downloader" | head -20
# Expected: errors only in vault-writer.ts (method moved), not in the new file
```

### Step 2: Wire VaultWriter to use MediaDownloader

In `packages/core/src/sync/vault-writer.ts`:

**a) Add import:**
```typescript
import { MediaDownloader } from "./vault-writer/media-downloader";
```

**b) Remove the existing `./media-downloader` import** (lines 19–23) from
vault-writer.ts — the new `MediaDownloader` class file already imports those
functions, so vault-writer.ts no longer needs them directly. **Exception**: if
`loadQuotedTweetBitmap` (lines 48–57) still calls `downloadTwitterImage` from
`./media-downloader`, keep that import. Confirm:
```bash
git show main:packages/core/src/sync/vault-writer.ts | grep -n "loadQuotedTweetBitmap\|downloadTwitterImage\|downloadTwitterVideo\|downloadTikTokVideo\|downloadTikTokImage\|downloadTikTokSubtitle"
```
`loadQuotedTweetBitmap` at lines 48–57 calls `downloadTwitterImage`. The actual
download calls in `writeTwitterRecord`, `writeTikTokRecord`, `resyncRecord`, and
`renderThreadPages` are passed as closures INTO `this.downloadAndSave(...)` and
will now be passed into `this.mediaDownloader.downloadAndSave(...)`. So those
callers still need to call `downloadTwitterImage(url)` etc. as the closure argument.

Therefore the `./media-downloader` import in vault-writer.ts MUST be kept (for
`loadQuotedTweetBitmap` + for the closure arguments). No change to that import.

**c) Add `mediaDownloader` field:**
```typescript
private mediaDownloader: MediaDownloader;
```

**d) Construct in constructor** (after `this.noteWriter = new NoteFileWriter({...})`):
```typescript
this.mediaDownloader = new MediaDownloader({
  vault: opts.vault,
  log: this.log,
  index: this.index,
  noteWriter: this.noteWriter,
  ensuredFolders: this.ensuredFolders,
});
```

**e) Update `writeBatch`** — add the `setStopSignal` call immediately after
line 154 (`this.currentStopSignal = stopSignal || null`):
```typescript
this.currentStopSignal = stopSignal || null;
this.mediaDownloader.setStopSignal(this.currentStopSignal);
```

After confirming `currentStopSignal` is used nowhere else on VaultWriter
(it is not — `writeBatch` line 157 uses the LOCAL `stopSignal` parameter,
and `downloadAndSave` no longer lives here), remove the
`private currentStopSignal: { stopped: boolean } | null = null;` field
declaration and the `this.currentStopSignal = ...` assignment from writeBatch.
The setStopSignal call becomes:
```typescript
this.mediaDownloader.setStopSignal(stopSignal || null);
```

This is a safe simplification — confirm by grepping after removing:
```bash
grep -n "currentStopSignal" packages/core/src/sync/vault-writer.ts
# Expected: 0 matches (field and assignment gone)
```

**f) Delete the 3 moved methods** from vault-writer.ts:
- `private async clearLegacyCarousel` (lines 208–217)
- `private async downloadAndSave` (lines 219–247)
- `async backfillWithOembed` (lines 818–891)

**g) Add public delegation wrapper for `backfillWithOembed`:**
```typescript
async backfillWithOembed(
  incompleteIds: Set<string>,
  stopSignal?: { stopped: boolean },
): Promise<{ attempted: number; success: number; failed: number }> {
  return this.mediaDownloader.backfillWithOembed(incompleteIds, stopSignal);
}
```

**h) Remove `noteDirPath` from vault-writer.ts** (lines 44–46) — it moved to
media-downloader.ts. Verify it is not referenced anywhere else in vault-writer.ts:
```bash
grep -n "noteDirPath" packages/core/src/sync/vault-writer.ts
# Expected: 0 matches after removal
```

**i) Rewire the 18 internal call sites** in `writeTwitterRecord`,
`renderThreadPages`, `writeTikTokRecord`, and `resyncRecord`:

For each occurrence in the caller map from "Current state" above:
- `this.downloadAndSave(...)` → `this.mediaDownloader.downloadAndSave(...)`
- `this.clearLegacyCarousel(...)` → `this.mediaDownloader.clearLegacyCarousel(...)`

The `this.backfillWithOembed(...)` call (if any internal call exists) is handled
by the public delegation wrapper — verify there are no internal self-calls.

**Verify:**
```bash
npm run typecheck
# Expected: exit 0
```

### Step 3: Verify public API is unchanged

Run these grep checks — each must return the expected result:

```bash
# Public delegation wrapper present:
grep -n "async backfillWithOembed" packages/core/src/sync/vault-writer.ts
# Expected: 1 match (the delegation wrapper)

# Moved private methods are gone from vault-writer.ts:
grep -cn "private async clearLegacyCarousel\|private async downloadAndSave" \
  packages/core/src/sync/vault-writer.ts
# Expected: 0

# currentStopSignal is gone from vault-writer.ts:
grep -cn "currentStopSignal" packages/core/src/sync/vault-writer.ts
# Expected: 0

# MediaDownloader class exists in the new file:
grep -n "export class MediaDownloader" \
  packages/core/src/sync/vault-writer/media-downloader.ts
# Expected: 1 match

# noteDirPath moved to media-downloader.ts, gone from vault-writer.ts:
grep -cn "noteDirPath" packages/core/src/sync/vault-writer.ts
# Expected: 0
grep -n "function noteDirPath" \
  packages/core/src/sync/vault-writer/media-downloader.ts
# Expected: 1 match

# setStopSignal exposed on MediaDownloader:
grep -n "setStopSignal" packages/core/src/sync/vault-writer/media-downloader.ts
# Expected: 1 match (the method declaration)

# 5 external construction sites unchanged — none reference MediaDownloader directly:
grep -rn "new VaultWriter" packages/core/src
# Expected: same 5 sites, all using VaultWriterOpts (no new params)
```

### Step 4: Add unit tests for MediaDownloader

Create `packages/core/src/sync/__tests__/media-downloader.test.ts`.

Use the `makeFakeVault()` helper from `./fake-vault`. Extend it with a
`createBinary` method for this test file:

```typescript
// Extend fake vault with binary support for MediaDownloader tests
function makeFakeVaultWithBinary() {
  const base = makeFakeVault();
  const binaryFiles = new Map<string, ArrayBuffer>();
  const vaultWithBinary = Object.assign(base.vault, {
    createBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      binaryFiles.set(path, data);
      base.files.set(path, `[binary: ${path}]`); // marker so getAbstractFileByPath works
    },
    delete: async (_file: unknown): Promise<void> => { /* no-op in tests */ },
  });
  return { ...base, vault: vaultWithBinary, binaryFiles };
}
```

**Construct MediaDownloader directly** (not through VaultWriter) with:
- A minimal inline `VaultIndex` stub (same pattern as note-file-writer.test.ts):
  ```typescript
  const fakeIndex = { notePathMap: new Map<string, unknown>() } as unknown as VaultIndex;
  ```
- A minimal inline `NoteFileWriter` stub:
  ```typescript
  const sidecarCalls: Array<[string, string]> = [];
  const fakeNoteWriter = {
    writeSidecar: async (path: string, content: string) => { sidecarCalls.push([path, content]); },
  } as unknown as NoteFileWriter;
  ```

**Test cases to include:**

1. **`downloadAndSave` skip-if-exists** — Seed the fake vault with a file at
   `attachFolder/1.jpg`. Call `downloadAndSave` with `skipIfExists = true`. Assert:
   - Returns `![[attachFolder/1.jpg]]` immediately
   - The `downloadFn` closure was never called (use a `vi.fn()` that would throw
     if called)

2. **`downloadAndSave` stop-signal abort** — Call `setStopSignal({ stopped: true })`
   on the MediaDownloader, then call `downloadAndSave`. Assert:
   - Returns `null` immediately
   - The `downloadFn` closure was never called

3. **`downloadAndSave` downloads and saves** — Call with `stopSignal = null` and
   a `downloadFn` that returns a non-null `ArrayBuffer`. Assert:
   - Returns an `![[...]]` embed string
   - `createBinary` was called (binaryFiles map has the path)

4. **`downloadAndSave` returns null on null download** — `downloadFn` returns
   `null`. Assert: returns `null`; no `createBinary` call.

5. **`clearLegacyCarousel` no-op on missing folder** — Call with a path that
   has no folder in the vault. Assert: no error thrown.

**Verify:**
```bash
npx vitest run packages/core/src/sync/__tests__/media-downloader.test.ts
# Expected: all pass
```

### Step 5: Confirm 006's and Phase 2's characterization tests unchanged

```bash
npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts
# Expected: all pass — same behavior, delegation is transparent

npx vitest run packages/core/src/sync/__tests__/note-file-writer.test.ts
# Expected: all pass — unmodified
```

### Step 6: Full suite

```bash
npm test
# Expected: all 937+ tests pass (baseline 929 passed | 8 skipped = 937 total,
# plus new media-downloader tests)
```

## Done criteria

ALL must hold before the plan is marked complete:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; new `media-downloader.test.ts` exists and passes; suite
  total >= 937 (baseline) + new tests
- [ ] `packages/core/src/sync/__tests__/vault-writer.test.ts` byte-unchanged:
  `git diff HEAD -- packages/core/src/sync/__tests__/vault-writer.test.ts` → empty
- [ ] `packages/core/src/sync/__tests__/note-file-writer.test.ts` byte-unchanged:
  `git diff HEAD -- packages/core/src/sync/__tests__/note-file-writer.test.ts` → empty
- [ ] `MediaDownloader` class exported from `vault-writer/media-downloader.ts`:
  `grep -c "export class MediaDownloader" packages/core/src/sync/vault-writer/media-downloader.ts` → 1
- [ ] Moved private methods absent from vault-writer.ts:
  `grep -c "private async clearLegacyCarousel\|private async downloadAndSave" packages/core/src/sync/vault-writer.ts` → 0
- [ ] `currentStopSignal` removed from vault-writer.ts:
  `grep -c "currentStopSignal" packages/core/src/sync/vault-writer.ts` → 0
- [ ] `noteDirPath` removed from vault-writer.ts:
  `grep -c "noteDirPath" packages/core/src/sync/vault-writer.ts` → 0
- [ ] Public delegation wrapper present on VaultWriter with unchanged signature:
  `grep -c "async backfillWithOembed" packages/core/src/sync/vault-writer.ts` → 1
- [ ] 5 external construction sites unchanged — `VaultWriterOpts` interface unchanged:
  `git diff HEAD -- packages/core/src/sync/vault-writer.ts | grep "VaultWriterOpts"` → 0 changes to the interface
- [ ] Existing `packages/core/src/sync/media-downloader.ts` (the low-level download
  functions module) unchanged:
  `git diff HEAD -- packages/core/src/sync/media-downloader.ts` → empty
- [ ] `git diff --name-only 7a82da2..HEAD` lists ONLY the 3 in-scope files:
  `vault-writer.ts`, `vault-writer/media-downloader.ts`, `__tests__/media-downloader.test.ts`
  (plus `plans/README.md` status update)
- [ ] `plans/README.md` status row updated; Phase 4 noted as next

## STOP conditions

Stop and report (do NOT improvise) if:

- The drift check shows `vault-writer.ts` was modified since `7a82da2` in a way
  that changes any of the in-scope method bodies or signatures — re-read and
  reconcile line numbers before touching anything.
- `grep -n "currentStopSignal" packages/core/src/sync/vault-writer.ts` after
  Step 2(e) shows any remaining references outside the line you just removed —
  meaning something else reads it that this plan didn't account for.
- `backfillWithOembed` calls any `this.xxx` not listed in the dependency table
  above — report the unknown dependency before moving the method.
- `noteDirPath` is used by anything other than `backfillWithOembed` in
  vault-writer.ts: `grep -n "noteDirPath" packages/core/src/sync/vault-writer.ts`
  must show only the function declaration and the one call site in
  `backfillWithOembed`.
- 006's characterization tests fail at any step — that means delegation altered
  observable behavior; STOP, do not modify the test to match.
- The typecheck introduces new errors outside the 3 in-scope files.
- The existing `packages/core/src/sync/media-downloader.ts` (low-level module)
  is accidentally modified or broken.
- `downloadAndSave` in the extracted class references `this.tiktokWc` — it must
  NOT; the webview is always passed via closure by the caller.

## Test plan

| What | How | Expected |
|---|---|---|
| MediaDownloader: skip-if-exists | media-downloader.test.ts test 1 | returns embed string, downloadFn not called |
| MediaDownloader: stop-signal abort | media-downloader.test.ts test 2 | returns null, downloadFn not called |
| MediaDownloader: download + save | media-downloader.test.ts test 3 | createBinary called, embed returned |
| MediaDownloader: null download | media-downloader.test.ts test 4 | returns null, no createBinary |
| MediaDownloader: clearLegacyCarousel no-op | media-downloader.test.ts test 5 | no error |
| VaultWriter public API unchanged | vault-writer.test.ts (006's tests, UNCHANGED) | all pass |
| NoteFileWriter tests unchanged | note-file-writer.test.ts (Phase 2, UNCHANGED) | all pass |
| TypeCheck | `npm run typecheck` | exit 0 |
| Full suite | `npm test` | 937+ pass |

## Git workflow

- Branch: `refactor/017-vaultwriter-mediadownloader`
- Commit style: `refactor(sync): extract MediaDownloader from VaultWriter (decomposition phase 3)`
- Do NOT push or open a PR unless instructed.

## Open questions for reviewer / follow-up

- Phase 4 (`TwitterRecordWriter` + `TikTokRecordWriter`) is gated on
  characterization tests for the twitter/tiktok write paths (network/`requestUrl`
  stubbed via the obsidian mock's `__setRequestUrlImpl`). These tests do not exist
  yet. Before writing plan 018, add them in a separate plan or step. See plan 011's
  maintenance notes.
- `renderThreadPages` is a private method that stays on VaultWriter and calls
  `this.mediaDownloader.downloadAndSave(...)` 4 times. It may become a candidate
  for `TwitterRecordWriter` in Phase 4.
- `backfillWithOembed` calls `this.noteWriter.writeSidecar(...)` — it has a
  cross-collaborator dependency. Consider in Phase 4 whether a direct vault write
  (without NoteFileWriter) is more appropriate, or whether the dependency is
  acceptable.

## Maintenance notes

This is decomposition **Phase 3 of 5**. After it lands:

- Phase 4 = extract `TwitterRecordWriter` + `TikTokRecordWriter` — plan 018.
  MUST be preceded by characterization tests for the twitter/tiktok write paths
  (network-stubbed via `__setRequestUrlImpl`). Those tests must cover at minimum:
  `writeTwitterRecord` (photo, video, card paths) and `writeTikTokRecord` (image
  carousel, video). Without them, plan 018 is HIGH risk. Do not proceed to plan 018
  until those tests are green.
- Phase 5 = extract `ResyncRunner` (eliminate the ~80% duplication in
  `resyncRecord`) — plan 019.
- Reviewer focus: the `setStopSignal` call in `writeBatch` is the highest-risk
  behavioral change. Verify that after extraction, a stop signal sent mid-batch
  still causes `downloadAndSave` to return null (not download) on the next call.
  The 006 characterization tests cover `stopSignal` at the `writeBatch` level
  (counter semantics), but NOT at the `downloadAndSave` level — the new
  media-downloader.test.ts test 2 covers this gap.
