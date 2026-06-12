# Plan 011: Decompose VaultWriter — design + Phase 1 spike (extract VaultIndex)

> **Executor instructions**: This is a DESIGN + FIRST-PHASE plan, not a
> build-everything refactor. Read it fully. Execute ONLY "Phase 1" below; the
> later phases are a roadmap to become follow-up plans after Phase 1 validates
> the approach. Run every verification command and confirm the expected result.
> If a STOP condition occurs, stop and report. When done, update this plan's
> status row in `plans/README.md` — unless a reviewer dispatched you and told
> you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat c55bf46..HEAD -- packages/core/src/sync/vault-writer.ts`
> If `vault-writer.ts` changed since this plan was written, re-read it and
> reconcile the method map below before proceeding; on a major mismatch, STOP.
>
> **Known difference vs the original 1671710 stamp**: `vault-writer.ts` at the
> current base `c55bf46` contains a small `rest_id` guard in `renderThreadPages`
> (~lines 485–489, a Twitter method) from a prior fix. It is NOT an index method
> and is OUT of scope for this Phase-1 extraction — leave it untouched. It shifts
> later line numbers by ~+4; the method map below is approximate, so read the
> actual file.

## Status

- **Priority**: P2
- **Effort**: L (this plan executes Phase 1 only — an M; full decomposition is multi-plan)
- **Risk**: MED (Phase 1 is the lowest-risk extraction; later phases are higher — gated separately)
- **Depends on**: plan 006 (characterization tests — **MERGED in `main`**, they are the safety net)
- **Category**: tech-debt / architecture
- **Planned at**: commit `c55bf46` (re-stamped from `1671710`), 2026-06-10

## Why this matters

`packages/core/src/sync/vault-writer.ts` is a 1,295-line class with 23 methods
(`VaultWriter`) that couples five distinct concerns: vault-index scanning,
note/frontmatter I/O, media download, platform-specific (Twitter/TikTok)
rendering, and resync. Any change to one concern forces reading and re-testing
all of them; the two worst methods, `resyncRecord` (190 lines, 3 platforms,
~80% duplicated from the writers) and `renderThreadPages` (146 lines of nested
async media loops), are where bugs hide. Plan 006 added characterization tests
that pin today's behavior, so the class is finally safe to split. The goal is a
**facade**: `VaultWriter` keeps its exact public API (5 external construction
sites and 8 public methods depend on it) while delegating to focused
collaborators. This plan designs that target and executes the first, lowest-risk
extraction (`VaultIndex`) to validate the pattern before committing to the rest.

## Current state — the map (verified 2026-06-10 against `1671710`, re-based to `c55bf46`)

### Methods and their concern (line numbers approximate)

| Method | Lines | Vis | Concern |
|---|---|---|---|
| constructor | 156 | pub | wiring (vault, syncFolder, metadataCache, tiktokWc, log) |
| readRoostId | 169 | priv | INDEX (read id from file/cache) |
| getExistingIds | 184 | pub | INDEX |
| hydrateThreadFromCache | 201 | pub | TWITTER (reads index) |
| writeBatch | 222 | pub | ORCHESTRATION |
| extractCommon | 287 | priv | shared field extraction |
| writeSidecar | 298 | priv | NOTE I/O |
| clearLegacyCarousel | 307 | priv | MEDIA |
| downloadAndSave | 318 | priv | MEDIA |
| createAuthorNote | 350 | priv | NOTE I/O |
| writeNote | 354 | priv | NOTE I/O |
| writeTwitterRecord | 362 | priv | TWITTER |
| renderThreadPages | 475 | priv | TWITTER (hotspot) |
| writeTikTokRecord | 623 | priv | TIKTOK |
| writeGenericRecord | 707 | priv | NOTE I/O |
| findExistingAttachFolder | 722 | priv | INDEX |
| rewriteNoteBody | 741 | pub | NOTE I/O (+ article frontmatter) |
| stampEnrichmentVersion | 810 | pub | NOTE I/O (reads index) |
| resyncRecord | 821 | pub | RESYNC (spans all — hotspot) |
| findNoteForId | 1013 | priv | INDEX |
| scanIncompleteIds | 1028 | pub | INDEX (note: also touches tiktokWc, ensuredFolders) |
| scanExistingIds | 1200 | priv | INDEX (populates existingIds + notePathMap) |
| backfillWithOembed | 1221 | pub | MEDIA (+ index reads) |

### Shared instance state (the coupling)

- `existingIds: Set<string> | null` — written by scanExistingIds; read by writeBatch.
- `notePathMap: Map<string, TFile>` — written by scanExistingIds + scanIncompleteIds; read by findExistingAttachFolder, findNoteForId, stampEnrichmentVersion, backfillWithOembed.
- `ensuredFolders: Set<string>` — folder-creation dedupe, used by every writer + media path.
- `createdAuthors: Set<string>` — author-note dedupe.
- `cumulative: { pushed, resynced, skipped, processed }` — writeBatch counters.
- `currentStopSignal: { stopped } | null` — checked by downloadAndSave, renderThreadPages, writeBatch, backfillWithOembed.

### Public contract that MUST be preserved (do NOT change any of these)

- **Constructor** `VaultWriterOpts` (exported): `{ vault, syncFolder, metadataCache?, tiktokWebview?, onLog? }`.
  5 construction sites: `ui/hooks/use-roost-platform-sync.ts:77`, `sync/run-platform-sync.ts:106`, `sync/article-backfill.ts:121`, `sync/thread-backfill.ts:142`, `sync/media-backfill.ts:125`.
- **8 public methods**, exact signatures/returns: `getExistingIds()`, `hydrateThreadFromCache(record)`, `writeBatch(records, stopSignal?)` → `{pushed, skipped, resynced}`, `rewriteNoteBody(record)`, `stampEnrichmentVersion(roostId, enrichmentId, version)`, `resyncRecord(record)`, `scanIncompleteIds()` → `IncompleteIdsResult`, `backfillWithOembed(incompleteIds, stopSignal?)`.
- **Exported types** (imported elsewhere): `VaultWriterOpts`, `IncompleteByCategory` (used by `ui/hub/state.ts`, `types/plugin.ts`, `lib/enrichments.ts`), `IncompleteIdsResult`, and the standalone `articleFrontmatterFields` (used by `lib/__tests__/extract.test.ts`).
- **Counter semantics**: `writeBatch` returns `resynced` as a subset of `skipped` (display subtracts — intentional, finding CORRECTNESS-04). Pinned by 006's tests; keep it.

### Safety net (already in `main`)

- `packages/core/src/sync/__tests__/vault-writer.test.ts` + `fake-vault.ts` (plan 006):
  characterization tests for `writeBatch` (generic records, stop signal, counter
  semantics), `rewriteNoteBody` guard-rails, `getExistingIds` scanning. These
  MUST stay green through every phase.
- e2e: `tests/e2e/85-x-article-backfill-full-chain.spec.ts` exercises
  `rewriteNoteBody` end-to-end (manual/CI only).

## Target architecture (the design)

`VaultWriter` becomes a thin **facade** that constructs and composes
collaborators, preserving its public API exactly. Collaborators (new files under
`packages/core/src/sync/vault-writer/`):

1. **`VaultIndex`** (`vault-writer/vault-index.ts`) — owns `existingIds` +
   `notePathMap`. Methods: `scanExistingIds`, `getExistingIds`, `readRoostId`,
   `findNoteForId`, `findExistingAttachFolder`, `scanIncompleteIds`. Deps: vault,
   syncFolder, metadataCache, log (and tiktokWc IF scanIncompleteIds needs it —
   confirm during extraction). **← Phase 1 extracts this.**
2. **`NoteFileWriter`** (`vault-writer/note-file-writer.ts`) — `writeNote`,
   `writeSidecar`, `createAuthorNote`, `stampEnrichmentVersion`,
   `rewriteNoteBody`, `writeGenericRecord`, `extractCommon`. Owns `createdAuthors`,
   shares `ensuredFolders`. Reads index via injected `VaultIndex`.
3. **`MediaDownloader`** (`vault-writer/media-downloader.ts`) — `downloadAndSave`,
   `clearLegacyCarousel`, `backfillWithOembed`. Owns stop-signal checks, shares
   `ensuredFolders`.
4. **`TwitterRecordWriter`** + **`TikTokRecordWriter`** — the platform writers
   (`writeTwitterRecord` + `renderThreadPages` + `hydrateThreadFromCache`;
   `writeTikTokRecord`). Compose NoteFileWriter + MediaDownloader + VaultIndex.
5. **`ResyncRunner`** — `resyncRecord` split into per-platform branches reusing
   the platform writers' helpers (kills the ~80% duplication).

`VaultWriter` retains `writeBatch` (orchestration) + `cumulative` and delegates
every public method to the matching collaborator.

### Phased sequence (each phase is a separate STOP-and-review gate)

| Phase | Extract | Risk | Becomes |
|---|---|---|---|
| **1** | `VaultIndex` | LOW | **this plan** |
| 2 | `NoteFileWriter` | MED | plan 012 |
| 3 | `MediaDownloader` | MED | plan 013 |
| 4 | `TwitterRecordWriter` + `TikTokRecordWriter` | HIGH | plan 014 (needs twitter/tiktok char tests first) |
| 5 | `ResyncRunner` (de-duplicate resyncRecord) | HIGH | plan 015 |

Phase 4 is gated on FIRST adding characterization tests for the twitter/tiktok
write paths (network-stubbed) — flag this when you write plan 014.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Install | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| VaultWriter tests | `npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts` | all pass (006's char tests) |
| All tests | `npm test` | 953+ pass (baseline at `1671710`) |

## Scope (THIS PLAN = Phase 1 only)

**In scope**:
- `packages/core/src/sync/vault-writer/vault-index.ts` (create)
- `packages/core/src/sync/vault-writer.ts` (delegate index concerns to VaultIndex; do NOT change its public API)
- `packages/core/src/sync/__tests__/vault-index.test.ts` (create — unit-test the extracted class directly)

**Out of scope** (do NOT touch in this plan):
- Any platform/media/note-writing method beyond what's needed to wire VaultIndex.
- The public method signatures of `VaultWriter`, `VaultWriterOpts`, `IncompleteByCategory`, `IncompleteIdsResult`, `articleFrontmatterFields` — unchanged.
- The 5 external construction sites and any caller — they must keep compiling with zero edits.
- Phases 2–5.

## Git workflow

- Branch: `advisor/011-vaultwriter-vaultindex`
- Commit style: `refactor(sync): extract VaultIndex from VaultWriter (decomposition phase 1)`
- Do NOT push or open a PR unless instructed.

## Steps (Phase 1: extract VaultIndex)

### Step 1: Create the VaultIndex class

Create `packages/core/src/sync/vault-writer/vault-index.ts` exporting a
`VaultIndex` class that OWNS `existingIds` and `notePathMap` and contains the
index methods MOVED verbatim from VaultWriter: `scanExistingIds`,
`getExistingIds`, `readRoostId`, `findNoteForId`, `findExistingAttachFolder`,
`scanIncompleteIds`. Constructor takes the deps they use:
`{ vault, syncFolder, metadataCache?, tiktokWebview?, log }`.

- Copy the method bodies exactly; only change `this.vault`→`this.vault` etc.
  (the deps move with them) and expose `existingIds`/`notePathMap` as readable
  (a getter or public readonly field) so VaultWriter can read them.
- Keep `IncompleteByCategory` / `IncompleteIdsResult` defined where they are now
  (exported from vault-writer.ts) OR move them to a shared types file and
  re-export from vault-writer.ts so external imports still resolve — verify
  `grep -rn "IncompleteByCategory\|IncompleteIdsResult" packages/core/src` and
  keep every import path working.

**Verify**: `npm run typecheck` → may fail at VaultWriter until Step 2; that's expected

### Step 2: Make VaultWriter compose VaultIndex

In `vault-writer.ts`:
- Construct `this.index = new VaultIndex({ vault, syncFolder, metadataCache, tiktokWebview, log })` in the constructor.
- Delete the moved methods; replace internal calls (`this.findNoteForId(...)`, `this.findExistingAttachFolder(...)`, `this.scanExistingIds()`, `this.readRoostId(...)`) with `this.index.findNoteForId(...)` etc.
- Public `getExistingIds()` and `scanIncompleteIds()` delegate: `return this.index.getExistingIds()` / `return this.index.scanIncompleteIds()`.
- Replace reads of `this.existingIds` / `this.notePathMap` with `this.index.existingIds` / `this.index.notePathMap`.
- Keep `IncompleteByCategory` / `IncompleteIdsResult` / `VaultWriterOpts` / `articleFrontmatterFields` exported from vault-writer.ts (re-export if you moved them).

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "class VaultIndex" packages/core/src/sync/vault-writer/vault-index.ts` → 1 match
- `grep -cn "private async scanExistingIds\|private findNoteForId\|findExistingAttachFolder" packages/core/src/sync/vault-writer.ts` → 0 (methods moved out)

