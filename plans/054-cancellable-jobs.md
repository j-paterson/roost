# Plan 054: Cancellable heavy jobs — abort a running/queued pipeline or backfill from the hub

> **Executor instructions**: Follow step by step; run every verification command
> and confirm its expected result before moving on. On a "STOP conditions" item,
> stop and report. When done, update this plan's row in `plans/README.md` unless
> a reviewer told you they maintain it.
>
> **Drift check (run first)**:
> `git diff --stat ae7335a..HEAD -- packages/core/src/lib/job-queue.ts packages/core/src/main.ts packages/core/src/pipeline/run-category-pipeline.ts packages/core/src/pipeline/shared.ts packages/core/src/lib/enrichments.ts packages/core/src/ui/hub`
> Compare "Current state" excerpts to live code; on mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: M–L
- **Risk**: MED (touches the serial job queue + the generic pipeline runner)
- **Depends on**: none structurally. Highest value alongside `plans/052-*` (auto-enqueued runs are
  the main thing a user will want to cancel). Can land before or after 052.
- **Category**: direction (feature)
- **Planned at**: commit `ae7335a`, 2026-06-15

## Why this matters

Heavy jobs (sync, data backfills, category-pipeline runs) go through the serial `RoostJobQueue`
(`plugin.runJob`). A pipeline run over a large vault is LLM-bound and can take many minutes. Today
there is **no way to stop one** — the only "cancel" is quitting Obsidian. Now that pipelines
auto-enqueue after Smart Assign (plan 052), the user needs a real cancel: a control in the hub that
aborts the running job (and clears anything queued behind it). `BackfillOpts` already carries an
optional `signal?: AbortSignal` (`enrichments.ts:37`) but nothing creates or honors it. This plan
makes the queue own an `AbortController` per job, threads the signal into the pipeline runner so it
stops between batches, and surfaces a Cancel control in the hub.

## Current state

- `packages/core/src/lib/job-queue.ts` — `RoostJobQueue` (full file is ~98 lines). `enqueue<T>(label, fn: () => Promise<T>)`
  (49-73) wraps `fn` in a `QueuedJob` and calls `drain()` (75-96). `isBusy()` (31-33),
  `currentLabel()` (36-38), `onIdle()` (42-45). A throwing job is captured into an outcome and does
  not wedge the queue; `drain()` clears `running` BEFORE settling. **No cancel, no AbortController,
  no change event.**
- `packages/core/src/main.ts` — `runJob<T>(label, fn)` (132-137):
  `return this.jobQueue.enqueue(label, () => runJobWithBulkWriteFlag(this, fn));`. The queue is
  `readonly jobQueue = new RoostJobQueue()` (81). `triggerHubStateChange()` (307) fires
  `roost:hub-state-changed`.
- `packages/core/src/lib/enrichments.ts:35-39` — `BackfillOpts { filter?; signal?: AbortSignal; onLog? }`.
- The 7 pipeline `runBackfill` drivers ignore `opts.signal`. Recipe (recipe-pipeline.ts:488-498):
  ```ts
  runBackfill: async (plugin, opts) => {
    const vault = plugin.app.vault;
    const existing = loadPipelineCache<CacheEntry>(vault, CACHE_FILE);
    if (Object.keys(existing).length === 0) { /* reconstruct */ }
    await runRecipePipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog);
  },
  ```
- `packages/core/src/pipeline/run-category-pipeline.ts` — `runCategoryPipeline(app, syncFolder, config, onLog)`
  (108). Heavy work runs inside two `forEachBatch(...)` loops: triage (180-202) and extract
  (214-245). `forEachBatch` is `shared.ts:405-413`:
  ```ts
  export async function forEachBatch<T>(items, size, fn): Promise<void> {
    for (let i = 0; i < items.length; i += size) { await fn(items.slice(i, i + size), i); }
  }
  ```
- The hub does **not** surface job-queue state anywhere (grep for `jobQueue` in `ui/` returns
  nothing). So the Cancel control is new; the queue must notify the hub to re-render.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Tests | `npm test` | all pass |
| Build | `npm run build` | dist artifacts |

## Scope

**In scope** (modify):
- `packages/core/src/lib/job-queue.ts` — AbortController per job; `cancelCurrent()` / `cancelAll()`;
  pass the signal to `fn`; `onChange` notify hook.
