# Plan 037: Auto-run the tweet-body render once — retire the manual "Render X tweet bodies" command to a migration fallback

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything under "STOP conditions" occurs, stop and report — do
> not improvise. When done, update the status row in `plans/README.md`.

## Base setup (do this FIRST — not optional)

You are in **/tmp/roost-merge**. Branch off the integrated **`deploy-all`** line
(here the local branch is **`local/deploy-all`**, HEAD `9bcf030`, which carries
plans 031–036: the `tweetBody` renderer + backfill, the pipeline action rows,
the canonical media deep-links, and the **036 non-destructive (media-preserving)
backfill**). `node_modules` is already installed.

```bash
cd /tmp/roost-merge
git rev-parse --short local/deploy-all     # expect 9bcf030 (036 just landed)
git checkout -b advisor/037-tweetbody-autorun local/deploy-all
git rev-parse --short HEAD                  # confirm you branched off 9bcf030
ls packages/core/src/sync/tweet-body-backfill.ts   # the driver you will reuse, NOT rewrite
```

Start every shell command with `cd /tmp/roost-merge`. Do **NOT** run git
branch/checkout/commit/push beyond the branch creation above (the operator
merges).

**Drift check**: if HEAD is past `9bcf030`, run
`git diff --stat 9bcf030..HEAD -- packages/core/src/main.ts packages/core/src/settings.ts packages/core/src/sync/tweet-body-backfill.ts packages/core/src/sync/vault-writer/vault-index.ts`.
If any of those four files changed, compare the "Current state" excerpts below
against the live code before editing; on a material mismatch, STOP and report.

## Status

