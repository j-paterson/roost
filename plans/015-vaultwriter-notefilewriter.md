# Plan 015: Decompose VaultWriter — Phase 2: Extract NoteFileWriter

> **Executor instructions**: This is a SINGLE-PHASE plan. Read it fully before
> touching any file. Execute every step in order. Run every verification command
> and confirm the expected result before moving to the next step. If a STOP
> condition triggers, stop immediately and report — do NOT improvise a fix.
> When done, update `plans/README.md` status row.
>
> **Drift check (run first)**:
> `git diff --stat 4e1a763..HEAD -- packages/core/src/sync/vault-writer.ts`
> If `vault-writer.ts` changed since this plan was written, re-read it and
> reconcile the method map below. On any change to the methods listed in
> "In scope", STOP and report before proceeding.
>
> **Base commit**: `main @ 4e1a763` (post-Phase-1, VaultIndex already extracted)

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (rewriteNoteBody is the most complex method; extractCommon is
  called by methods that stay on VaultWriter — both require careful delegation)
- **Depends on**: plan 011 (VaultIndex extracted — **MERGED in `main`**); plan
  006 (characterization tests — **MERGED in `main`**)
- **Category**: tech-debt / architecture
- **Planned at**: commit `4e1a763`, 2026-06-10

## Why this matters

After Phase 1, `VaultWriter` is 1,033 lines with VaultIndex cleanly separated.
The note/frontmatter I/O methods (`writeNote`, `writeSidecar`, `createAuthorNote`,
`extractCommon`, `writeGenericRecord`, `rewriteNoteBody`, `stampEnrichmentVersion`)
remain on the main class alongside platform writers, media download, and resync —
making any note-write change require reading all of them. Extracting a
`NoteFileWriter` collaborator reduces the class by ~120 lines, isolates the note
I/O surface into a single testable unit, and mirrors the pattern validated by
Phase 1 (constructor injection, shared state passed by reference). The public
API of `VaultWriter` is unchanged.

## Current state — method map (verified against `main @ 4e1a763`)

### Methods being moved (NoteFileWriter concern)

| Method | Lines | Vis | Notes |
|---|---|---|---|
| `extractCommon` | 237–246 | private | field-extraction helper — also called by methods STAYING on VaultWriter (see Caller Map below) |
| `writeSidecar` | 248–255 | private | vault file write/modify — also called by resyncRecord and backfillWithOembed |
| `createAuthorNote` | 298–302 | private | delegates to ensureAuthorNote; uses createdAuthors + ensuredFolders |
| `writeNote` | 304–310 | private | vault file create; only skips if exists — also called by writeTwitterRecord and writeTikTokRecord |
| `writeGenericRecord` | 661–669 | private | calls extractCommon + writeNote; pure note I/O |
| `rewriteNoteBody` | 681–749 | **public** | calls findFrontmatterEnd, articleFrontmatterFields, index.findNoteForId, vault.read/modify |
| `stampEnrichmentVersion` | 750–760 | **public** | calls index.notePathMap.get, vault.read/modify |

Private state moving with the class:

| Field | Line | Notes |
|---|---|---|
| `createdAuthors: Set<string>` | 298 | used only by `createAuthorNote` — moves entirely |

### Caller map — methods that STAY on VaultWriter but call note-I/O methods

This is the critical list. Every entry below is a call site that must be
**rewired to `this.noteWriter.<method>(...)`** when the target method moves.

| Caller (stays) | Calls (moves) | Line(s) |
|---|---|---|
| `writeTwitterRecord` | `extractCommon` | 313 |
| `writeTwitterRecord` | `createAuthorNote` | 319 |
| `writeTwitterRecord` | `writeSidecar` | 382, 385, 387 |
| `writeTwitterRecord` | `writeNote` | 422 |
| `writeTikTokRecord` | `extractCommon` | 578 |
| `writeTikTokRecord` | `createAuthorNote` | 584 |
| `writeTikTokRecord` | `writeSidecar` | 629, 636 |
| `writeTikTokRecord` | `writeNote` | 658 |
| `resyncRecord` | `extractCommon` | 826 |
| `resyncRecord` | `writeSidecar` | 776, 795, 832, 898, 903 |
| `resyncRecord` | `rewriteNoteBody` | 947 |
| `backfillWithOembed` | `writeSidecar` | 1003 |

Total rewiring sites: 17 call sites across 4 methods that remain on VaultWriter.

### Methods staying on VaultWriter (NOT moved)