### Step 3: Unit-test VaultIndex directly + keep 006's tests green

- Create `packages/core/src/sync/__tests__/vault-index.test.ts` using the
  `makeFakeVault()` helper from `./fake-vault` (plan 006). Move/mirror 006's
  `getExistingIds` test to target `VaultIndex` directly, and add a focused test
  for `findNoteForId` (note found / not found) and `existingIds`/`notePathMap`
  population after `scanExistingIds`. Assert on real returned ids, not mocks.
- Run 006's existing characterization suite — it must still pass unchanged
  (VaultWriter's behavior is identical; only its internals moved).

**Verify**:
- `npx vitest run packages/core/src/sync/__tests__/vault-index.test.ts` → pass
- `npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts` → pass (006's tests, unchanged)

### Step 4: Full suite

**Verify**: `npm test` → all pass (953+ plus the new vault-index tests)

## Done criteria (Phase 1)

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; new `vault-index.test.ts` exists and passes; 006's `vault-writer.test.ts` still passes unchanged
- [ ] `VaultIndex` class exists in `vault-writer/vault-index.ts` and owns existingIds + notePathMap
- [ ] `VaultWriter`'s public API is byte-unchanged: `git diff c55bf46..HEAD -- packages/core/src/sync/vault-writer.ts | grep -E "^[-+].*(async getExistingIds|async scanIncompleteIds|async writeBatch|async rewriteNoteBody|async resyncRecord|async stampEnrichmentVersion|async backfillWithOembed|async hydrateThreadFromCache|export interface VaultWriterOpts|export interface IncompleteByCategory|export interface IncompleteIdsResult|export function articleFrontmatterFields)"` shows NO signature lines removed/changed (only call-site bodies)
- [ ] No external caller or construction site was edited (`git diff c55bf46..HEAD --name-only` lists only the 3 in-scope files)
- [ ] `plans/README.md` status row updated; Phases 2–5 noted as follow-ups

## STOP conditions

Stop and report back (do not improvise) if:

- `scanIncompleteIds` turns out to be entangled with media/writer concerns
  (not just index state + tiktokWc) such that moving it cleanly is impossible —
  report the entanglement; it may need to stay on VaultWriter for Phase 1 with
  only the pure index methods extracted.
- Moving `IncompleteByCategory`/`IncompleteIdsResult` breaks any external import
  you can't preserve with a re-export.
- 006's characterization tests change behavior (any of them fails) — that means
  the extraction altered semantics; STOP, do not "fix" the test.
- The public API diff shows any signature change.

## Open questions (for the reviewer / follow-up phases)

- Does `scanIncompleteIds` genuinely need `tiktokWebview`? If only for one
  check, consider passing a narrower dependency. (Confirm by reading lines
  1028–1196.)
- `ensuredFolders` and `currentStopSignal` are shared across future
  collaborators — Phase 2/3 must decide whether they live on a shared context
  object injected into each collaborator, or stay owned by VaultWriter and
  passed per-call. Recommend a small `WriterContext` holder; flag in plan 012.
- Phase 4 (platform writers) MUST be preceded by characterization tests for the
  twitter/tiktok write paths (network/`requestUrl` stubbed via the obsidian
  mock's `__setRequestUrlImpl`) — there is currently no unit coverage there.

## Maintenance notes

- This is decomposition **Phase 1 of 5**. After it lands and review confirms the
  facade pattern holds, turn Phases 2–5 into plans 012–015, each a STOP-and-review
  gate, each keeping 006's tests (and any added char tests) green.
- Reviewer focus: the public API is the contract — verify zero caller edits and
  that `IncompleteByCategory` still imports cleanly in `ui/hub/state.ts`,
  `types/plugin.ts`, `lib/enrichments.ts`.
- Do NOT let this balloon into a big-bang rewrite. One collaborator per plan.
