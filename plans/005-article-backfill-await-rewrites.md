# Plan 005: Await article-backfill note rewrites instead of sleeping 15 seconds

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 719d54a..HEAD -- packages/core/src/sync/article-backfill.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (the change converts fire-and-forget to awaited completion;
  failure handling and counters keep their semantics)
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `719d54a`, 2026-06-10

## Why this matters

The X article-backfill command rewrites vault note bodies via fire-and-forget
promises in two places, then waits a **fixed 15 seconds** before printing its
summary and finishing. Consequences:

- On a vault where rewrites take longer than 15s (large vaults, slow/cloud
  storage), the command reports completion while `vault.modify` calls are
  still in flight; quitting Obsidian then loses them, and the printed
  `refreshed` count is whatever happened to have settled by the deadline.
- On a fast vault, every run wastes up to 15 seconds doing nothing.
- The `succeeded` counter in the fetch loop is incremented when the raw.json
  is persisted (correct), but the note-body rewrite for that item may still
  fail afterwards with only a log line — acceptable — or still be pending
  when the summary prints — not acceptable.

The fix is mechanical: collect the promises, `await Promise.allSettled(...)`,
delete the sleep. The code's own comment ("Wait for the fire-and-forget chain
to settle") shows the intent; this implements it correctly.

## Current state

- `packages/core/src/sync/article-backfill.ts` — the X article backfill
  command (~340 lines). Two fire-and-forget sites:

```ts
// article-backfill.ts:264-267 — inside the fetchMany onProgress callback
          writer.rewriteNoteBody(record).catch((e: unknown) => {
            log(`rewriteNoteBody failed for ${last.tweetId} (note ${outerItemId}): ${e instanceof Error ? e.message : String(e)}`);
          });
          succeeded++;
```

```ts
// article-backfill.ts:303-327 — the sweep ("step 7")
  let refreshed = 0;
  let refreshFailed = 0;
  walkDir(xRoot, (filePath) => {
    if (!filePath.endsWith("raw.json")) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
    const ar = getArticleResultFromRaw(raw);
    if (!ar?.content_state) return;
    const outerDirName = path.basename(path.dirname(filePath));
    const outerItemId = outerDirName.replace(/^twitter-/, "");
    const record = { /* id, platform: "twitter", itemId, rawData: raw, ... */ };
    writer.rewriteNoteBody(record)
      .then(() => { refreshed++; })
      .catch(() => { refreshFailed++; });
  });
  // Wait for the fire-and-forget chain to settle. Each rewriteNoteBody is a
  // single vault.modify; on a vault with 200 articles this is ~10s tops.
  await new Promise(r => setTimeout(r, 15_000));
  log(`Note body refresh: ${refreshed} updated, ${refreshFailed} failed`);
```

- The summary that must come after all rewrites settle:

```ts
// article-backfill.ts:329-331
  const summary = `Article backfill: ${succeeded} succeeded, ${failed} failed (${refreshed} note bodies refreshed)`;
  log(summary);
  new Notice(summary);
```

- `walkDir` is synchronous: `packages/core/src/lib/fs-walk.ts:14` —
  `export function walkDir(root: string, onFile: (filePath: string) => void): void`.
  So after `walkDir(...)` returns, every callback has run and every promise
  has been *created* — they just haven't settled.
- `writer` is a `VaultWriter` (`packages/core/src/sync/vault-writer.ts`);
  `rewriteNoteBody(record): Promise<void>` is its public method.
- The fetch loop's per-item raw.json persistence design (sync `fs` writes in
  `onProgress` so progress survives a mid-run kill — see the comment at
  lines 206-211) is intentional. Do not change it.
- Repo conventions: vitest unit tests in colocated `__tests__/`; the
  `obsidian` module is mocked via `vitest.config.ts` alias; `Notice` is a
  no-op class in the mock, so importing this module in tests is safe.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npm run typecheck`      | exit 0, no output   |
| This plan's tests | `npx vitest run packages/core/src/sync/__tests__/article-backfill-refresh.test.ts` | all pass |
| All tests | `npm test`               | 929+ tests pass     |

## Scope

**In scope** (the only files you should modify/create):
- `packages/core/src/sync/article-backfill.ts`
- `packages/core/src/sync/__tests__/article-backfill-refresh.test.ts` (create)

**Out of scope** (do NOT touch):
- `packages/core/src/sync/vault-writer.ts` (`rewriteNoteBody` itself).
- The sync `fs.readFileSync`/`writeFileSync` per-item persistence in the
  fetch loop — intentional durability design.
- `packages/core/src/lib/fs-walk.ts`.
- Timeout/cancellation behavior for `vault.modify` — judged not worth doing
  (see plans/README.md rejected list).

## Git workflow

- Branch: `advisor/005-article-backfill-await-rewrites`
- Commit style: `fix(sync): await article note rewrites instead of a fixed 15s sleep`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the sweep into an exported, testable function

In `article-backfill.ts`, extract the step-7 sweep (current lines ~300-327)
into a new exported function in the same file:

```ts
/** Sweep all article-bearing raw.json files under xRoot and rewrite their
 *  note bodies. Resolves only after every rewrite has settled. */