- `packages/core/src/main.ts` — thread the signal through `runJob`; set `jobQueue.onChange`;
  add `cancelCurrentJob()` / expose on `IRoostPlugin`.
- `packages/core/src/types/plugin.ts` — `runJob` signature (signal arg), `cancelCurrentJob()`.
- `packages/core/src/pipeline/run-category-pipeline.ts` — accept + honor a signal between batches.
- `packages/core/src/pipeline/shared.ts` — `forEachBatch` optional `signal` that stops iteration.
- The 7 pipeline `runBackfill` drivers + their `run*Pipeline` exports — pass `opts?.signal` through.
- `packages/core/src/ui/hub/state.ts`, `use-hub-state.ts`, and one hub component
  (`global-action-bar.tsx` or a small new `running-job-bar.tsx`) — surface `jobBusy` + `jobLabel`
  + a Cancel button.
- `__tests__/` for the queue and the runner.

**Out of scope**:
- Cancelling mid-*item* (we cancel between batches — an in-flight LLM call for the current batch
  finishes; that is acceptable and avoids partial-write corruption).
- Making the data backfills (media/thread/article/tweetBody/playback/transcript) honor the signal
  mid-run — they will still be cancellable at the queue boundary (the signal aborts; their next
  natural check, if any, stops them) but threading the signal into each is a follow-up. Note it,
  don't build it.
- A per-queued-job cancel UI (cancel only the current job + "clear queue" is enough for v1).
- Pause/resume.

## Git workflow

- Branch: `advisor/054-cancellable-jobs`
- Conventional commits, e.g. `feat(jobs): cancellable heavy jobs + hub Cancel control`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: AbortController + cancel + change-notify in `RoostJobQueue`

- Add `controller: AbortController` to `QueuedJob`. In `enqueue`, create it and pass its `signal`
  to `fn`: change the signature to
  `enqueue<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T>` and call
  `fn(job.controller.signal)` inside `run`. (Existing callers that pass `() => ...` keep working —
  the extra arg is ignored.)
- Add `private onChangeCb: (() => void) | null = null; set onChange(cb) { this.onChangeCb = cb; }`
  and call `this.onChangeCb?.()` whenever busy-state transitions: after pushing in `enqueue`, when
  a job starts in `drain`, and when the queue drains. (One helper `private notify()` called at
  those points.)
- Add `cancelCurrent(): void` → `this.running?.controller.abort();` (the running fn's signal fires;
  the captured-outcome path still settles it, so the queue keeps draining). Add `cancelAll(): void`
  → abort running AND drain the pending `queue`, settling each removed job with a rejection/aborted
  outcome so its enqueuer promise settles (do not leave dangling promises); then `notify()`.
- Preserve the existing invariants: a throwing/aborted job never wedges the queue; `onIdle()` still
  resolves after the last job; `drain()` clears `running` before settling.

**Verify**: `npm run typecheck` → exit 0; the existing job-queue test still passes.

### Step 2: thread the signal through `runJob`

In `main.ts`, change `runJob` to forward the queue's signal into `fn`:
```ts
runJob<T>(label: string, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  return this.jobQueue.enqueue(label, (signal) => runJobWithBulkWriteFlag(this, () => fn(signal)));
}
```
Update the `IRoostPlugin.runJob` type (`types/plugin.ts`) to `fn: (signal?: AbortSignal) => Promise<T>`.
Set `this.jobQueue.onChange = () => this.triggerHubStateChange();` once in `onload` (or the
constructor). Add `cancelCurrentJob(): void { this.jobQueue.cancelCurrent(); }` and expose it on
`IRoostPlugin`. (Existing `runJob` callers that pass `() => ...` are unaffected.)

**Verify**: `npm run typecheck` → exit 0.

### Step 3: honor the signal in the pipeline runner

- `shared.ts`: `forEachBatch<T>(items, size, fn, signal?: AbortSignal)` — at the top of the loop,
  `if (signal?.aborted) return;` so iteration stops between batches.
- `run-category-pipeline.ts`: add a `signal?: AbortSignal` parameter to `runCategoryPipeline`
  (after `onLog`). Pass it into both `forEachBatch` calls. Also add a guard at the start of the
  extract loop body and triage loop body: `if (signal?.aborted) return;`. After the loops, if
  `signal?.aborted`, still run `config.buildResult` on what completed and log a "cancelled" note —
  do NOT throw (a clean stop; per-batch cache saves already persisted partial progress, which is
  safe and resumable via cache-presence).
