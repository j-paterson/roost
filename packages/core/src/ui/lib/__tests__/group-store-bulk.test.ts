import { describe, it, expect } from "vitest";
import { GroupStore } from "../group-store";
import type { ClassifyProposalData } from "@/types/roost";

function makeStore() {
  const store = new GroupStore();
  const data: ClassifyProposalData = {
    proposals: [
      { suggestedName: "A", altNames: [], count: 2, itemIds: ["a1", "a2"], samples: [] },
      { suggestedName: "B", altNames: [], count: 2, itemIds: ["b1", "b2"], samples: [] },
      { suggestedName: "C", altNames: [], count: 0, itemIds: [], samples: [] },
    ],
    platform: "test",
    noiseItemIds: [],
  };
  store.loadFromClusterOutput(data);
  const groups = store.getClusterGroups();
  const groupA = groups.find(g => g.name === "A")!;
  const groupB = groups.find(g => g.name === "B")!;
  const groupC = groups.find(g => g.name === "C")!;
  return { store, groupA, groupB, groupC };
}

describe("GroupStore.rejectItems", () => {
  it("adds all ids to the rejections set", () => {
    const { store } = makeStore();
    store.rejectItems(["a1", "a2", "b1"]);
    expect(store.getRejects().has("a1")).toBe(true);
    expect(store.getRejects().has("a2")).toBe(true);
    expect(store.getRejects().has("b1")).toBe(true);
  });

  it("is idempotent — duplicates do not inflate size", () => {
    const { store } = makeStore();
    store.rejectItems(["a1", "a1", "b1"]);
    expect(store.getRejects().size).toBe(2);
  });

  it("accumulated with single rejectItem calls", () => {
    const { store } = makeStore();
    store.rejectItem("a1");
    store.rejectItems(["b1", "b2"]);
    expect(store.getRejects().size).toBe(3);
  });
});

describe("GroupStore.reassignItemsTo", () => {
  it("moves item from single source group to target", () => {
    const { store, groupA, groupC } = makeStore();
    store.reassignItemsTo(["a1"], groupC.id);
    expect(store.getGroup(groupA.id)!.itemIds).toEqual(["a2"]);
    expect(store.getGroup(groupC.id)!.itemIds).toContain("a1");
  });

  it("moves items from MULTIPLE source groups to target (mixed-source)", () => {
    const { store, groupA, groupB, groupC } = makeStore();
    store.reassignItemsTo(["a1", "b1"], groupC.id);
    expect(store.getGroup(groupA.id)!.itemIds).toEqual(["a2"]);
    expect(store.getGroup(groupB.id)!.itemIds).toEqual(["b2"]);
    const cIds = store.getGroup(groupC.id)!.itemIds;
    expect(cIds).toContain("a1");
    expect(cIds).toContain("b1");
  });

  it("records reassignments for all moved items", () => {
    const { store, groupC } = makeStore();
    store.reassignItemsTo(["a1", "b1"], groupC.id);
    expect(store.getReassignments().get("a1")).toBe(groupC.id);
    expect(store.getReassignments().get("b1")).toBe(groupC.id);
  });

  it("is a no-op when toGroupId does not exist", () => {
    const { store, groupA } = makeStore();
    const beforeA = [...store.getGroup(groupA.id)!.itemIds];
    store.reassignItemsTo(["a1"], "nonexistent");
    expect(store.getGroup(groupA.id)!.itemIds).toEqual(beforeA);
  });
});