- `constructor`, `getExistingIds`, `hydrateThreadFromCache`, `writeBatch`,
  `clearLegacyCarousel`, `downloadAndSave`, `writeTwitterRecord`,
  `renderThreadPages`, `writeTikTokRecord`, `resyncRecord`, `scanIncompleteIds`,
  `backfillWithOembed`
- Private fields staying: `vault`, `syncFolder`, `tiktokWc`, `log`, `index`,
  `cumulative`, `currentStopSignal`, `ensuredFolders`

### Relevant current source excerpts

**extractCommon** (lines 237–246):
```typescript
  private extractCommon(record: NormalizedRecord) {
    const text = extractBookmarkText(record);
    const author = extractBookmarkAuthor(record);
    const username = extractBookmarkAuthorUsername(record);
    const url = extractBookmarkUrl(record);
    const published = extractBookmarkPublishedAt(record);
    const itemId = getBookmarkItemId(record)!;
    const handle = username ? `@${username}` : author;
    return { text, author, username, url, published, itemId, handle };
  }
```

**writeSidecar** (lines 248–255):
```typescript
  private async writeSidecar(filePath: string, content: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, content);
    } else {
      await this.vault.create(filePath, content);
    }
  }
```

**createAuthorNote** (lines 298–302):
```typescript
  private createdAuthors = new Set<string>();
  private async createAuthorNote(handle: string, platform: string): Promise<string> {
    return ensureAuthorNote(this.vault, handle, platform, this.createdAuthors, this.ensuredFolders);
  }
```

**writeNote** (lines 304–310):
```typescript
  private async writeNote(folderPath: string, filename: string, frontmatter: string, bodyParts: string[]): Promise<void> {
    const content = `---\n${frontmatter}\n---\n\n${bodyParts.join("\n")}\n`;
    const filePath = `${folderPath}/${filename}`;
    if (!this.vault.getAbstractFileByPath(filePath)) {
      await this.vault.create(filePath, content);
    }
  }
```

**rewriteNoteBody** (lines 681–749): Most complex method — 69 lines. Calls
`findFrontmatterEnd`, `articleFrontmatterFields` (both currently top-level in
vault-writer.ts), `this.index.findNoteForId`, `this.vault.read/modify`,
`updateNoteFrontmatter`, `getEnrichmentById`, `enrichmentVersionField`,
`extractBookmarkText`.

**stampEnrichmentVersion** (lines 750–760): Calls `this.index.notePathMap.get`,
`this.vault.read/modify`, `updateNoteFrontmatter`, `enrichmentVersionField`.

**ensuredFolders** (line 953): `private ensuredFolders = new Set<string>()`
Used by `downloadAndSave`(line 290), `createAuthorNote`(line 301),
`writeTwitterRecord`(line 318), `renderThreadPages`(line 381 + 446),
`writeTikTokRecord`(lines 583, 628, 635), `resyncRecord`(lines 774, 830),
`backfillWithOembed`(line 963). SHARED across note I/O and media paths.

## Target architecture

`NoteFileWriter` is a new class in
`packages/core/src/sync/vault-writer/note-file-writer.ts`. It owns the 7
methods above plus `createdAuthors`. It is constructed by `VaultWriter` and
accessed via `this.noteWriter`.

### Shared state: ensuredFolders ownership decision

**Design choice**: `VaultWriter` OWNS the single `ensuredFolders: Set<string>`
and INJECTS it into `NoteFileWriter`'s constructor. `NoteFileWriter` receives it
as a constructor parameter and stores a reference — it does not own the set.

Rationale: `ensuredFolders` is used by `downloadAndSave`, `renderThreadPages`,
and `resyncRecord` (all staying on VaultWriter) as well as `createAuthorNote`,
`writeTwitterRecord`, and `writeTikTokRecord` (the platform writers, also staying
but calling the moved note-I/O methods). A single shared Set ensures all folder
ensurements across a `writeBatch` call are deduplicated correctly regardless of
which collaborator performs them. Moving ownership to NoteFileWriter would require
passing it back upward — wrong direction.

`NoteFileWriter` receives:
- `vault: Vault` (read/write files)
- `syncFolder: string` (for path construction in rewriteNoteBody, writeGenericRecord)
- `log: (msg: string) => void`
- `index: VaultIndex` (for rewriteNoteBody → findNoteForId, stampEnrichmentVersion → notePathMap)
- `ensuredFolders: Set<string>` (shared reference, owned by VaultWriter)

`NoteFileWriter` owns:
- `private createdAuthors = new Set<string>()` (only used by createAuthorNote)

