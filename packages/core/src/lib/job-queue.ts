import { Notice } from "obsidian";

interface QueuedJob {
  label: string;
  /** Runs the user's fn to completion and reports its outcome to drain(), which
   *  settles the enqueuer's promise AFTER clearing the running slot (so the
   *  enqueuer never observes the queue as still-busy). Never rejects (the
   *  rejection is captured into the returned outcome). */
  run: () => Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }>;
  /** Settle the enqueuer's promise. Called by drain() after running is cleared. */
  settle: (outcome: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
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
            return { ok: true, value: await fn() };
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
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;            // a drain loop is already active
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.running = job;
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
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
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}
