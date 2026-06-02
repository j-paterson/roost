// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForMetadataQuiet } from "../metadata-cache-quiet";

interface MockCache {
  on(event: string, fn: () => void): string;
  offref(ref: string): void;
  emit(event: string): void;
}

function createMockMetadataCache(): MockCache {
  const handlers = new Map<string, Map<string, () => void>>();
  let refCounter = 0;

  return {
    on(event: string, fn: () => void) {
      if (!handlers.has(event)) handlers.set(event, new Map());
      const ref = `ref-${refCounter++}`;
      handlers.get(event)!.set(ref, fn);
      return ref;
    },
    offref(ref: string) {
      for (const map of handlers.values()) map.delete(ref);
    },
    emit(event: string) {
      for (const fn of handlers.get(event)?.values() ?? []) fn();
    },
  };
}

describe("waitForMetadataQuiet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after quiet period with no events", async () => {
    const cache = createMockMetadataCache();
    const p = waitForMetadataQuiet(cache as never, { quietMs: 100, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(100);
    await expect(p).resolves.toBeUndefined();
  });

  it("waits for burst of changed events to settle", async () => {
    const cache = createMockMetadataCache();
    const p = waitForMetadataQuiet(cache as never, { quietMs: 100, timeoutMs: 5000 });
    cache.emit("changed");
    await vi.advanceTimersByTimeAsync(50);
    cache.emit("changed");
    await vi.advanceTimersByTimeAsync(50);
    let done = false;
    void p.then(() => { done = true; });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(true);
  });

  it("resolves at timeout even if events keep firing", async () => {
    const cache = createMockMetadataCache();
    const p = waitForMetadataQuiet(cache as never, { quietMs: 200, timeoutMs: 500 });
    const interval = setInterval(() => cache.emit("changed"), 50);
    await vi.advanceTimersByTimeAsync(500);
    clearInterval(interval);
    await expect(p).resolves.toBeUndefined();
  });
});
