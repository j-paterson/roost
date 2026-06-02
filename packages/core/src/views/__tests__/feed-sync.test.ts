import { describe, it, expect, vi } from "vitest";
import { createFeedSync } from "@/views/feed/feed-sync";

describe("createFeedSync", () => {
  it("starts with no active id", () => {
    const sync = createFeedSync();
    expect(sync.get()).toBeNull();
  });

  it("notifies subscribers with id and source", () => {
    const sync = createFeedSync();
    const listener = vi.fn();
    sync.subscribe(listener);
    sync.set("roost-1", "grid");
    expect(listener).toHaveBeenCalledWith("roost-1", "grid");
    expect(sync.get()).toBe("roost-1");
  });

  it("does not notify when the id is unchanged", () => {
    const sync = createFeedSync();
    const listener = vi.fn();
    sync.subscribe(listener);
    sync.set("roost-1", "grid");
    sync.set("roost-1", "feed");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops notifications", () => {
    const sync = createFeedSync();
    const listener = vi.fn();
    const unsub = sync.subscribe(listener);
    unsub();
    sync.set("roost-1", "grid");
    expect(listener).not.toHaveBeenCalled();
  });

  it("supports multiple subscribers", () => {
    const sync = createFeedSync();
    const a = vi.fn();
    const b = vi.fn();
    sync.subscribe(a);
    sync.subscribe(b);
    sync.set("roost-1", "feed");
    expect(a).toHaveBeenCalledWith("roost-1", "feed");
    expect(b).toHaveBeenCalledWith("roost-1", "feed");
  });
});
