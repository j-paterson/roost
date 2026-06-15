import { describe, it, expect } from "vitest";
import { extractTwitterMedia } from "../extract";
import type { BookmarkRecord } from "../extract";

function makeTwitterRecord(rawOverrides: Record<string, unknown> = {}): BookmarkRecord {
  return {
    platform: "twitter",
    itemId: "123",
    rawData: {
      rest_id: "123",
      core: {
        user_results: {
          result: { core: { name: "Test", screen_name: "testuser" } },
        },
      },
      legacy: { full_text: "hello" },
      ...rawOverrides,
    },
  };
}

describe("extractTwitterMedia — bookmark folder", () => {
  it("returns folder from raw._bookmark_folder when present", () => {
    const rec = makeTwitterRecord({ _bookmark_folder: "My Reads" });
    const result = extractTwitterMedia(rec);
    expect(result.folder).toBe("My Reads");
  });

  it("returns null when _bookmark_folder is absent", () => {
    const rec = makeTwitterRecord();
    const result = extractTwitterMedia(rec);
    expect(result.folder).toBeNull();
  });

  it("returns null when _bookmark_folder is empty string", () => {
    const rec = makeTwitterRecord({ _bookmark_folder: "" });
    const result = extractTwitterMedia(rec);
    expect(result.folder).toBeNull();
  });
});
