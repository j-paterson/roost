import { describe, it, expect } from "vitest";

// The patchFor closure under test, extracted as a pure helper:
function patchForFilter(value: string): Record<string, string | null> {
  const sep = value.indexOf("\x00");
  if (sep < 0) {
    return { roost_category: value, roost_subcategory: null, roost_assigned_by: "auto" };
  }
  const category = value.slice(0, sep);
  const subcategory = value.slice(sep + 1);
  return {
    roost_category: category,
    roost_subcategory: subcategory || null,
    roost_assigned_by: "auto",
  };
}

describe("handleConfirm composite-key encoding", () => {
  it("encodes leaf assignments correctly", () => {
    const patch = patchForFilter("Recipes\x00Italian");
    expect(patch.roost_category).toBe("Recipes");
    expect(patch.roost_subcategory).toBe("Italian");
  });

  it("encodes parent-only assignments correctly", () => {
    const patch = patchForFilter("Recipes\x00");
    expect(patch.roost_category).toBe("Recipes");
    expect(patch.roost_subcategory).toBe(null);
  });

  it("legacy path (no separator) still works as parent-only", () => {
    const patch = patchForFilter("Workouts");
    expect(patch.roost_category).toBe("Workouts");
    expect(patch.roost_subcategory).toBe(null);
  });

  it("category names with spaces roundtrip", () => {
    const patch = patchForFilter("Media List\x00Books");
    expect(patch.roost_category).toBe("Media List");
    expect(patch.roost_subcategory).toBe("Books");
  });

  it("subcategory names with spaces roundtrip", () => {
    const patch = patchForFilter("Recipes\x00Italian Pasta");
    expect(patch.roost_category).toBe("Recipes");
    expect(patch.roost_subcategory).toBe("Italian Pasta");
  });
});
