# Plan 009: Guard the rest_id cast in thread rendering so a missing id degrades gracefully

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1671710..HEAD -- packages/core/src/sync/vault-writer.ts`
> If it changed since this plan was written, compare the excerpt below against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (replaces an unchecked cast with a checked fallback to a value
  the rest of the code already treats as the item's id)
- **Depends on**: none
- **Category**: bug (correctness)
- **Planned at**: commit `1671710`, 2026-06-10

## Why this matters

In the X thread-rendering path, the focal tweet id is taken with an unchecked
cast: `const focalId = record.rawData.rest_id as string;`. If `rawData.rest_id`
is absent (e.g. a record normalized only from `legacy.id_str`, or malformed
captured data), `focalId` becomes `undefined`. It's then compared against each
segment's id to mark the focal tweet (`seg.rest_id === focalId`), so **no
segment is ever recognized as focal** — the thread's cover/focal handling
silently breaks, with no error. The record already carries the correct id in
`record.itemId` (for twitter, normalization sets `itemId` from
`rest_id || legacy.id_str`), so the fix is to fall back to it and log when the
cast would have been undefined.

## Current state

```ts
// packages/core/src/sync/vault-writer.ts:484-490 (inside private renderThreadPages)
    const { record, attachFolder, handle, username, mainThread, quotedThread, skipIfExists } = opts;
    const focalId = record.rawData.rest_id as string;        // <-- unchecked cast

    // If main wasn't enriched but quoted was, synthesize a single main segment from the focal tweet.
    const mainSegments: ThreadSegment[] = mainThread.length > 0
      ? mainThread
      : [{ rest_id: focalId, raw: record.rawData }];
```
```ts
// vault-writer.ts:504 — focalId is used here to mark the focal segment
      const isFocal = seg.rest_id === focalId;
```

Supporting facts (context — do NOT edit these files):
- `NormalizedRecord` (`packages/core/src/lib/normalize.ts:13-22`) has
  `itemId: string` and `rawData: RawApiData`.
- Normalization sets `itemId` from the tweet id:
  `packages/core/src/lib/normalize.ts:67` —
  `const itemId = tweet?.rest_id || item?.rest_id || item?.legacy?.id_str;`
  So `record.itemId` IS the focal tweet id when `rawData.rest_id` is absent.
- `this.log` is the VaultWriter logger (set in the constructor); other methods
  use it for `[slow]`, `[resync-err]`, etc.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| All tests | `npm test` | 953+ pass (baseline at `1671710`) |

## Scope

**In scope** (the only file you should modify):
- `packages/core/src/sync/vault-writer.ts`

**Out of scope** (do NOT touch):
- `packages/core/src/lib/normalize.ts`, `extract.ts` — the normalization that
  populates `itemId` is correct; don't change the source of the fallback.
- Any other `as` cast in vault-writer.ts — only the `rest_id` cast at line 485
  is in scope.
- The thread-segment rendering logic below line 490 — only the `focalId`
  derivation changes; its downstream use is already correct.

## Git workflow

- Branch: `advisor/009-guard-rest-id-cast`
- Commit style: `fix(sync): fall back to itemId when rawData.rest_id is missing in thread render`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the unchecked cast with a checked fallback + log

In `renderThreadPages` (vault-writer.ts ~line 485), replace:

```ts
    const focalId = record.rawData.rest_id as string;
```

with:

```ts
    const rawRestId = record.rawData.rest_id;
    const focalId = typeof rawRestId === "string" && rawRestId ? rawRestId : record.itemId;
    if (focalId !== rawRestId) {
      this.log(`[thread] ${record.id}: rawData.rest_id missing/invalid — using itemId ${record.itemId} as focal id`);
    }
```

(`focalId` stays a `string`; the synthesized segment at line ~490 and the
`isFocal` comparison at line ~504 are unchanged and now never compare against
`undefined`.)

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "rest_id as string" packages/core/src/sync/vault-writer.ts` → no matches
- `grep -n "record.itemId" packages/core/src/sync/vault-writer.ts` → at least the new line appears

### Step 2: Full suite

**Verify**: `npm test` → all pass (953+)

## Test plan

`renderThreadPages` is a private method on the network/thread-coupled X write
path, reached only through `writeTwitterRecord` with assembled thread data, so a
focused unit test would require a large fixture and is out of proportion for
this one-line guard. **Do not invest in a brittle harness for it.** Verification
is: typecheck passes, the full existing suite stays green, and the grep checks
confirm the cast is gone and the fallback is present. If you find a cheap,
existing seam that already constructs a `renderThreadPages`-reachable record
(search `__tests__` for `renderThreadPages` or `writeTwitterRecord`), you may
add a small test asserting the missing-`rest_id` case falls back to `itemId`;
otherwise skip it — do not build new fixtures.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (953+ pass; no regressions)
- [ ] `grep -n "rest_id as string" packages/core/src/sync/vault-writer.ts` → no matches
- [ ] The new code logs when it falls back (a `this.log(...[thread]...)` line exists near the focalId derivation)
- [ ] Only `packages/core/src/sync/vault-writer.ts` changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpt at lines 484–490 doesn't match the live code (drift).
- `record.itemId` is not in scope / not a `string` where you need it (it should
  be, per `NormalizedRecord`) — report what you see.
- Removing the cast surfaces a type error you can't resolve within this one
  file without weakening types elsewhere.

## Maintenance notes

- This pairs with plan 006's characterization tests (now in `main`): if the
  twitter write path ever gets a unit harness, add the missing-`rest_id` case
  there.
- Reviewer focus: confirm `record.itemId` is truly the focal tweet's id for the
  records that reach `renderThreadPages` (it is for normally-synced tweets;
  the log line makes any surprising fallback visible in the sync log).
- Other `as`/`any` casts in vault-writer.ts (e.g. the `getRaw() as any` around
  line 1126) were considered and left alone — they have runtime guards; don't
  expand scope to them here.
