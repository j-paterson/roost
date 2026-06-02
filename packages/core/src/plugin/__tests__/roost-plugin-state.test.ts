import { describe, it, expect } from "vitest";
import { RoostPluginState } from "@/plugin/roost-plugin-state";

describe("RoostPluginState", () => {
  it("notifies filter subscribers on setFilter", () => {
    const state = new RoostPluginState();
    const seen: (string | null)[] = [];
    state.filter.subscribe((f) => seen.push(f?.platform ?? null));
    state.filter.set({ platform: "tiktok" });
    state.filter.set(null);
    expect(seen).toEqual(["tiktok", null]);
  });

  it("skips bulkWrite notify when value unchanged", () => {
    const state = new RoostPluginState();
    let calls = 0;
    state.bulkWrite.subscribe(() => { calls++; });
    state.bulkWrite.set(false);
    state.bulkWrite.set(false);
    expect(calls).toBe(0);
  });

  it("fires dataRefresh to all subscribers", () => {
    const state = new RoostPluginState();
    let a = 0;
    let b = 0;
    state.dataRefresh.subscribe(() => { a++; });
    state.dataRefresh.subscribe(() => { b++; });
    state.dataRefresh.emit();
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