### Top-level helpers that move with NoteFileWriter

`findFrontmatterEnd` (lines 37–42) — module-private function used only by
`rewriteNoteBody`. Move verbatim into `note-file-writer.ts` as a module-level
function.

`articleFrontmatterFields` (lines 44–64) — **exported** function, called by:
- `rewriteNoteBody` (moving)
- `writeTwitterRecord` (staying)
- `resyncRecord` (staying)
- External: `packages/core/src/lib/__tests__/extract.test.ts` imports it from
  `"@/sync/vault-writer"`

**Resolution**: Move `articleFrontmatterFields` into `note-file-writer.ts` as
an export, then re-export it from `vault-writer.ts`:
```typescript
export { articleFrontmatterFields } from "./vault-writer/note-file-writer";
```
The external test import `from "@/sync/vault-writer"` continues to resolve
unchanged. `writeTwitterRecord` and `resyncRecord` (staying on VaultWriter)
import it from the same re-export — no call-site changes needed since it is
a module-level function, not a method.

`noteDirPath` (lines 82–84) — used only by `backfillWithOembed` (staying).
Leave it in `vault-writer.ts`.

`loadQuotedTweetBitmap` (lines 86–94) — used only by `resyncRecord` (staying).
Leave it in `vault-writer.ts`.

## Scope

**In scope** (only these 3 files may be created or modified):
1. `packages/core/src/sync/vault-writer/note-file-writer.ts` — CREATE
2. `packages/core/src/sync/vault-writer.ts` — MODIFY (wire delegation, re-export)
3. `packages/core/src/sync/__tests__/note-file-writer.test.ts` — CREATE

**Out of scope** (do NOT touch):
- Any platform writer, media downloader, resync, or index method beyond the
  delegation rewiring described above
- The public method signatures of `VaultWriter`, `VaultWriterOpts`,
  `articleFrontmatterFields`, `IncompleteByCategory`, `IncompleteIdsResult`
- The 5 external construction sites
- Any file outside `packages/core/src/sync/`
- `packages/core/src/sync/__tests__/vault-writer.test.ts` (006's tests —
  must remain byte-unchanged)
- Phases 3–5

## Steps

### Step 1: Create NoteFileWriter

Create `packages/core/src/sync/vault-writer/note-file-writer.ts`.

**Imports** the file will need:
```typescript
import { Vault, TFile } from "obsidian";
import { buildFrontmatter, ensureFolder, ensureAuthorNote, updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { getEnrichmentById, enrichmentVersionField, type EnrichmentId } from "@/lib/enrichments";
import { getBookmarkPlatform, getBookmarkItemId, extractBookmarkText, extractBookmarkAuthor, extractBookmarkAuthorUsername, extractBookmarkUrl, extractBookmarkPublishedAt, sanitizeFilename } from "../lib/extract";
import { articleWordCount, type ArticleResultRaw } from "@/lib/article-extract";
import { type NormalizedRecord } from "../lib/normalize";
import { type VaultIndex } from "./vault-index";
```

**Constructor interface**:
```typescript
interface NoteFileWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  ensuredFolders: Set<string>;
}
```

**Module-level helpers to include** (moved verbatim from vault-writer.ts):
- `findFrontmatterEnd(content: string): number`
- `export function articleFrontmatterFields(raw: unknown): Record<string, unknown>`

**Class structure**:
```typescript
export class NoteFileWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private ensuredFolders: Set<string>;
  private createdAuthors = new Set<string>();

  constructor(opts: NoteFileWriterOpts) { ... }

  // Methods moved verbatim, with this.vault / this.syncFolder / this.log /
  // this.index / this.ensuredFolders replacing the old this.xxx references:
  extractCommon(record: NormalizedRecord) { ... }                 // keep private visibility
  async writeSidecar(filePath: string, content: string): Promise<void> { ... }
  async createAuthorNote(handle: string, platform: string): Promise<string> { ... }
  async writeNote(folderPath: string, filename: string, frontmatter: string, bodyParts: string[]): Promise<void> { ... }
  async writeGenericRecord(record: NormalizedRecord): Promise<void> { ... }
  async rewriteNoteBody(record: NormalizedRecord): Promise<void> { ... }
  async stampEnrichmentVersion(roostId: string, enrichmentId: EnrichmentId, version: number): Promise<void> { ... }
}
```

