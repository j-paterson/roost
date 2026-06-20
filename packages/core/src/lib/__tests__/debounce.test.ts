import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCoalescingTrigger } from "../debounce";

describe("createCoalescingTrigger", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires immediately on the first trigger (leading edge)", () => {
    const fn = vi.fn();
    const c = createCoalescingTrigger(fn, 250);
    c.trigger();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst into exactly 2 calls (leading + one trailing)", () => {
    const fn = vi.fn();
    const c = createCoalescingTrigger(fn, 250);
    for (let i = 0; i < 50; i++) c.trigger(); // a re-index storm
    expect(fn).toHaveBeenCalledTimes(1);       // only the leading paint so far
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(2);        // one trailing paint when it settles
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);        // and no more
  });

  it("a single trigger does NOT schedule a trailing call", () => {
    const fn = vi.fn();
    const c = createCoalescingTrigger(fn, 250);
    c.trigger();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("triggers spaced beyond the window each fire immediately", () => {
    const fn = vi.fn();
    const c = createCoalescingTrigger(fn, 250);
    c.trigger();
    vi.advanceTimersByTime(300);
    c.trigger();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("cancel() drops a pending trailing call", () => {
    const fn = vi.fn();
    const c = createCoalescingTrigger(fn, 250);
    c.trigger(); // leading
    c.trigger(); // trailing owed
    c.cancel();
    vi.advanceTimersByTime(250);
    expect(fn).toHaveBeenCalledTimes(1); // trailing was cancelled
  });
});
