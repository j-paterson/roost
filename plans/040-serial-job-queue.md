# Plan 040: A serial job queue — run heavy jobs one-at-a-time, yield the auto catch-up to manual work

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. This plan has **two parts (Part 1 = the queue + manual routing,
> Part 2 = the auto catch-up yields)** each with its own Verify block. Part 1 is
> self-contained and shippable on its own; Part 2 depends on Part 1. If a STOP
> condition fires, stop and report — do not improvise. When done, update the
> status row in `plans/README.md`.

## Base setup (do this FIRST — not optional)

You are in **/tmp/roost-merge**. Branch off the integrated **`deploy-all`** line
(here `local/deploy-all` and `origin/deploy-all` are both at HEAD **`a1c5c10`**,
post-039 — it carries plans 031–039: the `tweetBody` renderer + the **037
one-time auto catch-up** (`maybeAutoRunTweetBodyBackfill`), the **038**
enrichment consolidation, and 039's recipe-categories single-source). There is
no local branch literally named `deploy-all`; use `local/deploy-all`.
`node_modules` is already installed.

```bash
cd /tmp/roost-merge
git rev-parse --short local/deploy-all     # expect a1c5c10 (039 just landed)
git checkout -b advisor/040-serial-job-queue local/deploy-all
git rev-parse --short HEAD                  # confirm you branched off a1c5c10
```

Start every shell command with `cd /tmp/roost-merge`. Do **NOT** run git
branch/checkout/commit/push beyond the branch creation above (the operator
merges).

**Drift check**: if HEAD is past `a1c5c10`, diff the files this plan touches and
compare the "Current state" excerpts below against the live code before editing:

```bash
git diff --stat a1c5c10..HEAD -- \
  packages/core/src/main.ts \
  packages/core/src/types/plugin.ts \
  packages/core/src/plugin/register-roost-commands.ts \
  packages/core/src/ui/hub/hub-body.tsx \
  packages/core/src/ui/hooks/use-roost-pipeline-rows.ts \
  packages/core/src/sync/tweet-body-backfill.ts
```

On a material mismatch with the excerpts below, STOP and report.

## Status

- **Priority**: P1 (correctness/robustness — prevents catastrophic vault thrash
  on network-mounted vaults; the user observed `[slow] write … 251s` /
  `[slow] resync … 100s` with a sync + recipe pipeline + media-backfill all
  running at once)
- **Effort**: M (one new ~80-line lib + its test + ~5 wiring edits; Part 2 is a
  minimal optional-param thread-through)
- **Risk**: LOW–MED. The queue itself is small and unit-tested. The wiring is
  the risk surface: it changes *when* heavy jobs run (serialized) but not *what*
  they do. The catch-up yield (Part 2) is a default-off optional param, so
  existing callers/tests are byte-unaffected.
- **Depends on**: 037 (the auto catch-up `maybeAutoRunTweetBodyBackfill` /
  `runTweetBodyBackfill` that Part 2 makes yield — already on `local/deploy-all`).
- **Category**: correctness / robustness / systemic
- **Planned at**: commit `a1c5c10` (`local/deploy-all`, post-039), 2026-06-12

## Why this matters

Roost's heavy jobs run with **no coordination whatsoever.** When a user triggers
several at once — or one while the 037 auto tweet-body catch-up is walking
~13K notes — they execute **concurrently** and thrash the vault. On a
network-mounted vault this is catastrophic: the user just observed
`[slow] write … 251s` and `[slow] resync … 100s` with a **sync + recipe pipeline
+ media-backfill all running simultaneously**.

There is **no existing queue or mutex.** The only guard is per-job module-level
`backfillRunning` re-entrancy flags (e.g.
`tweet-body-backfill.ts:36,39-42`), which only stop the **same** job from
starting twice — they do **nothing** to stop a *different* heavy job from
piling on. So a sync, a recipe pipeline run, and a media backfill happily run at
the same time, each contending for vault I/O.

This plan adds a **serial job queue**: every manually-triggered heavy job runs
one-at-a-time (FIFO), and the 037 auto catch-up **yields** to manual jobs
instead of competing with them. The result is "no concurrent heavy work" with a
minimal, well-tested core and a single high-leverage choke point for routing.

## Decisions already made (do not re-litigate)

1. **One small serial FIFO, owned by the plugin.** A new `RoostJobQueue`
   (`lib/job-queue.ts`) runs jobs one at a time. It is exposed on the plugin as
   `plugin.jobQueue` plus a `plugin.runJob(label, fn)` convenience. All manual
   heavy-job triggers route through `runJob`.
2. **The command-registration loop is the choke point.** The hub backlog buttons
   (`hub-body.tsx`'s `backfill` → `executeCommandById("roost:<commandId>")`,
   line 234-239) and the `setup-health-panel` migration rows
   (`setup-health-panel.tsx:127-141`, also `executeCommandById`) **and** Cmd+P
   all dispatch the **registered** enrichment commands. So wrapping the single
   `for (const def of ENRICHMENTS)` callback in `register-roost-commands.ts`
   covers all three at once. Wrap there first.
3. **Two more direct (non-command) call sites get wrapped too:** the hub Sync
   trigger (`hub-body.tsx`'s `runOne` → `runPlatformSync(...)`, line 91) and the
   library-tree pipeline-row run (`use-roost-pipeline-rows.ts`'s
   `enrichment.runBackfill(...)`, line 34). These do **not** go through the
   command palette, so wrapping the command loop does **not** catch them.
4. **The auto catch-up is NOT in the FIFO — it yields to it.** Putting the
   ~13K-item catch-up *inside* the queue would block manual jobs for hours.
   Instead, Part 2 threads an optional yield hook into the catch-up driver's
   per-item loop: before each item, if a manual job is queued/running, it awaits
   `plugin.jobQueue.onIdle()`. `onIdle` resolves based on **queued + running**
   manual jobs only, so a catch-up that is *not* in the queue can never deadlock
   against itself.
5. **The `backfillRunning` flags stay.** They are a harmless secondary guard
   (re-entrancy of the *same* job). Removing them is **out of scope** — leave
   them.
6. **Return/await semantics are preserved.** `runJob<T>` returns the inner fn's
   promise (same value, same rejection), so the hub's `await runPlatformSync(...)`
   that updates React state in a `finally` keeps working unchanged. A throwing
   job rejects to its enqueuer **and** the queue keeps draining (try/finally).

## Current state (verbatim at `a1c5c10`)

### There is no queue today — only per-job re-entrancy flags

`grep -rn "jobQueue\|runJob\|JobQueue\|onIdle\|isBusy" packages/core/src` →
**no hits.** The only coordination is module-level `backfillRunning`
(`sync/tweet-body-backfill.ts:36`):

```ts
let backfillRunning = false;

export async function runTweetBodyBackfill(plugin: IRoostPlugin): Promise<void> {
  if (backfillRunning) {
    new Notice("Tweet body backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
    // ...
  } finally {
    backfillRunning = false;
  }
}
```

That guard only prevents the *same* driver re-entering; it does nothing about a
*different* heavy job running at the same time.

### The command-registration choke point (`plugin/register-roost-commands.ts:68-79`)

```ts
  for (const def of ENRICHMENTS) {
    plugin.addCommand({
      id: def.commandId,
      name: def.commandName,
      callback: async () => {
        if (isPipelineEnrichmentId(def.id) && !guardPipelineActive(def.id, plugin, (msg) => new Notice(msg, 6000))) {
          return;
        }
        await def.runBackfill(plugin);
      },
    });
  }
```

`Notice` is already imported at the top of this file (`:4`). `plugin` here is a
`RoostCommandHost` (`extends IRoostPlugin, Plugin` —
`plugin/roost-command-host.ts:8`), so once `runJob` is on `IRoostPlugin` it is
in scope here.

### The hub Sync trigger (`ui/hub/hub-body.tsx:90-145`, inside `runOne`)

```ts
    try {
      await runPlatformSync({
        plugin,
        app,
        platform,
        mountTarget: target,
        signal,
        fastMode,
        onLog: log,
        onProgress: (p: SyncPhaseProgress) => { /* ...setLiveSyncs... */ },
        onBatchWritten: (b) => { /* ...setLiveSyncs... */ },
        suppressNotice: true,
      });
    } finally {
      setLiveSyncs((prev) => ({ ...prev, [platform]: null }));
      plugin.triggerHubStateChange();
    }
```

`plugin` is the `IRoostPlugin` prop of `HubBody`
(`function HubBody({ app, plugin }: { app: App; plugin: IRoostPlugin })`,
`:44`). `runPlatformSync` returns `Promise<RunPlatformSyncResult>`
(`sync/run-platform-sync.ts:69`) — the wrap must preserve that.

### The hub backlog button dispatches the registered command (`ui/hub/hub-body.tsx:234-239`)

```ts
  const backfill = (bucket: string) => {
    const def = getEnrichmentById(bucket as EnrichmentId);
    if (!def) return;
    (app as unknown as { commands: { executeCommandById: (id: string) => void } })
      .commands?.executeCommandById?.(`roost:${def.commandId}`);
  };
```

So the hub backlog button is **already covered** by wrapping the command loop —
do NOT also wrap `backfill`. (Same for the migration rows in
`ui/components/setup-health-panel.tsx:127-141`, which `executeCommandById` their
`roost:migrate-*` ids — those are migration commands, not in `ENRICHMENTS`; see
the Maintenance note. They are out of scope.)

### The library-tree pipeline-row run (`ui/hooks/use-roost-pipeline-rows.ts:23-47`)

```ts
  const handleRunPipeline = useCallback(async (category: string, subcategory?: string) => {
    const enrichment = getEnrichmentForCategory(category);
    if (!enrichment) return;
    if (!isCategoryPipelineActive(category, plugin)) {
      log(`Pipeline for "${category}" — ${PIPELINE_INACTIVE_MESSAGE}`);
      return;
    }
    const key = pipelineScopeKey(category, subcategory);
    const controller = new AbortController();
    setPipelineState(s => ({ ...s, [key]: { status: "running", controller } }));
    try {
      await enrichment.runBackfill(plugin, {
        onLog: log,
        signal: controller.signal,
        filter: { category, subcategory },
      });
      plugin.fireDataRefresh();
      setPipelineState(s => ({ ...s, [key]: { status: "done", finishedAt: Date.now() } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPipelineState(s => ({ ...s, [key]: { status: "error", error: msg, finishedAt: Date.now() } }));
    }
  }, [plugin, log]);
```

This is a **direct** `enrichment.runBackfill(plugin, {...})` — NOT via the
command palette — so it needs its own wrap. `plugin` is the hook's
`IRoostPlugin` param.

`grep` confirms these are the **only** two `runBackfill(` callers and the
**only** non-export `runPlatformSync(` caller:

```
packages/core/src/ui/hooks/use-roost-pipeline-rows.ts:34:  await enrichment.runBackfill(plugin, {
packages/core/src/plugin/register-roost-commands.ts:76:  await def.runBackfill(plugin);
packages/core/src/ui/hub/hub-body.tsx:91:  await runPlatformSync({
```

(There are no other production callers — verified by grep across
`packages/core/src` excluding `__tests__`.)

### The plugin interface + class (`types/plugin.ts:18-93`, `main.ts:37-50`)

`IRoostPlugin` is a flat interface; `RoostPlugin extends Plugin` implements it
structurally. The interface already exposes `app`, `settings`, `saveSettings`,
`fireLog`, `triggerHubStateChange`, etc. The class declares simple instance
fields like `lastIncompleteScan` (`main.ts:76`). `jobQueue` will be added the
same way (a `readonly jobQueue = new RoostJobQueue()` field on the class +
`jobQueue: RoostJobQueue` + `runJob` on the interface).

### The 037 auto catch-up trigger + driver loop (Part 2 targets)

`main.ts:185-192` — the deferred, non-blocking trigger:

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

`sync/tweet-body-backfill.ts:38-149` — the driver. Its per-item loop (the place
Part 2 makes yield) is:

```ts
    let succeeded = 0, failed = 0;
    for (let i = 0; i < queue.length; i++) {
      const q = queue[i];
      const cacheKey = `twitter:${q.outerItemId}`;
      const record: NormalizedRecord = { /* ... */ };
      try {
        await writer.rewriteNoteBody(record);
        await writer.stampEnrichmentVersion(record.id, "tweetBody", RENDERED_TWEET_ENRICHMENT.schemaVersion);
        cache[cacheKey] = { ok: true, fetchedAt: now };
        succeeded++;
      } catch (e: unknown) {
        // ...failed++...
      }
      if ((i + 1) % 25 === 0 || i + 1 === queue.length) {
        // ...progress log + cache flush...
      }
    }
```

The 037 orchestrator (also in this file, `:170-187`) is:

```ts
export async function maybeAutoRunTweetBodyBackfill(
  plugin: IRoostPlugin,
  run: (plugin: IRoostPlugin) => Promise<void> = runTweetBodyBackfill,
): Promise<void> {
  if (!shouldAutoRunTweetBodyBackfill(plugin.settings.tweetBodyBackfillDone)) return;
  try {
    plugin.fireLog("[tweet-body-autorun] one-time legacy catch-up starting");
    await run(plugin);
    plugin.settings.tweetBodyBackfillDone = true;
    await plugin.saveSettings();
    plugin.fireLog("[tweet-body-autorun] done — flag set, will not re-run");
  } catch (e: unknown) {
    plugin.fireLog("[tweet-body-autorun] failed (will retry next load): " + /* ... */);
  }
}
```

Note: the orchestrator's injectable `run` param defaults to `runTweetBodyBackfill`
(the real driver). Part 2 adds the yield hook as a **new** optional param on
`runTweetBodyBackfill` (defaulting to no-yield) and has the orchestrator pass it
through — keeping the `run` injection intact for 037's tests.

## Commands

| Purpose   | Command                                          | Expected                                          |
|-----------|--------------------------------------------------|---------------------------------------------------|
| Baseline  | `cd /tmp/roost-merge && npm test 2>&1 \| tail -6`| record the count BEFORE you start: **1167 passed, 8 skipped** |
| Typecheck | `npm run typecheck`                              | exit 0, no output                                 |
| Tests     | `npm test`                                        | all pass (≥ baseline + new queue tests)           |
| Filter    | `npm test -- job-queue`                           | the new `RoostJobQueue` test passes               |
| Build     | `npm run build`                                   | exit 0 (the new lib resolves into the bundle)     |

Conventions: `strictNullChecks` + `noImplicitAny` (NOT full strict); `@/` alias
→ `packages/core/src/`; the `obsidian` package is auto-aliased to the stub
(`__mocks__/obsidian.ts` — `Notice` is an empty class there, so `new Notice(...)`
is test-safe). No ESLint gate — match surrounding style. Do **NOT** run
`npm run test:e2e` (slow) unless asked.

## Scope

**In scope** (create / modify only these):

- **NEW** `packages/core/src/lib/job-queue.ts` — the `RoostJobQueue` class.
- **NEW** `packages/core/src/lib/__tests__/job-queue.test.ts` — its unit test.
- `packages/core/src/types/plugin.ts` — add `jobQueue: RoostJobQueue` +
  `runJob<T>(...)` to `IRoostPlugin`.
- `packages/core/src/main.ts` — add the `jobQueue` field + `runJob` method to
  `RoostPlugin`; (Part 2) pass the yield hook into the catch-up call.
- `packages/core/src/plugin/register-roost-commands.ts` — wrap the
  `def.runBackfill(plugin)` call in `runJob`.
- `packages/core/src/ui/hub/hub-body.tsx` — wrap the `runPlatformSync(...)` call
  in `runJob`.
- `packages/core/src/ui/hooks/use-roost-pipeline-rows.ts` — wrap the
  `enrichment.runBackfill(...)` call in `runJob`.
- `packages/core/src/sync/tweet-body-backfill.ts` — (Part 2) add an optional
  `shouldYield`/`awaitIdle` param to `runTweetBodyBackfill` and have
  `maybeAutoRunTweetBodyBackfill` pass it; default no-yield.
- `plans/README.md` — status row.

**Out of scope** (do NOT touch):

- Removing or changing any `backfillRunning` flag (Decision 5).
- Any deep refactor of `run-platform-sync.ts`, the sync drivers, or the pipeline
  runners — we only wrap their *call sites*.
- The `setup-health-panel.tsx` migration rows and the `roost:migrate-*`
  commands — migrations are not heavy enrichment jobs and are not in `ENRICHMENTS`
  (Maintenance note covers a possible follow-up).
- Any hub queue indicator / cancel UI — explicitly an optional follow-up
  (Maintenance notes). This plan ships the engine + routing + yield only.
- `settings.ts` — the queue holds no persisted state.

---

## Part 1 — The queue + route every manual heavy job through it

### Step 1.1: Create `lib/job-queue.ts`

Create `packages/core/src/lib/job-queue.ts`. Requirements (bake the gotchas in):

- `enqueue<T>(label, fn): Promise<T>` — runs `fn` immediately if idle, else
  queues it FIFO; resolves/rejects with `fn`'s result.
- A throwing job must **not** wedge the queue: catch internally so the next job
  drains, but still **reject the enqueuer's promise** with the same error.
- `isBusy(): boolean` — true while a job is running or any are queued.
- `currentLabel(): string | null` — the running job's label, or null.
- `onIdle(): Promise<void>` — resolves when nothing is running AND nothing is
  queued (resolves immediately if already idle).
- When a job is queued behind a running one, show
  `new Notice("Queued: <label> — runs after <current>")`.

Reference implementation (self-contained; adjust names to taste but keep the
contract):

```ts
import { Notice } from "obsidian";

interface QueuedJob {
  label: string;
  /** Runs the user's fn and settles the enqueuer's promise. Never rejects
   *  (the rejection is forwarded to the enqueuer inside run()). */
  run: () => Promise<void>;
}

/**
 * Serial async FIFO for heavy jobs (sync, backfills, pipeline runs). Only one
 * job runs at a time; the rest wait in insertion order. This is the single
 * coordinator that prevents concurrent vault-thrashing work.
 *
 * A job that throws does NOT wedge the queue: its error is forwarded to the
 * caller of enqueue() and the next job still runs. The auto tweet-body catch-up
 * is deliberately NOT enqueued here — it yields to this queue via onIdle()
 * (plan 040 Part 2), so onIdle resolves on queued+running jobs only and can
 * never deadlock against a non-enqueued waiter.
 */
export class RoostJobQueue {
  private queue: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private idleWaiters: Array<() => void> = [];

  /** True while a job is running or any are queued. */
  isBusy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  /** Label of the currently-running job, or null when idle. */
  currentLabel(): string | null {
    return this.running?.label ?? null;
  }

  /** Resolves when nothing is running and nothing is queued. Resolves
   *  immediately if already idle. */
  onIdle(): Promise<void> {
    if (!this.isBusy()) return Promise.resolve();
    return new Promise<void>((resolve) => { this.idleWaiters.push(resolve); });
  }

  /** Enqueue a job. Runs immediately if idle, else FIFO behind current work.
   *  The returned promise settles with fn's result (including its rejection). */
  enqueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        label,
        run: async () => {
          try {
            resolve(await fn());
          } catch (e) {
            reject(e);
          }
        },
      };
      // If something is already active, this one is queued — tell the user.
      if (this.isBusy()) {
        const current = this.currentLabel() ?? "current job";
        new Notice(`Queued: ${label} — runs after ${current}`);
      }
      this.queue.push(job);
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;            // a drain loop is already active
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running = job;
      try {
        await job.run();                 // job.run() never rejects (forwards internally)
      } finally {
        this.running = null;
      }
    }
    // Drained: wake any onIdle() waiters.
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
```

Notes for the executor:
- `job.run()` swallows the job's error (forwarding it to the enqueuer via
  `reject`), so the `while` loop never breaks on a throw — the queue keeps
  draining. The enqueuer still sees the rejection. That is the "throwing job must
  not wedge the queue" gotcha.
- `drain()` is re-entrancy-safe: `enqueue` always pushes then calls `drain()`,
  but `drain()` returns early if a loop is already running, so a job enqueued
  *while another runs* is picked up by the still-spinning loop.
- `onIdle()` waiters are flushed only when the loop fully drains (queue empty AND
  running cleared) — exactly the semantics Part 2 needs.

**Verify:** `npm run typecheck` → exit 0.

### Step 1.2: Expose `jobQueue` + `runJob` on the plugin

In `packages/core/src/types/plugin.ts`:

1. Add the import near the other type imports:
   ```ts
   import type { RoostJobQueue } from "@/lib/job-queue";
   ```
2. Add to the `IRoostPlugin` interface (e.g. just after `triggerHubStateChange();`):
   ```ts
   /** Serial job queue — every manually-triggered heavy job (sync, backfill,
    *  pipeline run) runs through it one-at-a-time. The 037 auto catch-up is NOT
    *  enqueued; it yields to queued/running jobs via jobQueue.onIdle(). */
   jobQueue: RoostJobQueue;
   /** Convenience: enqueue `fn` under `label` on the serial queue and return
    *  its promise (same value/rejection). */
   runJob<T>(label: string, fn: () => Promise<T>): Promise<T>;
   ```

In `packages/core/src/main.ts`:

1. Add the import near the other plugin imports:
   ```ts
   import { RoostJobQueue } from "@/lib/job-queue";
   ```
2. Add the field on the `RoostPlugin` class (next to `lastIncompleteScan` etc.):
   ```ts
   /** Serial queue for heavy jobs — see IRoostPlugin.jobQueue. */
   readonly jobQueue = new RoostJobQueue();
   ```
3. Add the method (anywhere on the class, e.g. near `fireLog` / `triggerHubStateChange`):
   ```ts
   runJob<T>(label: string, fn: () => Promise<T>): Promise<T> {
     return this.jobQueue.enqueue(label, fn);
   }
   ```

**Verify:** `npm run typecheck` → exit 0. (The class now structurally satisfies
the widened `IRoostPlugin`.)

### Step 1.3: Route the command-registration loop through `runJob` (the choke point)

In `packages/core/src/plugin/register-roost-commands.ts`, wrap the
`def.runBackfill(plugin)` call (line ~76):

```ts
      callback: async () => {
        if (isPipelineEnrichmentId(def.id) && !guardPipelineActive(def.id, plugin, (msg) => new Notice(msg, 6000))) {
          return;
        }
        await plugin.runJob(def.commandName, () => def.runBackfill(plugin));
      },
```

`def.commandName` is the user-facing label (e.g. "Render X tweet bodies"),
which is exactly what the "Queued: …" Notice should show. `plugin` is a
`RoostCommandHost`, which now has `runJob` via `IRoostPlugin`.

This single edit covers **Cmd+P**, the **hub backlog buttons**
(`hub-body.tsx` `backfill` → `executeCommandById`), and the **setup-health
migration-adjacent backlog dispatch** — all go through the registered command.

### Step 1.4: Route the hub Sync trigger through `runJob`

In `packages/core/src/ui/hub/hub-body.tsx`, wrap the `runPlatformSync(...)` call
inside `runOne` (line ~91). The call is `await`ed for its side effects (the
result isn't used), but `runJob` returns the same promise so semantics are
preserved. Use a human label including the platform:

```ts
    try {
      await plugin.runJob(`Sync ${platform}`, () => runPlatformSync({
        plugin,
        app,
        platform,
        mountTarget: target,
        signal,
        fastMode,
        onLog: log,
        onProgress: (p: SyncPhaseProgress) => { /* ...unchanged... */ },
        onBatchWritten: (b) => { /* ...unchanged... */ },
        suppressNotice: true,
      }));
    } finally {
      setLiveSyncs((prev) => ({ ...prev, [platform]: null }));
      plugin.triggerHubStateChange();
    }
```

Only the call is wrapped — the entire `onProgress` / `onBatchWritten` /
`suppressNotice` payload is byte-identical. The `finally` (state reset +
`triggerHubStateChange`) is unchanged.

> **Note on `updateAll`'s `Promise.all`** (`hub-body.tsx:171`,
> `await Promise.all(targets.map((p) => runOne(p, fastMode)))`): with the wrap,
> the two `runOne` calls still *start* together, but their `runPlatformSync`
> bodies are now serialized by the queue — TikTok runs, then X (the second shows
> the "Queued: Sync twitter — runs after Sync tiktok" Notice). `Promise.all`
> still resolves when both finish. This is the **intended** behavior (no more
> two concurrent syncs thrashing the vault). Do not try to "fix" the
> `Promise.all` — leave it; the serialization is the point. (Each platform still
> has its own webview/mount, so serializing only changes *timing*, not
> correctness.)

**Verify:** `npm run typecheck` → exit 0.

### Step 1.5: Route the library-tree pipeline-row run through `runJob`

In `packages/core/src/ui/hooks/use-roost-pipeline-rows.ts`, wrap the
`enrichment.runBackfill(plugin, {...})` call (line ~34). Keep the surrounding
`setPipelineState` / `fireDataRefresh` / catch logic identical — only the call
is wrapped. A good label uses the scope:

```ts
    try {
      const label = subcategory ? `${category} / ${subcategory}` : category;
      await plugin.runJob(label, () => enrichment.runBackfill(plugin, {
        onLog: log,
        signal: controller.signal,
        filter: { category, subcategory },
      }));
      plugin.fireDataRefresh();
      setPipelineState(s => ({ ...s, [key]: { status: "done", finishedAt: Date.now() } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPipelineState(s => ({ ...s, [key]: { status: "error", error: msg, finishedAt: Date.now() } }));
    }
```

Because `runJob` rejects with the inner error (Decision 6 / gotcha), the
existing `catch (e)` that sets `status: "error"` still fires exactly as before.

**Verify:** `npm run typecheck` → exit 0; `npm run build` → exit 0 (the new lib
resolves into the bundle).

### Step 1.6: Unit-test `RoostJobQueue`

Add `packages/core/src/lib/__tests__/job-queue.test.ts`. The `obsidian` stub is
auto-aliased (so `new Notice(...)` is a no-op). Use deferred promises (a manual
resolve handle) to control job ordering deterministically. Cover the contract:

```ts
import { describe, it, expect } from "vitest";
import { RoostJobQueue } from "@/lib/job-queue";

/** A promise you can resolve/reject by hand, to control job timing in tests. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("RoostJobQueue", () => {
  it("runs jobs serially in FIFO order: B starts only after A resolves", async () => {
    const q = new RoostJobQueue();
    const order: string[] = [];
    const a = deferred();
    const b = deferred();

    const pA = q.enqueue("A", async () => { order.push("A:start"); await a.promise; order.push("A:end"); });
    const pB = q.enqueue("B", async () => { order.push("B:start"); await b.promise; order.push("B:end"); });

    // Let microtasks flush — A should have started, B must NOT have.
    await Promise.resolve();
    expect(order).toEqual(["A:start"]);
    expect(q.isBusy()).toBe(true);
    expect(q.currentLabel()).toBe("A");

    a.resolve();
    await pA;
    // After A resolves, B starts.
    await Promise.resolve();
    expect(order).toEqual(["A:start", "A:end", "B:start"]);
    expect(q.currentLabel()).toBe("B");

    b.resolve();
    await pB;
    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("a throwing job rejects its enqueuer but does NOT wedge the queue", async () => {
    const q = new RoostJobQueue();
    const ran: string[] = [];

    const pA = q.enqueue("A", async () => { ran.push("A"); throw new Error("boom"); });
    const pB = q.enqueue("B", async () => { ran.push("B"); });

    await expect(pA).rejects.toThrow("boom");
    await expect(pB).resolves.toBeUndefined();
    expect(ran).toEqual(["A", "B"]);
  });

  it("returns the inner fn's resolved value", async () => {
    const q = new RoostJobQueue();
    await expect(q.enqueue("v", async () => 42)).resolves.toBe(42);
  });

  it("isBusy()/currentLabel() reflect idle state before and after drain", async () => {
    const q = new RoostJobQueue();
    expect(q.isBusy()).toBe(false);
    expect(q.currentLabel()).toBe(null);
    await q.enqueue("only", async () => {});
    expect(q.isBusy()).toBe(false);
    expect(q.currentLabel()).toBe(null);
  });

  it("onIdle() resolves immediately when idle, and after drain when busy", async () => {
    const q = new RoostJobQueue();
    // Idle → resolves immediately.
    await q.onIdle();

    const a = deferred();
    const pA = q.enqueue("A", async () => { await a.promise; });
    let idleResolved = false;
    const idle = q.onIdle().then(() => { idleResolved = true; });

    await Promise.resolve();
    expect(idleResolved).toBe(false);  // still running

    a.resolve();
    await pA;
    await idle;
    expect(idleResolved).toBe(true);   // resolved only after drain
  });

  it("shows a 'Queued' Notice for a job enqueued behind a running one (smoke)", async () => {
    // The obsidian stub's Notice is a no-op; this just proves the path doesn't
    // throw when a second job is enqueued while the first runs.
    const q = new RoostJobQueue();
    const a = deferred();
    const pA = q.enqueue("A", async () => { await a.promise; });
    const pB = q.enqueue("B", async () => {});
    a.resolve();
    await Promise.all([pA, pB]);
    expect(true).toBe(true);
  });
});
```

(If you want to *assert* the Notice text, `vi.mock("obsidian")` with a spy
`Notice` and check the constructor arg — optional; the smoke test above is
sufficient for the contract. Don't over-engineer it.)

**Verify:** `npm test -- job-queue` passes; `npm run typecheck` → exit 0.

### Verify — Part 1

```bash
cd /tmp/roost-merge
npm run typecheck                                  # exit 0
npm test -- job-queue                              # the new queue test passes
npm run build                                      # exit 0
grep -n "plugin.runJob" packages/core/src/plugin/register-roost-commands.ts   # present
grep -n "plugin.runJob" packages/core/src/ui/hub/hub-body.tsx                 # present
grep -n "plugin.runJob" packages/core/src/ui/hooks/use-roost-pipeline-rows.ts # present
grep -n "jobQueue\|runJob" packages/core/src/types/plugin.ts                  # both present
```

- [ ] `npm run typecheck` exits 0.
- [ ] `lib/job-queue.ts` + its test exist; `npm test -- job-queue` passes.
- [ ] All three manual call sites (`register-roost-commands.ts`, `hub-body.tsx`,
      `use-roost-pipeline-rows.ts`) route through `plugin.runJob`.
- [ ] `IRoostPlugin` declares `jobQueue` + `runJob`; the `RoostPlugin` class
      provides both.
- [ ] `npm test` ≥ baseline (1167) + the new queue tests.

---

## Part 2 — Make the 037 auto catch-up YIELD to manual jobs

> Part 2 depends on Part 1 (`plugin.jobQueue` must exist). Keep the driver change
> **minimal**: one optional param defaulting to no-yield, so 037's tests and any
> other caller are byte-unaffected.

### Step 2.1: Thread an optional yield hook into the catch-up driver

In `packages/core/src/sync/tweet-body-backfill.ts`, add an optional second
param to `runTweetBodyBackfill`. Choose the **idle-awaiter** shape (it expresses
"pause until the queue drains" directly and avoids a busy-wait):

```ts
export async function runTweetBodyBackfill(
  plugin: IRoostPlugin,
  awaitIdle?: () => Promise<void>,   // NEW — default undefined = never yield
): Promise<void> {
```

Then, inside the per-item loop (the `for (let i = 0; i < queue.length; i++)`
block, before the `try { await writer.rewriteNoteBody(...) }`), add a yield
point:

```ts
    for (let i = 0; i < queue.length; i++) {
      // Yield to manual jobs: if a sync/backfill/pipeline run is queued or
      // running, pause this low-priority catch-up until the queue drains, so we
      // never thrash the vault alongside user-triggered work (plan 040).
      if (awaitIdle) await awaitIdle();

      const q = queue[i];
      // ...unchanged...
    }
```

`awaitIdle` defaults to `undefined`, so existing callers (037's tests, anyone
calling `runTweetBodyBackfill(plugin)` directly) behave exactly as before — no
yield, no behavior change. Only the orchestrator (next step) passes a real hook.

> **Important — the `run` injection in `maybeAutoRunTweetBodyBackfill` is typed
> `(plugin) => Promise<void>`.** Adding a second *optional* param to
> `runTweetBodyBackfill` keeps it assignable to that type (extra optional params
> are fine), so 037's default `run = runTweetBodyBackfill` still typechecks. Do
> NOT change the `run` param's type. Instead, the orchestrator should call the
> driver with the yield hook **itself** (see 2.2) rather than relying on `run`
> to forward it.

### Step 2.2: Have the orchestrator pass the idle-awaiter

In `maybeAutoRunTweetBodyBackfill` (`tweet-body-backfill.ts:170-187`), thread
the queue's idle-awaiter through. Because the injectable `run` param keeps the
single-arg signature (for 037's tests), pass the awaiter as a **third** param to
the orchestrator with a default, and use it when calling the **default** driver.
The cleanest minimal change that preserves 037's test injection:

```ts
export async function maybeAutoRunTweetBodyBackfill(
  plugin: IRoostPlugin,
  run: (plugin: IRoostPlugin) => Promise<void> =
    (p) => runTweetBodyBackfill(p, () => p.jobQueue.onIdle()),
): Promise<void> {
  if (!shouldAutoRunTweetBodyBackfill(plugin.settings.tweetBodyBackfillDone)) return;
  try {
    plugin.fireLog("[tweet-body-autorun] one-time legacy catch-up starting");
    await run(plugin);
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

Key points:
- The **default** `run` now wires the yield hook: it calls
  `runTweetBodyBackfill(p, () => p.jobQueue.onIdle())`. So production
  (`maybeAutoRunTweetBodyBackfill(this)` from `main.ts`) yields to the queue.
- 037's tests inject their own `run` (a mock), which **ignores** the awaiter —
  so those tests are unaffected. Verify 037's test file still passes unchanged.
- `p.jobQueue.onIdle()` resolves immediately when no manual job is
  queued/running, so on an idle vault the catch-up runs at full speed.

> **Deadlock check (Decision 4):** the catch-up is **not** enqueued, so
> `onIdle()` only ever waits on *manual* queued/running jobs. The catch-up
> awaiting `onIdle` can never be the thing keeping the queue busy → no
> self-deadlock. Confirm by reading `RoostJobQueue.onIdle` / `isBusy` (they look
> only at `this.running` + `this.queue`, never at the catch-up).

### Step 2.3: `main.ts` needs no change

The `main.ts` trigger (`:190-192`) already calls
`maybeAutoRunTweetBodyBackfill(this)` with no `run` override, so it now picks up
the yield-wired default automatically. **Do not edit `main.ts` for Part 2**
unless typecheck demands it (it should not). Confirm the call site is unchanged.

### Step 2.4: (Optional, only if cheap) a yield-wiring unit test

037 already tests the orchestrator's flag-flip contract with an injected `run`.
A *minimal* Part-2 addition (only if it lands quickly) is a test that
`runTweetBodyBackfill`'s loop awaits the hook before processing items. This
requires seeding a fake vault with one X `raw.json` — if that's heavy, **skip it
and note it deferred**: the queue's own `onIdle` test (Step 1.6) plus typecheck
of the wiring already prove the mechanism. Do NOT block Part 2 on this test.

If you do add it, the contract to assert is: with a non-immediate `awaitIdle`
(one that resolves on a controlled deferred), the first `rewriteNoteBody` does
not happen until the awaiter resolves. Place it in a new
`sync/__tests__/tweet-body-yield.test.ts` or extend an existing tweet-body test
file — keep it a unit test of the loop's yield point, mocking the writer.

### Verify — Part 2

```bash
cd /tmp/roost-merge
npm run typecheck                              # exit 0
npm test -- tweet-body                         # 037's tests still pass, unchanged
grep -n "awaitIdle" packages/core/src/sync/tweet-body-backfill.ts        # present in the loop
grep -n "jobQueue.onIdle" packages/core/src/sync/tweet-body-backfill.ts  # present in the default run
```

- [ ] `npm run typecheck` exits 0.
- [ ] `runTweetBodyBackfill` has an optional `awaitIdle` param defaulting to
      no-yield; the per-item loop awaits it when present.
- [ ] `maybeAutoRunTweetBodyBackfill`'s **default** `run` wires
      `() => p.jobQueue.onIdle()`; 037's injected-`run` tests still pass unchanged.
- [ ] `main.ts`'s catch-up trigger is unchanged.

---

## Test plan (summary)

- **New `job-queue.test.ts`** (Part 1, the core proof): serial FIFO ordering
  (B starts only after A resolves), a throwing A rejects its enqueuer but B still
  runs, `enqueue` returns the inner value, `isBusy`/`currentLabel` idle/busy
  transitions, `onIdle` resolves immediately when idle and after drain when busy,
  and a "Queued" Notice smoke path.
- **UI wiring** (Parts 1.3–1.5): covered by `npm run typecheck` (the wrapped
  call sites must still typecheck against `IRoostPlugin.runJob<T>`) — no new
  React render test required.
- **037 regression** (Part 2): `npm test -- tweet-body` must pass **unchanged**
  (the optional param + default-run rewiring must not perturb 037's injected-mock
  tests).
- **Full suite**: `npm test` ≥ baseline (1167) + the new queue tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0 with **≥ the baseline** (1167 passed / 8 skipped) + the
      new `job-queue` tests.
- [ ] `npm run build` exits 0 (the new lib bundles).
- [ ] `ls packages/core/src/lib/job-queue.ts packages/core/src/lib/__tests__/job-queue.test.ts`
      → both exist.
- [ ] `grep -n "jobQueue\|runJob" packages/core/src/types/plugin.ts` → both
      declared on `IRoostPlugin`.
- [ ] `grep -n "new RoostJobQueue\|runJob<T>" packages/core/src/main.ts` → field
      + method present on the class.
- [ ] `grep -rn "plugin.runJob" packages/core/src/plugin/register-roost-commands.ts packages/core/src/ui/hub/hub-body.tsx packages/core/src/ui/hooks/use-roost-pipeline-rows.ts`
      → all three wrapped.
- [ ] `grep -rn "runBackfill(\|runPlatformSync(" packages/core/src --include=*.ts --include=*.tsx | grep -v __tests__ | grep -v "runBackfill:"`
      → every production caller is now inside a `runJob(...)` (i.e. the three
      sites above; no un-wrapped heavy-job caller remains).
- [ ] `grep -n "awaitIdle" packages/core/src/sync/tweet-body-backfill.ts` →
      present in `runTweetBodyBackfill`'s loop; `grep -n "jobQueue.onIdle"` →
      present in `maybeAutoRunTweetBodyBackfill`'s default run.
- [ ] The `backfillRunning` flags are **untouched**
      (`git diff a1c5c10..HEAD -- packages/core/src/sync/tweet-body-backfill.ts`
      shows no removal of `backfillRunning`).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The cited excerpts don't match the live code (drift) — re-read and report
  which file drifted.
- Wrapping a call site in `runJob` changes a caller's **return/await** semantics
  in a way that breaks compile or a test (e.g. a caller that read
  `RunPlatformSyncResult` — none do today, but if Part-1.4's wrap loses the
  return value a consumer needs, keep `runJob<RunPlatformSyncResult>` and return
  it). The queue's `enqueue<T>` already preserves the value — if you find a
  consumer of the sync result, thread `T` through rather than dropping it.
- A throwing job is observed to **wedge** the queue (a subsequent job never
  runs) in the unit test — the try/catch-forward in `job.run()` / the `finally`
  in `drain()` is wrong; fix before declaring Part 1 done.
- The catch-up yield (Part 2) **deadlocks** (the catch-up awaits `onIdle` and it
  never resolves on an idle vault) — that means `onIdle`/`isBusy` are looking at
  something other than queued+running manual jobs, or the catch-up was
  accidentally enqueued. The catch-up must NEVER be inside the FIFO.
- 037's `tweet-body` tests start failing after Part 2 — the optional-param /
  default-run change perturbed the injected-`run` contract; the injected mock
  must still be a single-arg `(plugin) => Promise<void>` and must be honored.
- You are tempted to **remove** a `backfillRunning` flag or refactor a sync/
  pipeline driver — out of scope; STOP.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **Why the command loop is the high-leverage edit.** Three surfaces (Cmd+P, the
  hub backlog buttons via `executeCommandById`, and the setup-health backlog
  dispatch) all flow through the single registered enrichment command, so one
  wrap in `register-roost-commands.ts` serializes all of them. Only the two
  *direct* call sites (hub Sync, library-tree pipeline row) need their own wrap
  because they bypass the command palette.
- **The catch-up is intentionally not in the queue.** It's a ~13K-item,
  hours-long, low-priority migration. Enqueuing it would block every manual job
  behind it. The yield (await `onIdle` per item) makes it a polite background
  task that steps aside the instant a user triggers real work, then resumes —
  with the driver's resumable `.roost/cache` meaning a mid-walk pause costs
  nothing. The per-item granularity means at most one item's work overlaps a
  newly-queued manual job.
- **`Promise.all` in `updateAll` now serializes.** "Update all" still kicks off
  both platforms, but the queue runs them back-to-back (TikTok, then X). This is
  the desired anti-thrash behavior; the second platform shows a "Queued" Notice.
  If a future product decision wants both platforms truly parallel (they have
  separate webviews), that would require a *concurrency-2* lane — explicitly out
  of scope here (the whole point is one-at-a-time).
- **Optional follow-ups (track as their own plans, not here):**
  1. **Hub queue indicator** — surface `jobQueue.currentLabel()` +
     `jobQueue.isBusy()` (and the pending count) in the hub so the user sees
     "Running: Sync X — 2 queued". The queue already exposes the needed
     accessors; this is pure read-only UI.
  2. **Cancel/clear-queue** — a way to drop *queued* (not-yet-started) jobs and/or
     signal-cancel the running one. The sync/pipeline paths already accept a
     `StopSignal` / `AbortController`; a cancel surface would wire those plus a
     `RoostJobQueue.clearQueued()`. Needs a small queue API addition + UI.
  3. **Should Sync preempt long backfills?** Today everything is strict FIFO, so
     a Sync queued behind a long media backfill waits. A future enhancement could
     give Sync priority (a two-lane or priority queue) since syncs are short and
     user-initiated. Deliberately **not** done here — strict FIFO is the simplest
     correct first cut; revisit only if users report Sync-behind-backfill waits.
  4. **Route the `roost:migrate-*` commands too?** The setup-health migration
     rows (`setup-health-panel.tsx`) dispatch `roost:migrate-*` commands that are
     **not** in `ENRICHMENTS`, so the command-loop wrap doesn't cover them. They
     are one-shot, light, and rare, so they're out of scope — but if a migration
     ever does heavy vault rewriting, wrap its command callback in `runJob` the
     same way.
- **Reviewer focus in the PR:** (1) `enqueue<T>` preserves the inner promise's
  value AND rejection, and a throw never wedges the queue (the `job.run`
  catch-forward + `drain` `finally`); (2) `onIdle`/`isBusy` look only at
  queued+running jobs (no catch-up coupling) → no deadlock; (3) all manual heavy
  jobs route through `runJob` and the `backfillRunning` flags are untouched;
  (4) Part 2 is a default-off optional param so 037 is byte-unaffected; (5) the
  catch-up is never enqueued.