**Critical**: Copy method bodies VERBATIM — do not refactor, rename variables,
or change any logic. The only changes are:
- Replace `this.vault` with `this.vault` (unchanged — still `this.vault`)
- `rewriteNoteBody` calls `this.index.findNoteForId(...)` — already uses
  `this.index` after Phase 1 rewiring; copy that form verbatim
- `stampEnrichmentVersion` calls `this.index.notePathMap.get(...)` — same,
  copy verbatim
- `createAuthorNote` calls `ensureAuthorNote(..., this.createdAuthors, this.ensuredFolders)` — both fields are now on NoteFileWriter; copy verbatim

**Verify**: `npm run typecheck` — will fail on vault-writer.ts until Step 2; that is expected.

### Step 2: Wire VaultWriter to use NoteFileWriter

In `packages/core/src/sync/vault-writer.ts`:

**a) Add import**:
```typescript
import { NoteFileWriter, articleFrontmatterFields } from "./vault-writer/note-file-writer";
```

**b) Replace re-export of articleFrontmatterFields** (line 44 currently exports
the local function). Change to re-export from the new file:
```typescript
export { articleFrontmatterFields } from "./vault-writer/note-file-writer";
```
Remove the now-relocated `articleFrontmatterFields` function body from
vault-writer.ts. Remove the `findFrontmatterEnd` function body from
vault-writer.ts (moved to note-file-writer.ts; not exported, not needed here).

**c) Add `noteWriter` field**:
```typescript
private noteWriter: NoteFileWriter;
```

**d) Construct in constructor** (after `this.index = new VaultIndex({...})`):
```typescript
this.noteWriter = new NoteFileWriter({
  vault: opts.vault,
  syncFolder: opts.syncFolder,
  log: this.log,
  index: this.index,
  ensuredFolders: this.ensuredFolders,
});
```

IMPORTANT: `this.ensuredFolders` must be initialized BEFORE the NoteFileWriter
constructor call. The current `private ensuredFolders = new Set<string>()` is
a class field initializer at line 953 (below the method block). Move it to the
field declaration section (near line 119, with the other private fields) so it
is definitely initialized before the constructor body runs. This is safe because
class field initializers run in declaration order before the constructor body.

**e) Delete the 7 moved methods** from vault-writer.ts:
- `private extractCommon` (lines 237–246)
- `private async writeSidecar` (lines 248–255)
- `private createdAuthors` field (line 298)
- `private async createAuthorNote` (lines 300–302)
- `private async writeNote` (lines 304–310)
- `private async writeGenericRecord` (lines 661–669)
- `async rewriteNoteBody` (lines 681–749)
- `async stampEnrichmentVersion` (lines 750–760)

**f) Add public delegation methods for the two public methods**:
```typescript
async rewriteNoteBody(record: NormalizedRecord): Promise<void> {
  return this.noteWriter.rewriteNoteBody(record);
}

async stampEnrichmentVersion(roostId: string, enrichmentId: EnrichmentId, version: number): Promise<void> {
  return this.noteWriter.stampEnrichmentVersion(roostId, enrichmentId, version);
}
```

**g) Rewire the 17 internal call sites** in `writeTwitterRecord`,
`writeTikTokRecord`, `resyncRecord`, and `backfillWithOembed`:

For each occurrence in the caller map from "Current state" above:
- `this.extractCommon(record)` → `this.noteWriter.extractCommon(record)`
- `this.createAuthorNote(handle, platform)` → `this.noteWriter.createAuthorNote(handle, platform)`
- `this.writeSidecar(path, content)` → `this.noteWriter.writeSidecar(path, content)`
- `this.writeNote(folder, name, fm, parts)` → `this.noteWriter.writeNote(folder, name, fm, parts)`

The `this.rewriteNoteBody(record)` call in `resyncRecord` (line 947) is
handled by the public delegation method added in step (f) — no change needed
there since it calls `this.rewriteNoteBody` which now delegates.

**h) Remove the `private ensuredFolders` declaration at its original location**
(line 953) since it was moved to the field declaration section in step (d).

**Verify**:
```bash
npm run typecheck  # must exit 0
```

### Step 3: Verify public API is unchanged

Run these grep checks — each must return the expected result:

