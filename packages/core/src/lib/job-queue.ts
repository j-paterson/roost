import { Notice } from "obsidian";

type JobOutcome = { ok: true; value: unknown } | { ok: false; error: unknown };

interface QueuedJob {
  label: string;
  controller: AbortController;
  /** Runs the user's fn to completion and reports its outcome to drain(), which
   *  settles the enqueuer's promise AFTER clearing the running slot (so the
   *  enqueuer never observes the queue as still-busy). Never rejects (the
   *  rejection is captured into the returned outcome). */
  run: () => Promise<JobOutcome>;
  /** Settle the enqueuer's promise. Called by drain() after running is cleared. */
  settle: (outcome: JobOutcome) => void;
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
 *
 * Cancellation: each enqueued job owns an AbortController. cancelCurrent() aborts
 * the running job's signal so the fn can stop between batches. cancelAll() also
 * drains the pending queue, settling each queued enqueuer with an AbortError so
 * no promises are left dangling.
 */
export class RoostJobQueue {
  private queue: QueuedJob[] = [];
  private running: QueuedJob | null = null;
  private idleWaiters: Array<() => void> = [];
  private onChangeCb: (() => void) | null = null;

  set onChange(cb: () => void) {
    this.onChangeCb = cb;
  }

  private notify(): void {
    this.onChangeCb?.();
  }

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

  /** Abort the currently-running job's signal. The fn observes the signal and
   *  should stop between batches. The queue keeps draining after this. */
  cancelCurrent(): void {
    this.running?.controller.abort();
  }

  /** Abort the running job AND clear all pending jobs from the queue. Each
   *  removed queued job's enqueuer promise is settled with an AbortError so
   *  no promises are left dangling. Then notify and wake idleWaiters. */
  cancelAll(): void {
    // Abort the running job.
    this.running?.controller.abort();

    // Drain the pending queue: settle each queued job as aborted so callers
    // don't have dangling promises.
    const pending = this.queue.splice(0);
    for (const job of pending) {
      job.controller.abort();
      job.settle({ ok: false, error: new DOMException("Job cancelled", "AbortError") });
    }

    this.notify();

    // If nothing is now running, wake idleWaiters.
    if (!this.running) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** Enqueue a job. Runs immediately if idle, else FIFO behind current work.
   *  The returned promise settles with fn's result (including its rejection).
   *  `fn` receives the job's AbortSignal so it can stop between batches. */
  enqueue<T>(label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      const job: QueuedJob = {
        label,
        controller,
        run: async () => {
          try {
            return { ok: true, value: await fn(controller.signal) };
          } catch (e) {
            return { ok: false, error: e };
          }
        },
        settle: (outcome) => {
          if (outcome.ok) resolve(outcome.value as T);
          else reject(outcome.error);
        },
      };
      // If something is already active, this one is queued — tell the user.
      if (this.isBusy()) {
        const current = this.currentLabel() ?? "current job";
        new Notice(`Queued: ${label} — runs after ${current}`);
      }
      this.queue.push(job);
      this.notify();
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;            // a drain loop is already active
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running = job;
      this.notify();
      let outcome: JobOutcome;
      try {
        outcome = await job.run();       // job.run() never rejects (captures internally)
      } finally {
        this.running = null;             // clear BEFORE settling the enqueuer
      }
      // Settle after the running slot is cleared so the enqueuer's continuation
      // never observes the queue as still-busy (isBusy()/currentLabel() are
      // already idle if this was the last job). A throw is reported via the
      // captured outcome, so the loop keeps draining the next job regardless.
      job.settle(outcome);
    }
    // Drained: wake any onIdle() waiters.
    this.notify();
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