- **Priority**: P1 (systemic fix — makes a never-run-by-users backfill happen
  automatically; closes the audit's "backfills are manual/undiscoverable" gap)
- **Effort**: S
- **Risk**: LOW (no change to the renderer/driver/write path; pure wiring + one
  settings flag; 036 already made the underlying render non-destructive &
  idempotent)
- **Depends on**: 031 (`tweetBody` renderer + backfill) and **036** (the render
  is additive/non-destructive — this is what makes auto-running it *safe*). Both
  are on `local/deploy-all`.
- **Category**: DX / data-completeness / systemic
- **Planned at**: commit `9bcf030` (`local/deploy-all`, post-036), 2026-06-12

## Why this matters

Plan 031 added a `tweetBody` enrichment that renders every X note's body to
searchable, linkified markdown; plan 036 made that render **additive** (preserves
existing `![[…]]` media embeds) and **idempotent** (a render→extract→render
fixed-point), so re-running it can't lose data. As a result:

- **New tweets already render at sync/write time.** `writeTwitterRecord` calls
  `renderTweetBody(record, { mediaEmbeds })` and stamps
  `enrichment_v_tweetBody` (verified below). So freshly-synced tweets are already
  done — the *only* remaining work is a **one-time catch-up of the legacy notes
  that predate 031** (the audit measured **~13,407 X notes**, of which the
  pre-031 ones have an image-only / text-flattened body and no
  `enrichment_v_tweetBody` stamp).
- **That catch-up is gated behind a manual command** — "Render X tweet bodies"
  → `runTweetBodyBackfill`. A user has to know it exists, open the command
  palette, and run it. This is the exact systemic miss the pipeline audit
  flagged: **the enrichment is built and safe, but its only trigger is a hidden
  manual command, so most vaults never get it.** (036's own Maintenance notes
  tee this up: "a natural next step is to auto-run the tweetBody render … so the
  body stays current without a manual backfill.")

This plan makes the catch-up **automatic and one-time**: on plugin load, when
there are unstamped legacy tweets, run the existing backfill driver **deferred
and non-blocking**, then flip a persisted done-flag so it never runs again. The
manual command stays registered as the **migration/fallback** (re-runnable by
hand; resets via the flag if ever needed). Nothing about the renderer, the
driver, or the write path changes — this is wiring plus one settings flag.

## Decisions already made (do not re-litigate)

1. **One-time auto catch-up gated by a persisted done-flag — NOT run-on-every-sync.**
   The legacy backlog is a fixed, shrinking set; once caught up it's gone
   forever (new tweets render at write time). Running the full ~13K walk on
   every sync would be wasteful even though the cache makes it cheap. A
   `tweetBodyBackfillDone` settings flag runs it **once**, converges, and never
   touches future syncs. (This mirrors the existing one-time `welcomeCompleted`
   migration in `main.ts:166-170` and the `migrated` flag in `loadSettings`.)
2. **Deferred + non-blocking, off plugin load.** The trigger fires from a
   `window.setTimeout` in `onload()` — the same deferral the first-launch hub
   open already uses (`main.ts:174-182`) — so plugin startup and the first paint
   are never blocked. The driver is `await`ed *inside* that deferred callback,
   not on the onload path.
3. **Reuse the driver verbatim.** `runTweetBodyBackfill` already has: a
   resumable JSON cache (`.roost/cache/tweet-body-cache.json`), a module-level
   `backfillRunning` re-entrancy guard, an empty-queue early-exit Notice, and an
   idempotent per-note write (036's `newContent === existing` → no-op). We call
   it as-is. Do **NOT** edit the driver, the renderer, or the write path.
4. **Cheap "is there anything to do?" check before running.** `scanIncompleteIds`
   already computes `byCategory.tweetBody` (unstamped, non-article twitter notes)
   via the 031 predicate in `vault-index.ts:271-277`. The auto-trigger consults
   that count (or the driver's own empty-queue early-exit) so on a fully-stamped
   vault it does nothing and immediately marks the flag done.
5. **The manual command stays.** It is still registered via the `ENRICHMENTS`
   loop (`register-roost-commands.ts:68-79`) — it becomes the migration/fallback
   path for re-running by hand. Do not remove it.
6. **Default-on, no settings-tab UI.** The flag is an internal one-time marker,
   not a user preference — like `welcomeCompleted`. It defaults to `false`
   (so the catch-up runs once on first load after this ships) and flips to
   `true` after a successful run. No new toggle in `RoostSettingTab`.

## Current state (verbatim at `9bcf030`)

### The backfill driver — already cache-backed, guarded, idempotent (`sync/tweet-body-backfill.ts`)

```ts
let backfillRunning = false;

export async function runTweetBodyBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Tweet body backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
    // ...walks Bookmarks/X/*/raw.json, skips articles, consults
    //    `.roost/cache/tweet-body-cache.json` (cache[cacheKey]?.ok → cacheHits++),
    //    builds a queue, and on an empty queue:
    if (queue.length === 0) {
      new Notice(`No tweet bodies to render (${cacheHits} cache hits, ${skippedArticles} articles skipped)`);
      return;
    }
    // ...for each item: await writer.rewriteNoteBody(record);
    //    await writer.stampEnrichmentVersion(record.id, "tweetBody", …);
    //    cache[cacheKey] = { ok: true, … }
  } finally {
    backfillRunning = false;
  }
}
```

So a **second** run after a full catch-up is cheap: every note is a `cache[...].ok`
hit (`cacheHits++; return;`), the queue is empty, and it early-exits with a
Notice. (036 also guarantees that even *without* the cache, each `rewriteNoteBody`
converges to `newContent === existing` → no write.) This is the resumable cache
referenced in the goal — verified present.

The driver is exported plus its `EnrichmentDef`:

```ts
export const RENDERED_TWEET_ENRICHMENT: EnrichmentDef = {
  id: "tweetBody",
  displayName: "Tweet body",
  schemaVersion: 1,
  commandId: "backfill-tweet-bodies",
  commandName: "Render X tweet bodies",
  runBackfill: runTweetBodyBackfill,
  ...
};
```

`RENDERED_TWEET_ENRICHMENT` is in the `ENRICHMENTS` registry
(`lib/enrichments.ts:95`), so the manual command is registered by the generic
loop in `register-roost-commands.ts:68-79` — **leave that intact.**

### New tweets already render + stamp at write time (`sync/vault-writer/twitter-record-writer.ts:218-222`)

```ts
    const fmFields: Record<string, FrontmatterValue> = {
      roost_id: record.id,
      title: text.replace(/\n/g, " "),
      ...
      // Stamp at write time so freshly-synced tweets aren't re-flagged by the
      // first-rollout detection predicate in vault-index.
      [enrichmentVersionField("tweetBody")]: RENDERED_TWEET_ENRICHMENT.schemaVersion,
    };
```

Confirmed: the auto-run's job is **only** the legacy catch-up, not new tweets.

### The "is there anything to catch up?" signal (`sync/vault-writer/vault-index.ts:266-277`)

```ts
          // Tweet-body first-rollout detection. Flag X tweet notes that have
          // never had their body rendered to markdown (no enrichment_v_tweetBody
          // stamp yet). isVersionStale stays false for absent fields, so this
          // explicit predicate is what surfaces legacy tweets on first rollout.
          // X Articles are excluded (Decision 4 — they already render real md).
          if (
            fm.platform === "twitter"
            && fm.is_article !== true
            && fm[enrichmentVersionField("tweetBody")] === undefined
          ) {
            byCategory.tweetBody.add(id);
          }
```

`IncompleteByCategory.tweetBody: Set<string>` is part of the result
(`vault-index.ts:30`). Note: the driver's own queue-build already gives us a
cheaper, fs-level "anything to do?" signal (it walks `raw.json` and the cache),
so the auto-trigger does **not** need to run a full `scanIncompleteIds` itself —
the driver's empty-queue early-exit is the natural no-op. (Run the scan only if
you want a pre-check log line; see Step 3's note.)

### The onload one-time-migration + deferral patterns we mirror (`main.ts:145-183`)

```ts
  async onload() {
    await this.loadSettings();
    this.refreshLLMProvider();
    // ...adapter check, migrateRoostLayout, refreshIntegrations,
    //    registerRoostViews, registerRoostCommands, addSettingTab...

    // One-time migration: drop the legacy welcomeCompleted flag.
    if ("welcomeCompleted" in (this.settings as unknown as Record<string, unknown>)) {
      delete (this.settings as unknown as Record<string, unknown>).welcomeCompleted;
      void this.saveSettings();
    }

    // Open the hub on first launch when no platforms are configured. The 500ms
    // delay lets Obsidian's workspace settle before we open a new leaf.
    window.setTimeout(() => {
      const hasAnyPlatform = ...;
      if (!hasAnyPlatform) { void this.ws().activateHubLeaf(); }
    }, 500);
  }
```

Two reusable patterns here: (a) a **one-time settings-gated** side effect, and
(b) a **deferred `window.setTimeout`** that doesn't block startup. The auto-run
combines both. `this.settings` and `this.saveSettings()` are in scope; the
concrete `RoostPlugin` satisfies `IRoostPlugin`, so it can be passed straight to
`runTweetBodyBackfill(this)`.

### The settings shape + the existing one-time flag conventions (`settings.ts:27-122`)

`RoostSettings` is a flat interface with a matching `DEFAULT_SETTINGS`. There is
**no** per-enrichment auto/done-flag pattern yet (the only persisted backfill
toggle is `fastSyncMode`, an opt-out for *sync-time* enrichment — a different
axis). `loadSettings` (`main.ts:261-271`) does `Object.assign({}, DEFAULT_SETTINGS, raw)`,
so a new field with a default is backfilled onto existing `data.json` files
automatically. This is where `tweetBodyBackfillDone` lives.

## Commands

| Purpose   | Command                                  | Expected                                  |
|-----------|------------------------------------------|-------------------------------------------|
| Baseline  | `cd /tmp/roost-merge && npm test 2>&1 \| tail -3` | record the passing count BEFORE you start (≈ **1165 passed**) |
| Typecheck | `npm run typecheck`                      | exit 0, no output                         |
| Tests     | `npm test`                               | all pass (≥ your recorded baseline)       |
| Filter    | `npm test -- tweet-body-autorun`         | the new decision-fn test passes           |

Conventions: `strictNullChecks` + `noImplicitAny` (not full strict); `@/` alias
→ `packages/core/src/`; frontmatter only via `buildFrontmatter` /
`updateNoteFrontmatter` (not touched here). `npm run lint` is advisory (no CI
gate). Do **not** run `npm run test:e2e` (slow) unless asked.

## Scope

**In scope** (modify only these):

- `packages/core/src/settings.ts` — add `tweetBodyBackfillDone: boolean` to
  `RoostSettings` + `DEFAULT_SETTINGS` (default `false`).
- `packages/core/src/sync/tweet-body-backfill.ts` — add a small **pure decision
  function** `shouldAutoRunTweetBodyBackfill(done)` and a thin
  `maybeAutoRunTweetBodyBackfill(plugin)` orchestrator that runs the existing
  driver once and flips the flag. (Do NOT touch `runTweetBodyBackfill`'s body.)
- `packages/core/src/main.ts` — call `maybeAutoRunTweetBodyBackfill(this)` from a
  deferred `window.setTimeout` in `onload()`.
- `packages/core/src/types/plugin.ts` — only if the orchestrator needs a
  plugin field not already on `IRoostPlugin` (it should NOT — `app`, `settings`,
  `saveSettings`, `fireLog` are all present; verify and leave untouched).
- A new test: `packages/core/src/sync/__tests__/tweet-body-autorun.test.ts`
  (the pure decision fn + the flag-flip orchestration, mocking the driver).
- `plans/README.md` — status row.

**Out of scope** (do NOT touch):

- `sync/tweet-body-backfill.ts`'s `runTweetBodyBackfill` body, the
  `tweet-render.ts` renderer, and `note-file-writer.ts` / `twitter-record-writer.ts`
  (036 owns those; the auto-run reuses them).
- The manual command registration (`register-roost-commands.ts`,
  `lib/enrichments.ts`) — the command stays.
- `vault-index.ts` scan predicate — read-only here.
- `RoostSettingTab` UI — no toggle (Decision 6).
- The sync flow (`run-platform-sync.ts`, `use-roost-platform-sync.ts`) — the
  trigger is plugin-load, not sync-end (Decision 1/2; a sync-end trigger is the
  rejected alternative — see Maintenance notes).

## Steps

### Step 1: Add the one-time done-flag to settings

In `packages/core/src/settings.ts`:

1. Add to the `RoostSettings` interface (near the other flat fields, e.g. after
   `fastSyncMode`):
   ```ts
   /** Internal one-time marker: has the legacy tweet-body catch-up run? New
    *  tweets render at write time (twitter-record-writer); this flag gates the
    *  ONE-TIME auto catch-up of pre-031 legacy notes on plugin load. Set true
    *  after a successful auto-run so it never repeats. Not a user preference —
    *  no settings-tab toggle (mirrors the old welcomeCompleted marker). Reset to
    *  false by hand in data.json to force a re-run; the manual "Render X tweet
    *  bodies" command is the always-available fallback. */
   tweetBodyBackfillDone: boolean;
   ```
2. Add to `DEFAULT_SETTINGS`:
   ```ts
   tweetBodyBackfillDone: false,
   ```

`loadSettings`'s `Object.assign({}, DEFAULT_SETTINGS, raw)` backfills `false`
onto every existing `data.json`, so on the first launch after this ships, every
current user gets exactly one catch-up.

**Verify:** `npm run typecheck` → exit 0.

### Step 2: Add the pure decision fn + the auto-run orchestrator

In `packages/core/src/sync/tweet-body-backfill.ts`, **below** the existing
`runTweetBodyBackfill` (do not modify that function), add:

```ts
/** Pure: should the one-time legacy tweet-body catch-up run on this load?
 *  Today it's just "not done yet", but keeping it a named predicate makes the
 *  trigger condition unit-testable and the call site self-documenting. */
export function shouldAutoRunTweetBodyBackfill(done: boolean | undefined): boolean {
  return done !== true;
}

/** One-time, deferred, non-blocking auto catch-up of legacy tweet bodies.
 *  Runs the existing backfill driver at most once per vault, then persists a
 *  done-flag so it never repeats. Safe to call on every plugin load: it
 *  early-exits when the flag is set. The driver itself is cache-backed,
 *  re-entrancy-guarded, and idempotent (plan 036), so even a forced re-run is
 *  a converging no-op. Errors are swallowed (logged) — a failed catch-up must
 *  never break plugin load, and the flag is NOT set on failure so the next
 *  load retries. */
export async function maybeAutoRunTweetBodyBackfill(plugin: IRoostPlugin): Promise<void> {
  if (!shouldAutoRunTweetBodyBackfill(plugin.settings.tweetBodyBackfillDone)) return;
  try {
    plugin.fireLog("[tweet-body-autorun] one-time legacy catch-up starting");
    await runTweetBodyBackfill(plugin);
    plugin.settings.tweetBodyBackfillDone = true;
    await plugin.saveSettings();
    plugin.fireLog("[tweet-body-autorun] done — flag set, will not re-run");
  } catch (e: unknown) {
    plugin.fireLog(
      "[tweet-body-autorun] failed (will retry next load): " +
        (e instanceof Error ? e.message : String(e)),
    );
  }
}
```

Notes:
- The flag is set **only after** `runTweetBodyBackfill` resolves — so a crash
  mid-run leaves `done=false` and the next load retries, while the driver's own
  resumable cache means the retry skips everything already rendered.
- The driver shows its own Notices (queue size / "No tweet bodies to render" /
  final summary). On a fully-stamped vault the user sees the brief "No tweet
  bodies to render …" Notice once, then never again. That is acceptable and
  honest; if the operator prefers total silence on the empty case, see the STOP
  note about a `suppressNotice` option (do not add one without asking).
- `IRoostPlugin` already exposes `app`, `settings`, `saveSettings()`,
  `fireLog()` — confirm with
  `grep -n "saveSettings\|fireLog\|settings" packages/core/src/types/plugin.ts`;
  no type change needed.

**Verify:** `npm run typecheck` → exit 0.

### Step 3: Trigger it from a deferred timer in `onload`

In `packages/core/src/main.ts`:

1. Add the import near the other plugin imports:
   ```ts
   import { maybeAutoRunTweetBodyBackfill } from "@/sync/tweet-body-backfill";
   ```
2. In `onload()`, **after** the existing first-launch hub `window.setTimeout`
   block (after line 182), add a second deferred timer. Use a longer delay so it
   runs well after first paint and after the hub-open settle, and never competes
   with startup:
   ```ts
   // One-time, non-blocking catch-up: render the body of every legacy X note
   // that predates the tweetBody enrichment (plan 031). New tweets already
   // render at write time; this only touches the pre-031 backlog, runs once
   // (gated by settings.tweetBodyBackfillDone), and is idempotent (plan 036).
   // Deferred so plugin load / first paint are never blocked.
   window.setTimeout(() => {
     void maybeAutoRunTweetBodyBackfill(this);
   }, 4000);
   ```
   (The exact delay isn't load-bearing — any deferral that lets the workspace
   settle is fine; 4 s keeps it clear of the 500 ms hub-open.)

Rationale for plugin-load over sync-end: the catch-up must happen even for users
who rarely sync, and it must happen exactly once — a sync-end hook would re-fire
on every sync and only for users who sync. The done-flag + load trigger gives a
guaranteed single run. (If a pre-run log of the backlog size is wanted, the
orchestrator could call `new VaultWriter(...).scanIncompleteIds()` and log
`byCategory.tweetBody.size` before running — optional; the driver already logs
its queue size, so this is redundant. Skip it unless asked.)

**Verify:** `npm run typecheck` → exit 0; `npm run build` → exit 0 (the new
import resolves into the bundle).

### Step 4: Tests

Add `packages/core/src/sync/__tests__/tweet-body-autorun.test.ts`. Keep it a
**unit** test of the decision fn + the orchestrator's flag-flip contract — do
NOT drive the real fs walk (that's the driver's territory, already covered by
036's tests). Mock the driver module so the orchestrator's wiring is what's under
test.

```ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy driver so the orchestrator wiring is isolated. We import the
// orchestrator + pure fn AFTER declaring the mock.
vi.mock("@/sync/vault-writer", () => ({ VaultWriter: class {} })); // if the import graph needs it; remove if unused
```

The cleaner approach (preferred, avoids mock-ordering pitfalls): make the
orchestrator call `runTweetBodyBackfill` via the module's own export so
`vi.spyOn` works, OR — simplest — test the **pure** `shouldAutoRunTweetBodyBackfill`
directly and test the orchestrator with a fake plugin whose `runTweetBodyBackfill`
is intercepted. Concretely:

- **Pure decision fn**:
  ```ts
  import { shouldAutoRunTweetBodyBackfill } from "@/sync/tweet-body-backfill";
  expect(shouldAutoRunTweetBodyBackfill(undefined)).toBe(true);  // fresh vault
  expect(shouldAutoRunTweetBodyBackfill(false)).toBe(true);      // not done
  expect(shouldAutoRunTweetBodyBackfill(true)).toBe(false);      // already done → skip
  ```
- **Orchestrator flips the flag once** — use `vi.spyOn` on the module's
  `runTweetBodyBackfill` export (or restructure so the driver is injectable):
  ```ts
  import * as backfill from "@/sync/tweet-body-backfill";
  const runSpy = vi.spyOn(backfill, "runTweetBodyBackfill").mockResolvedValue();
  const plugin = makeFakePlugin({ tweetBodyBackfillDone: false });
  await backfill.maybeAutoRunTweetBodyBackfill(plugin);
  expect(runSpy).toHaveBeenCalledTimes(1);
  expect(plugin.settings.tweetBodyBackfillDone).toBe(true);
  expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
  ```
  where `makeFakePlugin` is a tiny object literal: `{ settings: { tweetBodyBackfillDone },
  saveSettings: vi.fn(async () => {}), fireLog: vi.fn() } as unknown as IRoostPlugin`.
- **Second call no-ops** (respects the flag): after the first run set
  `plugin.settings.tweetBodyBackfillDone = true`, clear the spy, call again →
  `runSpy` NOT called, `saveSettings` NOT called.
- **Failure leaves the flag false** (retry next load): make the spy
  `mockRejectedValueOnce(new Error("boom"))` → after `await`,
  `plugin.settings.tweetBodyBackfillDone` is still `false`, `saveSettings` NOT
  called, and `fireLog` saw a "failed" line. (The orchestrator must not throw.)

> If `vi.spyOn(backfill, "runTweetBodyBackfill")` can't intercept the in-module
> call (ESM live-binding can prevent spying on a function the module calls
> internally), refactor the orchestrator to take the driver as an optional
> injected param defaulting to the real one — e.g.
> `maybeAutoRunTweetBodyBackfill(plugin, run = runTweetBodyBackfill)` — and pass
> a fake in the test. That keeps the production call site identical
> (`maybeAutoRunTweetBodyBackfill(this)`) and makes the wiring cleanly testable.
> Choose whichever the test env supports; the **behavioral assertions above are
> the contract**, the injection is an implementation detail.

**Verify:** `npm test -- tweet-body-autorun` passes; full `npm test` ≥ baseline.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0 with **≥ the baseline** count recorded at Step 0
      (baseline ≈ 1165; +~4 new tests).
- [ ] `npm run build` exits 0 (the new import resolves).
- [ ] `grep -n "tweetBodyBackfillDone" packages/core/src/settings.ts` → present
      in both the interface and `DEFAULT_SETTINGS` (default `false`).
- [ ] `grep -n "shouldAutoRunTweetBodyBackfill\|maybeAutoRunTweetBodyBackfill" packages/core/src/sync/tweet-body-backfill.ts`
      → both the pure fn and the orchestrator exist.
- [ ] `grep -n "maybeAutoRunTweetBodyBackfill" packages/core/src/main.ts` →
      called inside a `window.setTimeout` in `onload()`.
- [ ] `git diff 9bcf030..HEAD -- packages/core/src/sync/tweet-body-backfill.ts | grep -n "runTweetBodyBackfill(plugin: IRoostPlugin)"`
      → the original `runTweetBodyBackfill` signature/body is **unchanged**
      (only additions below it).
- [ ] `grep -n "backfill-tweet-bodies\|Render X tweet bodies" packages/core/src/sync/tweet-body-backfill.ts`
      → the manual command's `EnrichmentDef` is **still present** (fallback kept).
- [ ] The new test proves: decision fn truth table; orchestrator runs once + sets
      the flag + saves; second call no-ops; a failed run leaves the flag `false`
      and does not throw.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The cited excerpts don't match the live code (drift) — re-read and report.
- `IRoostPlugin` is missing any of `app` / `settings` / `saveSettings` /
  `fireLog` (the orchestrator needs them) — report rather than widening the
  interface unexpectedly.
- `vi.spyOn` cannot intercept the in-module `runTweetBodyBackfill` call AND the
  injected-param refactor would change the production call site — STOP and ask
  (the contract is "one-time, flag-gated, non-throwing"; don't ship an untested
  orchestrator).
- The auto-run would block plugin load (e.g. it's `await`ed on the onload path
  instead of inside the deferred timer) — that's a regression; keep it deferred.
- Running the empty-vault case fires more than the driver's one "No tweet bodies
  to render" Notice, or the trigger fires on a vault where the flag is already
  `true` — the flag gate or early-exit is wrong; fix before proceeding.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **What changed vs. what didn't.** This plan adds *only* a trigger + a flag.
  The renderer (031), the additive/idempotent render (036), the driver, the
  cache, the re-entrancy guard, and the manual command are all unchanged and
  reused. That's why the risk is LOW despite touching plugin load.
- **The flag is a one-time marker, not a preference.** It has no settings-tab
  UI (Decision 6), mirroring `welcomeCompleted`. To force a re-run (e.g. after a
  future `tweetBody` schemaVersion bump), flip `tweetBodyBackfillDone` to `false`
  in `data.json` — or just run the manual "Render X tweet bodies" command, which
  is always available and bypasses the flag entirely.
- **Convergence guarantee.** New tweets render+stamp at write time
  (`twitter-record-writer.ts`); the legacy backlog is fixed and only shrinks.
  After the single auto-run, `byCategory.tweetBody` should be ~0 on a healthy
  vault (only brand-new-since-scan items, which the next sync stamps). The
  manual command remains the catch-all if the cache or flag ever desyncs.
- **Rejected alternative — run on every sync-end.** Hooking `handleSync` /
  `runPlatformSync` after completion would (a) re-fire on every sync, (b) only
  help users who actually sync, and (c) couple the catch-up to the sync path.
  The load-time + done-flag approach runs exactly once for *every* user,
  sync-or-not. If a future need arises to keep bodies fresh against a
  schemaVersion bump, prefer bumping `schemaVersion` + resetting the flag (a
  controlled one-shot) over an every-sync pass.
- **Reviewer focus in the PR:** (1) the trigger is inside a `window.setTimeout`,
  not on the onload critical path; (2) the flag is set **after** a successful
  run, never on failure (retry-on-next-load); (3) `runTweetBodyBackfill`'s body
  is byte-unchanged (diff it); (4) the manual command is still registered; (5)
  the orchestrator never throws out of the deferred callback.