```bash
# Public delegation methods present:
grep -n "async rewriteNoteBody\|async stampEnrichmentVersion" \
  packages/core/src/sync/vault-writer.ts
# Expected: 2 matches (the delegation wrappers)

# articleFrontmatterFields re-exported from vault-writer.ts:
grep -n "articleFrontmatterFields" packages/core/src/sync/vault-writer.ts
# Expected: 1 match (the re-export line)

# Moved methods are gone from vault-writer.ts:
grep -cn "private extractCommon\|private async writeSidecar\|private async createAuthorNote\|private async writeNote\|private async writeGenericRecord" \
  packages/core/src/sync/vault-writer.ts
# Expected: 0

# NoteFileWriter class exists in the new file:
grep -n "export class NoteFileWriter" \
  packages/core/src/sync/vault-writer/note-file-writer.ts
# Expected: 1 match

# articleFrontmatterFields is exported from note-file-writer.ts:
grep -n "export function articleFrontmatterFields" \
  packages/core/src/sync/vault-writer/note-file-writer.ts
# Expected: 1 match

# External import still resolves (no change to extract.test.ts needed):
grep -n "from.*vault-writer" packages/core/src/lib/__tests__/extract.test.ts
# Expected: 1 match pointing at "@/sync/vault-writer" (unchanged)
```

### Step 4: Add unit tests for NoteFileWriter

Create `packages/core/src/sync/__tests__/note-file-writer.test.ts`.

Use the `makeFakeVault()` helper from `./fake-vault`. Construct `NoteFileWriter`
directly (not through VaultWriter) with a minimal inline VaultIndex stub.

**Minimal VaultIndex stub** (inline in the test file):
```typescript
function makeMinimalIndex(files: Map<string, string>): VaultIndex {
  return {
    notePathMap: new Map(),
    findNoteForId(roostId: string, folderPath: string, handle: string, itemId: string) {
      const path = `${folderPath}/${handle} - ${itemId}.md`;
      const content = files.get(path);
      if (!content) return null;
      return { path, name: `${handle} - ${itemId}.md`, extension: "md" } as TFile;
    },
  } as unknown as VaultIndex;
}
```

**Test cases to include**:

1. **`writeGenericRecord` output** — Construct a `NoteFileWriter` directly.
   Call `writeGenericRecord` via a thin wrapper (since it's private, expose via
   a test-only helper or cast to `any`). Assert:
   - The note file exists at `Bookmarks/Other/@someone - 1.md`
   - The file content contains `roost_id: "generic:1"` in frontmatter
   - The file content contains `platform: generic` in frontmatter
   - The file body contains "hello world"

2. **`rewriteNoteBody` no-op on missing note** — Seed a NoteFileWriter with
   an index that returns null for findNoteForId. Call rewriteNoteBody with a
   valid record. Assert: no vault.modify was called (file map unchanged).

3. **`rewriteNoteBody` rewrites body when frontmatter is present** — Seed the
   fake vault with a note at the expected path containing valid frontmatter and
   an old body. Call rewriteNoteBody with a record whose `rawData.desc` is
   "new body text". Assert the note file's content now ends with "new body text\n".

4. **`stampEnrichmentVersion` no-op when roostId not in notePathMap** — Call
   with a roostId not in the index's notePathMap. Assert vault.modify is never
   called.

5. **`writeSidecar` creates new file** — Call writeSidecar with a path that
   doesn't exist. Assert the file exists with the correct content.

6. **`writeSidecar` modifies existing file** — Seed a file, call writeSidecar
   with the same path and new content. Assert the file content was updated.

**Verify**:
```bash
npx vitest run packages/core/src/sync/__tests__/note-file-writer.test.ts
# Expected: all pass
```

### Step 5: Confirm 006's characterization tests unchanged

```bash
npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts
# Expected: all pass — same behavior, delegation is transparent
```

### Step 6: Full suite

```bash
npm test
# Expected: all 969+ tests pass (baseline + new note-file-writer tests)
```

## Done criteria

ALL must hold before the plan is marked complete:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; new `note-file-writer.test.ts` exists and passes
- [ ] `packages/core/src/sync/__tests__/vault-writer.test.ts` byte-unchanged:
  `git diff HEAD -- packages/core/src/sync/__tests__/vault-writer.test.ts` → empty
- [ ] `NoteFileWriter` class exported from `vault-writer/note-file-writer.ts`:
  `grep -c "export class NoteFileWriter" packages/core/src/sync/vault-writer/note-file-writer.ts` → 1
- [ ] Moved methods absent from vault-writer.ts:
  `grep -c "private extractCommon\|private async writeSidecar\|private async createAuthorNote\|private async writeNote\|private async writeGenericRecord" packages/core/src/sync/vault-writer.ts` → 0
- [ ] Public API preserved — delegation wrappers present:
  `grep -c "async rewriteNoteBody\|async stampEnrichmentVersion" packages/core/src/sync/vault-writer.ts` → 2
