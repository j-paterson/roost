import { describe, it, expect } from "vitest";
import { extractDescription } from "@/pipeline/shared";

describe("extractDescription", () => {
  it("returns TikTok contents joined with newlines when present", () => {
    const raw = { contents: [{ desc: "line 1" }, { desc: "line 2" }] };
    expect(extractDescription(raw)).toBe("line 1\nline 2");
  });

  it("falls back to TikTok desc when contents missing", () => {
    expect(extractDescription({ desc: "caption" })).toBe("caption");
  });

  it("returns Twitter full_text when present", () => {
    expect(extractDescription({ full_text: "tweet body" })).toBe("tweet body");
  });

  it("falls back to Twitter text when full_text missing", () => {
    expect(extractDescription({ text: "tweet body" })).toBe("tweet body");
  });

  it("prefers contents over desc when both present", () => {
    const raw = { desc: "caption", contents: [{ desc: "richer" }] };
    expect(extractDescription(raw)).toBe("richer");
  });

  it("ignores contents entries that lack a desc string", () => {
    const raw = { contents: [{ desc: "a" }, { other: "x" }, { desc: "b" }] };
    expect(extractDescription(raw)).toBe("a\nb");
  });

  it("returns empty string when nothing is usable", () => {
    expect(extractDescription({})).toBe("");
    expect(extractDescription(null)).toBe("");
    expect(extractDescription({ foo: 1 })).toBe("");
  });
});
