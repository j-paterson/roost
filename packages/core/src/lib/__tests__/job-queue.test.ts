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
