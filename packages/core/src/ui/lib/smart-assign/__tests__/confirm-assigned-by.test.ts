import { describe, it, expect } from "vitest";
import { confirmAssignedBy } from "../confirm";

describe("confirmAssignedBy", () => {
  it("stamps 'human' for an item the user explicitly reassigned", () => {
    const reassigned = new Map<string, string>([["item-1", "group-x"]]);
    expect(confirmAssignedBy(reassigned, "item-1")).toBe("human");
  });

  it("stamps 'auto' for an item left on the machine's proposal", () => {
    const reassigned = new Map<string, string>([["item-1", "group-x"]]);
    expect(confirmAssignedBy(reassigned, "item-2")).toBe("auto");
  });

  it("stamps 'auto' when there are no reassignments", () => {
    expect(confirmAssignedBy(new Map(), "anything")).toBe("auto");
  });
});
