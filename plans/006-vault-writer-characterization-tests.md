# Plan 006: Characterization tests for VaultWriter's core write paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 719d54a..HEAD -- packages/core/src/sync/vault-writer.ts`
> If `vault-writer.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: LOW (tests only — no production code changes allowed)
- **Depends on**: none (but lands before any future refactor of vault-writer)
- **Category**: tests
- **Planned at**: commit `719d54a`, 2026-06-10

## Why this matters

`packages/core/src/sync/vault-writer.ts` (1,295 lines, 23 methods) is the
single write path for every bookmark note in the user's vault — note creation,
frontmatter, resync, body rewrites. It has **zero unit tests** (the only file
in `sync/__tests__/` is `card-renderer.test.ts`, which covers card rendering).
A regression here corrupts user notes silently. Characterization tests pin
today's observable behavior so that (a) bugs become visible as diffs, and
(b) the eventually-desired split of this god class (audit finding DEBT-02,
deliberately NOT planned yet) becomes safe to attempt. **This plan documents
current behavior — it must not "fix" anything it finds.** Surprising behavior
gets a test with a `// CHARACTERIZATION:` comment, not a code change.

## Current state

- `packages/core/src/sync/vault-writer.ts` — the class under test. Public
  surface (line numbers at `719d54a`): `constructor(opts)` :156,
  `getExistingIds()` :184, `hydrateThreadFromCache()` :201, `writeBatch()`
  :222, `rewriteNoteBody()` :741, `stampEnrichmentVersion()` :810,
  `resyncRecord()` :821, `scanIncompleteIds()` :1028, `backfillWithOembed()`
  :1221.
- Constructor dependencies (all injected — this is what makes testing
  feasible):

```ts
// vault-writer.ts:156-162
  constructor(opts: VaultWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.metadataCache = opts.metadataCache;   // optional
    this.tiktokWc = opts.tiktokWebview;        // optional — undefined in tests
    this.log = opts.onLog || (() => {});
  }
```

- Record shape (`packages/core/src/lib/normalize.ts:13-22`):

```ts
export interface NormalizedRecord {
  id: string;            // e.g. "tiktok:123" / "twitter:456" / "generic:1"
  platform: string;
  itemId: string;
  rawData: RawApiData;
  saved_at: string;
  published_at: string | null;
  captured_via: string;
}
```

- The simplest full write path — platform other than twitter/tiktok routes to
  `writeGenericRecord` (`vault-writer.ts:707-716`): builds frontmatter via
  `buildFrontmatter`, writes to `${syncFolder}/Other/<sanitized handle - itemId>.md`
  with `writeNote`. No network, no webview. **Start here.**
- `writeBatch` counter semantics (`vault-writer.ts:236-252`): for a record
  whose id is already in `existingIds`, the code runs `resyncRecord` and
  increments **both** `resynced` and `skipped` (`skipped` means "not new";
  reporting subtracts `resynced` from `skipped` for display). This is
  by-design — encode it in a test so nobody "fixes" it (audit finding
  CORRECTNESS-04 was rejected for exactly this).