export async function refreshArticleNoteBodies(
  xRoot: string,
  writer: Pick<VaultWriter, "rewriteNoteBody">,
  log: (msg: string) => void,
): Promise<{ refreshed: number; refreshFailed: number }> {
  let refreshed = 0;
  let refreshFailed = 0;
  const pending: Promise<void>[] = [];
  walkDir(xRoot, (filePath) => {
    // ... identical body to today's callback, except the last statement:
    pending.push(
      writer.rewriteNoteBody(record)
        .then(() => { refreshed++; })
        .catch(() => { refreshFailed++; }),
    );
  });
  await Promise.allSettled(pending);
  return { refreshed, refreshFailed };
}
```

Keep the record-construction code byte-identical to today's callback. You
will need to import the `VaultWriter` type if it isn't already imported
(`import type { VaultWriter } from "./vault-writer";` — check the existing
imports first; the file already constructs/receives a writer).

At the original call site, replace the inlined sweep + `setTimeout` sleep with:

```ts
  log("Refreshing note bodies for all articles on disk...");
  const { refreshed, refreshFailed } = await refreshArticleNoteBodies(xRoot, writer, log);
  log(`Note body refresh: ${refreshed} updated, ${refreshFailed} failed`);
```

**Verify**: `npm run typecheck` → exit 0, and
`grep -n "setTimeout(r, 15_000)" packages/core/src/sync/article-backfill.ts`
→ no matches

### Step 2: Collect the fetch-loop rewrites and settle them before the summary

1. Just above the `let succeeded = 0;` declaration (~line 212), add:
   `const pendingRewrites: Promise<void>[] = [];`
2. In the `onProgress` callback (~line 264), wrap the existing call:

```ts
          pendingRewrites.push(
            writer.rewriteNoteBody(record).catch((e: unknown) => {
              log(`rewriteNoteBody failed for ${last.tweetId} (note ${outerItemId}): ${e instanceof Error ? e.message : String(e)}`);
            }),
          );
          succeeded++;
```

   (`succeeded` keeps meaning "raw.json persisted" — unchanged.)
3. Immediately before the summary (`const summary = ...`, ~line 329), add:

```ts
  await Promise.allSettled(pendingRewrites);
```

**Verify**: `npm run typecheck` → exit 0

### Step 3: Unit-test the extracted function

Create `packages/core/src/sync/__tests__/article-backfill-refresh.test.ts`.
Build a real temp directory tree with Node `fs` (vitest runs in Node; see
`packages/core/src/lib/__tests__/vault-helpers.test.ts` for the repo's test
style, and crib the minimal article raw.json shape from
`packages/core/src/lib/__tests__/article-utils.test.ts:23-33` — the shape
that makes `getArticleResultFromRaw(raw)?.content_state` truthy, e.g.
`{ article: { result: { title: "T", content_state: { blocks: [] } } } }` —
verify the exact nesting against that test file before writing fixtures).

Test cases:

1. **Resolves only after slow rewrites finish**: temp dir with 3
   `twitter-<id>/raw.json` article fixtures; fake writer whose
   `rewriteNoteBody` returns a promise resolving after 30ms. Await
   `refreshArticleNoteBodies(...)`; assert it returns
   `{ refreshed: 3, refreshFailed: 0 }` (NOT fewer — this is the regression
   the old 15s-sleep code could get wrong) and that the fake was called 3
   times with records whose `itemId` matches the directory names.
2. **Failures are counted, not thrown**: fake writer rejects for one of the 3
   ids → `{ refreshed: 2, refreshFailed: 1 }` and the returned promise
   resolves (no unhandled rejection).
3. **Non-article raw.json is skipped**: a `raw.json` without `content_state`
   → writer not called for it.

Clean up temp dirs in `afterEach` (`fs.rmSync(tmp, { recursive: true, force: true })`).

**Verify**: `npx vitest run packages/core/src/sync/__tests__/article-backfill-refresh.test.ts` → 3 pass

### Step 4: Full suite

**Verify**: `npm test` → all pass (929+ plus new)

## Test plan

Covered by Step 3. The fetch-loop change (Step 2) is not separately
unit-tested — it's exercised only through the webview-coupled command; its
correctness is structural (push + allSettled) and reviewed by diff.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; the 3 new tests exist and pass
- [ ] `grep -n "15_000" packages/core/src/sync/article-backfill.ts` → no matches
- [ ] `grep -c "allSettled" packages/core/src/sync/article-backfill.ts` → 2
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code (drift).
- `VaultWriter` cannot be imported as a type into the test without dragging
  in heavy transitive imports that crash under the obsidian mock — report
  the import error; do not restructure vault-writer.
- The raw.json fixture shape from `article-utils.test.ts` doesn't make
  `getArticleResultFromRaw(...)?.content_state` truthy — report the actual
  shape the function expects rather than reverse-engineering further.

## Maintenance notes

- If article backfill ever becomes resumable/cancellable, the
  `pendingRewrites` array is the natural place to wire a stop signal.
- Reviewer focus: the record construction inside `refreshArticleNoteBodies`
  must remain byte-identical to the old callback (especially the
  `twitter-` prefix strip and `id: \`twitter:${outerItemId}\``) — a subtle
  change there silently rewrites the wrong notes.
- Deferred: a progress callback for the sweep (200+ rewrites currently log
  nothing until done); add only if users report the silence.