- [ ] `articleFrontmatterFields` still importable from `"@/sync/vault-writer"`:
  `npx tsc --noEmit` clears AND `grep "from.*vault-writer" packages/core/src/lib/__tests__/extract.test.ts` unchanged
- [ ] `git diff --name-only 4e1a763..HEAD` lists ONLY the 3 in-scope files:
  `vault-writer.ts`, `vault-writer/note-file-writer.ts`, `__tests__/note-file-writer.test.ts`
  (plus `plans/README.md` status update)
- [ ] `plans/README.md` status row updated; Phase 3 noted as next

## STOP conditions

Stop and report (do NOT improvise) if:

- The drift check shows `vault-writer.ts` was modified since `4e1a763` in a
  way that changes any of the in-scope method bodies or signatures — re-read
  and reconcile before touching anything.
- Moving `articleFrontmatterFields` breaks ANY import path that cannot be fixed
  with a re-export from `vault-writer.ts` (check: `grep -rn "articleFrontmatterFields" packages/core/src`).
- `ensuredFolders` is referenced somewhere in the codebase other than within
  `vault-writer.ts` — report the location; the shared-reference injection model
  may need adjustment.
- `rewriteNoteBody` or `stampEnrichmentVersion` call any `this.xxx` that was
  not accounted for in the Caller Map (i.e. a method that didn't appear in the
  grep for internal call sites) — report it before moving the method.
- 006's characterization tests fail at any step — that means the delegation
  altered observable behavior; STOP, do not modify the test to match.
- The typecheck introduces new errors outside the 3 in-scope files.

## Test plan

| What | How | Expected |
|---|---|---|
| NoteFileWriter directly: writeGenericRecord output | note-file-writer.test.ts test 1 | note file at correct path with correct frontmatter + body |
| NoteFileWriter directly: rewriteNoteBody guard-rails | note-file-writer.test.ts tests 2–3 | no-op on missing note; rewrites on valid note |
| NoteFileWriter directly: stampEnrichmentVersion no-op | note-file-writer.test.ts test 4 | vault.modify not called |
| NoteFileWriter directly: writeSidecar create+modify | note-file-writer.test.ts tests 5–6 | file created / updated correctly |
| VaultWriter public API unchanged | vault-writer.test.ts (006's tests, UNCHANGED) | all pass |
| External articleFrontmatterFields import | extract.test.ts (UNCHANGED) | all pass |
| TypeCheck | `npm run typecheck` | exit 0 |
| Full suite | `npm test` | 969+ pass |

## Git workflow

- Branch: `refactor/015-vaultwriter-notefilewriter`
- Commit style: `refactor(sync): extract NoteFileWriter from VaultWriter (decomposition phase 2)`
- Do NOT push or open a PR unless instructed.

## Open questions for reviewer / follow-up

- Phase 3 (`MediaDownloader`) will want to share `ensuredFolders` by the same
  injection model. At that point all three collaborators (VaultIndex, NoteFileWriter,
  MediaDownloader) receive the Set from VaultWriter — consider whether a tiny
  `WriterContext` holder is cleaner than individual constructor params.
- `writeTwitterRecord` and `writeTikTokRecord` still sit on VaultWriter, calling
  `this.noteWriter.xxx` for I/O. Phase 4 will extract them into platform-specific
  collaborators. Ensure Phase 4's plan notes that those collaborators will need
  the `noteWriter` reference injected.
- `resyncRecord` still duplicates ~80% of the platform writer logic. Phase 5
  (ResyncRunner) is the final cleanup. Do not touch resyncRecord in this plan.

## Maintenance notes

This is decomposition **Phase 2 of 5**. After it lands:

- Phase 3 = extract `MediaDownloader` (`downloadAndSave`, `clearLegacyCarousel`,
  `backfillWithOembed`) — plan 016. Deps on `currentStopSignal`, `tiktokWc`,
  `ensuredFolders`.
- Phase 4 = extract `TwitterRecordWriter` + `TikTokRecordWriter` — plan 017.
  MUST be preceded by characterization tests for twitter/tiktok write paths
  (network/`requestUrl` stubbed via `__setRequestUrlImpl`).
- Phase 5 = extract `ResyncRunner` (kill the ~80% duplication in resyncRecord)
  — plan 018.
- Reviewer focus: public API contract is sacrosanct — `articleFrontmatterFields`
  re-export and the two delegation wrappers (`rewriteNoteBody`,
  `stampEnrichmentVersion`) must compile to the same external shape.