- `rewriteNoteBody` (`vault-writer.ts:741-757`): resolves the note via
  `findNoteForId`, silently returns if the note is missing, returns without
  modifying when the file has no frontmatter (`fmEnd < 0` — "skip rather
  than corrupt").
- Existing-id scan: `getExistingIds()`/`scanExistingIds()` walk
  `vault.getMarkdownFiles()` filtered to the sync folder and read `roost_id`
  (via metadataCache when present, else `vault.cachedRead`).
- Test infrastructure already in place:
  - `vitest.config.ts:31-36` aliases `obsidian` →
    `packages/core/src/__mocks__/obsidian.ts` (stub classes `Vault`, `TFile`,
    `Notice`, plus `requestUrl` hooks).
  - Mock style exemplar: `packages/core/src/lib/__tests__/vault-helpers.test.ts`
    (hand-built vault objects with `vi.fn()`).
  - Heavier pipeline harness exemplar:
    `packages/core/src/pipeline/__tests__/pipeline-runners.harness.test.ts`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npm run typecheck`      | exit 0, no output   |
| This plan's tests | `npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts` | all pass |
| All tests | `npm test`               | 929+ tests pass     |

## Scope

**In scope** (the only files you should create/modify):
- `packages/core/src/sync/__tests__/fake-vault.ts` (create — in-memory vault test double)
- `packages/core/src/sync/__tests__/vault-writer.test.ts` (create)

**Out of scope** (do NOT touch):
- `packages/core/src/sync/vault-writer.ts` — **zero production changes.** If a
  test can't be written without changing it, that's a STOP condition.
- `packages/core/src/__mocks__/obsidian.ts` — extend only if a class you need
  is missing a *no-op* member; never add behavior there (behavior lives in
  your fake-vault double).
- Twitter/TikTok write paths that hit the network or webview
  (`writeTwitterRecord`'s media downloads, `renderThreadPages`,
  `backfillWithOembed`) — characterize only what runs hermetically.

## Git workflow

- Branch: `advisor/006-vault-writer-characterization-tests`
- Commit style: `test(sync): characterization tests for VaultWriter write paths`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Build the in-memory fake vault

Create `packages/core/src/sync/__tests__/fake-vault.ts`: a minimal in-memory
implementation backed by a `Map<string, string>` of path → content. Implement
only what VaultWriter's hermetic paths call — discover the exact set by
running the tests and adding members as TypeScript/runtime demands, but
expect roughly: `create`, `modify`, `read`, `cachedRead`,
`getAbstractFileByPath`, `getMarkdownFiles`, `createFolder`, `adapter.write`,
`adapter.exists`. File objects should be shaped like
`{ path, name, extension: "md" }` and `instanceof TFile` is NOT required by
the code paths in scope (verify: vault-writer checks `instanceof TFolder`
only in code outside this plan's paths; if a path you test does an
`instanceof` check against the mock classes, construct your fakes with
`Object.create(TFile.prototype)` using the stub class from the obsidian mock).
Export a `makeFakeVault()` returning `{ vault, files }` so tests can inspect
written content directly.

**Verify**: `npm run typecheck` → exit 0

### Step 2: Characterize `writeBatch` with generic records

In `vault-writer.test.ts`, construct
`new VaultWriter({ vault, syncFolder: "Bookmarks", onLog: () => {} })` and a
minimal generic record:

```ts
const rec = {
  id: "generic:1", platform: "generic", itemId: "1",
  rawData: { desc: "hello", author: { uniqueId: "someone" } },
  saved_at: "2026-01-02T00:00:00.000Z", published_at: null, captured_via: "test",
};
```

(If `extractCommon` derives nothing useful from this rawData shape, inspect
`packages/core/src/lib/extract.ts`'s `extractBookmarkText`/author helpers for
the minimal fields and adjust — then record the required shape in a comment.)

Tests:
1. New record → returns `{ pushed: 1, skipped: 0, resynced: 0 }`; a note
   exists under `Bookmarks/Other/`; its content starts with `---\n` and
   contains `roost_id: generic:1`.
2. Same record again in a **new** VaultWriter over the same fake vault
   (forces a fresh `scanExistingIds`) → `{ pushed: 0, skipped: 1, resynced: 1 }`
   — `// CHARACTERIZATION: skipped counts every non-new record; resynced is a subset. Display-layer subtracts.`
3. `stopSignal: { stopped: true }` → returns all-zero counters, no files
   written.

**Verify**: `npx vitest run packages/core/src/sync/__tests__/vault-writer.test.ts` → pass

### Step 3: Characterize `rewriteNoteBody` guard rails

1. Record whose note doesn't exist → resolves without throwing; no vault
   writes (assert `files` map unchanged).
2. Note exists but has NO frontmatter (`"just a body"`) → resolves; content
   unchanged (the `fmEnd < 0` skip-rather-than-corrupt guard at
   `vault-writer.ts:758-759`).

**Verify**: test file passes

### Step 4: Characterize `getExistingIds`

Seed the fake vault with two notes under `Bookmarks/` containing
`roost_id: tiktok:1` / `roost_id: twitter:2` frontmatter and one note outside
the sync folder → `getExistingIds()` returns exactly the two inside ids.
(Without a metadataCache, the code falls back to `vault.cachedRead` +
`parseRoostId` — your fake's `cachedRead` must return note content.)

**Verify**: test file passes

### Step 5: Full suite

**Verify**: `npm test` → all pass; count the new tests (expect ≥8)

## Test plan

This plan IS the test plan. Structural patterns: hand-built doubles as in
`vault-helpers.test.ts`; fixture realism as in
`pipeline-runners.harness.test.ts`. Every surprising observed behavior gets a
`// CHARACTERIZATION:` comment explaining it is pinned, not endorsed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with ≥8 new tests in `sync/__tests__/vault-writer.test.ts`
- [ ] `git diff --stat -- packages/core/src/sync/vault-writer.ts` shows ZERO changes
- [ ] The resync/skipped double-count semantics are pinned by an explicit assertion
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any test seems to require modifying `vault-writer.ts` (e.g. an
  unconstructable private dependency) — report which method and why.
- `writeBatch` on a generic record reaches network/webview code (it should
  not — `writeGenericRecord` is pure vault I/O). If it does, report the call
  chain; do not stub network calls to force it through.
- The fake vault grows past ~150 lines — the paths in scope shouldn't need
  more; if they do, the scoping was wrong and the advisor should re-cut it.

## Maintenance notes

- These tests are the safety net for the deferred VaultWriter decomposition
  (audit finding DEBT-02: split into NoteWriter / media coordination / thread
  rendering). Whoever attempts that split must keep these green and should
  extend coverage to the twitter/tiktok paths first (with `requestUrl` and
  download stubs via `__setRequestUrlImpl`).
- Reviewer focus: tests must assert on *written note content* (the real
  contract), not on which internal methods were called.
- Explicitly deferred: twitter/tiktok record paths (network-coupled),
  `scanIncompleteIds` (needs larger fixtures), `backfillWithOembed`.