- Thread the signal through each `run*Pipeline` export (e.g.
  `runRecipePipeline(app, syncFolder, onLog?, signal?)`) and each `runBackfill` driver:
  `await runRecipePipeline(plugin.app, plugin.settings.syncFolder, opts?.onLog, opts?.signal);`.
  Do this for all 7 pipelines.

**Verify**: `npm run typecheck` → exit 0; `npm test` → existing pipeline tests pass (signal is
optional, so default behavior is unchanged).

### Step 4: hub Cancel control

- `state.ts`: add `jobBusy: boolean; jobLabel: string | null;` to `HubInputs`, and to
  `HubState.global` a `runningJob: { label: string } | null`. Derive it in `deriveHubState`.
- `use-hub-state.ts` `gatherInputs`: `jobBusy: plugin.jobQueue.isBusy(), jobLabel: plugin.jobQueue.currentLabel()`.
  (The `onChange → triggerHubStateChange` from Step 2 drives re-render.)
- Add a small control (extend `global-action-bar.tsx`, or a new `running-job-bar.tsx` rendered by
  `hub-body.tsx`) shown only when `state.global.runningJob`: it displays the label
  (e.g. "Running: Run Recipe extraction pipeline") and a **Cancel** button calling
  `plugin.cancelCurrentJob()`. Use the existing `Button` component
  (`@/ui/components/ui/button`) for consistency.
- Treat an aborted run as a clean cancel: ensure the manual `runAllPipelines` / auto-enqueue paths
  don't pop an error `Notice` when a job rejects due to abort (catch and ignore an abort outcome, or
  have the runner not throw per Step 3 so the promise resolves normally).

**Verify**: `npm run typecheck` → exit 0; `npm test` → hub tests pass; `npm run build` → succeeds.

## Test plan

- **`packages/core/src/lib/__tests__/job-queue.test.ts`** (extend the existing one): 
  (a) `cancelCurrent()` aborts the running job's signal (the fn observes `signal.aborted`);
  (b) a cancelled job still lets the next queued job run (no wedge);
  (c) `cancelAll()` settles every queued enqueuer promise and the queue ends idle;
  (d) `onIdle()` still resolves after a cancel;
  (e) `onChange` fires on enqueue/start/drain.
- **`packages/core/src/pipeline/__tests__/run-category-pipeline.test.ts`** (extend): a config whose
  `triageItem` aborts the signal after the first batch → the runner stops, processes no further
  batches, and `buildResult` reflects only the completed work (no throw).
- Verification: `npm test` → all pass incl. new cases; `npm run typecheck` → exit 0.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; new queue-cancel + runner-abort tests pass
- [ ] `npm run build` produces dist artifacts
- [ ] `grep -n "cancelCurrent" packages/core/src/lib/job-queue.ts` and
      `grep -rn "cancelCurrentJob" packages/core/src/ui` both match (wired end-to-end)
- [ ] No files outside scope modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Changing `enqueue`/`runJob` signatures breaks an existing caller that the type system flags and
  the fix is not a trivial extra optional arg — report the call site.
- Honoring the signal in `runCategoryPipeline` would require restructuring the batch loops in a way
  that changes non-cancelled behavior — report.
- The hub has no obvious render seam for the Cancel control without a larger refactor — report
  what you found; a minimal always-mounted bar gated on `jobBusy` is acceptable.
- A cancelled run leaves a pipeline cache in an inconsistent state (it must not — per-batch saves
  are atomic and resumable) — STOP and report.

## Maintenance notes

- Cancel granularity is **between batches**, so the current in-flight batch's LLM calls complete.
  That keeps cache writes consistent and the run resumable (cache-presence). Do not try to cancel
  mid-item.
- Data backfills (media/thread/article/tweetBody/playback/transcript) are NOT yet signal-aware
  mid-run; they only stop at the queue boundary. Threading `opts.signal` into them is a clean
  follow-up using the same `forEachBatch(..., signal)` pattern.
- Reviewer should scrutinize: queue invariants under cancel (no wedge, `onIdle` resolves,
  `cancelAll` settles every enqueuer promise) and that an aborted run does not surface as an error.
- Pairs with plan 052: a cancelled auto-enqueued run leaves residual pending work, which 052's
  badge shows correctly on the next `refreshPendingPipelines`.
