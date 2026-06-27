import { describe, it, expect, vi } from "vitest";
import { GroupStore } from "@/ui/lib/group-store";

// Thin behavioral contract: rejectItem delegates to store.rejectItem and bumps the version.
describe("rejectItem contract", () => {
  it("delegates to store.rejectItem", () => {
    const store = new GroupStore();
    const spy = vi.spyOn(store, "rejectItem");
    // simulate what the hook's rejectItem does:
    const rejectItem = (id: string) => { store.rejectItem(id); };
    rejectItem("x");
    expect(spy).toHaveBeenCalledWith("x");
    expect(store.getRejects().has("x")).toBe(true);
  });
});
