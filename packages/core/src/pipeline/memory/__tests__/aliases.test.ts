import { describe, it, expect } from "vitest";
import { parseAliases, serializeAliases, lookupAlias, addAliases } from "../aliases";

describe("aliases parse/serialize", () => {
  it("parses a flat JSON object", () => {
    const json = '{"ai agents": "ai-agents", "rlhf": "rl-from-human-feedback"}';
    const a = parseAliases(json);
    expect(a["ai agents"]).toBe("ai-agents");
    expect(a["rlhf"]).toBe("rl-from-human-feedback");
  });

  it("returns empty object for malformed JSON", () => {
    expect(parseAliases("not json")).toEqual({});
    expect(parseAliases("")).toEqual({});
  });

  it("returns empty object for non-object JSON", () => {
    expect(parseAliases("[]")).toEqual({});
    expect(parseAliases("123")).toEqual({});
    expect(parseAliases("null")).toEqual({});
  });

  it("filters out non-string values", () => {
    const a = parseAliases('{"ok": "slug", "bad": 123}');
    expect(a).toEqual({ ok: "slug" });
  });

  it("round-trips serialize", () => {
    const a = { "ai agents": "ai-agents", "rlhf": "rl-from-human-feedback" };
    const json = serializeAliases(a);
    expect(parseAliases(json)).toEqual(a);
  });

  it("serializes keys sorted alphabetically", () => {
    const json = serializeAliases({ "z": "zz", "a": "aa", "m": "mm" });
    const keys = json.match(/"[^"]+":/g);
    expect(keys).toEqual(['"a":', '"m":', '"z":']);
  });

  it("returns empty object for an empty JSON object", () => {
    expect(parseAliases("{}")).toEqual({});
  });
});

describe("lookupAlias (case-insensitive substring match)", () => {
  const aliases = {
    "ai agents": "ai-agents",
    "agentic workflows": "ai-agents",
    "rlhf": "rl-from-human-feedback",
  };

  it("matches exact lowercased keyword", () => {
    expect(lookupAlias("AI Agents", aliases)).toBe("ai-agents");
    expect(lookupAlias("rlhf", aliases)).toBe("rl-from-human-feedback");
  });

  it("matches substring within a longer headline", () => {
    expect(lookupAlias("This week: AI agents take over", aliases)).toBe("ai-agents");
    expect(lookupAlias("RLHF is back", aliases)).toBe("rl-from-human-feedback");
  });

  it("returns null when no alias matches", () => {
    expect(lookupAlias("completely unrelated topic", aliases)).toBeNull();
  });

  it("returns longest-match-wins when multiple aliases match", () => {
    const a = {
      "ai": "ai",
      "ai agents": "ai-agents",
    };
    expect(lookupAlias("AI agents news", a)).toBe("ai-agents");
  });

  it("returns null for empty aliases map", () => {
    expect(lookupAlias("anything", {})).toBeNull();
  });

  it("returns null for empty headline", () => {
    expect(lookupAlias("", aliases)).toBeNull();
  });
});

describe("addAliases", () => {
  it("adds new entries without overwriting existing", () => {
    const start = { "existing": "existing-slug" };
    const after = addAliases(start, "new-slug", ["new alias", "another form"]);
    expect(after).toEqual({
      "existing": "existing-slug",
      "new alias": "new-slug",
      "another form": "new-slug",
    });
  });

  it("does not overwrite an existing alias key", () => {
    const start = { "shared key": "first-slug" };
    const after = addAliases(start, "second-slug", ["shared key", "unique"]);
    expect(after["shared key"]).toBe("first-slug");
    expect(after["unique"]).toBe("second-slug");
  });

  it("lowercases incoming alias surface forms", () => {
    const after = addAliases({}, "slug", ["UPPER Form"]);
    expect(after["upper form"]).toBe("slug");
  });

  it("trims whitespace from alias surface forms", () => {
    const after = addAliases({}, "slug", ["  spacey  "]);
    expect(after["spacey"]).toBe("slug");
  });

  it("skips empty / whitespace-only entries", () => {
    const after = addAliases({}, "slug", ["", "   ", "valid"]);
    expect(after).toEqual({ "valid": "slug" });
  });

  it("returns a new object (does not mutate input)", () => {
    const start = { "x": "x-slug" };
    const after = addAliases(start, "y-slug", ["y"]);
    expect(start).toEqual({ "x": "x-slug" });
    expect(after).not.toBe(start);
  });
});
