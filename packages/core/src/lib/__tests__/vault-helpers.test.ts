import { describe, it, expect, vi } from "vitest";
import { writeNoteSafe, buildFrontmatter, updateNoteFrontmatter } from "@/lib/vault-helpers";

function makeVaultPath1(existing: any) {
  return {
    getAbstractFileByPath: vi.fn(() => existing),
    modify: vi.fn(async () => {}),
    create: vi.fn(async () => { throw new Error("should not be called"); }),
    adapter: { write: vi.fn(async () => { throw new Error("should not be called"); }) },
  };
}

function makeVaultPath2() {
  let callCount = 0;
  const foundLater = { path: "note.md" };
  return {
    getAbstractFileByPath: vi.fn(() => {
      callCount++;
      return callCount === 1 ? null : foundLater;
    }),
    modify: vi.fn(async () => {}),
    create: vi.fn(async () => { throw new Error("File already exists: note.md"); }),
    adapter: { write: vi.fn(async () => { throw new Error("should not be called"); }) },
    _foundLater: foundLater,
  };
}

function makeVaultPath3() {
  return {
    getAbstractFileByPath: vi.fn(() => null),
    modify: vi.fn(async () => { throw new Error("should not be called"); }),
    create: vi.fn(async () => { throw new Error("File already exists: note.md"); }),
    adapter: { write: vi.fn(async () => {}) },
  };
}

function makeVaultPath4() {
  return {
    getAbstractFileByPath: vi.fn(() => null),
    modify: vi.fn(async () => { throw new Error("should not be called"); }),
    create: vi.fn(async () => {}),
    adapter: { write: vi.fn(async () => { throw new Error("should not be called"); }) },
  };
}

describe("writeNoteSafe", () => {
  it("uses modify when file is already indexed", async () => {
    const existing = { path: "note.md" };
    const v = makeVaultPath1(existing);
    await writeNoteSafe(v as any, "note.md", "hello");
    expect(v.modify).toHaveBeenCalledWith(existing, "hello");
    expect(v.create).not.toHaveBeenCalled();
    expect(v.adapter.write).not.toHaveBeenCalled();
  });

  it("falls back to modify when create throws 'File already exists' and re-query finds it", async () => {
    const v = makeVaultPath2();
    await writeNoteSafe(v as any, "note.md", "hello");
    expect(v.create).toHaveBeenCalledTimes(1);
    expect(v.modify).toHaveBeenCalledWith(v._foundLater, "hello");
    expect(v.adapter.write).not.toHaveBeenCalled();
  });

  it("falls back to adapter.write when create throws and re-query still returns null", async () => {
    const v = makeVaultPath3();
    await writeNoteSafe(v as any, "note.md", "hello");
    expect(v.create).toHaveBeenCalledTimes(1);
    expect(v.adapter.write).toHaveBeenCalledWith("note.md", "hello");
    expect(v.modify).not.toHaveBeenCalled();
  });

  it("calls create for a new file with no fallback", async () => {
    const v = makeVaultPath4();
    await writeNoteSafe(v as any, "note.md", "hello");
    expect(v.create).toHaveBeenCalledWith("note.md", "hello");
    expect(v.modify).not.toHaveBeenCalled();
    expect(v.adapter.write).not.toHaveBeenCalled();
  });

  it("rethrows non-'already exists' create errors", async () => {
    const v = {
      getAbstractFileByPath: vi.fn(() => null),
      modify: vi.fn(),
      create: vi.fn(async () => { throw new Error("EACCES: permission denied"); }),
      adapter: { write: vi.fn() },
    };
    await expect(writeNoteSafe(v as any, "note.md", "x")).rejects.toThrow(/EACCES/);
    expect(v.adapter.write).not.toHaveBeenCalled();
  });
});

// Helper: every line in a buildFrontmatter/updateNoteFrontmatter block must be
// a key line or an array-item line — no stray lines from injected values.
function assertNoStrayLines(block: string) {
  for (const line of block.split("\n")) {
    const isKeyLine = /^[\w-]+:/.test(line);
    const isArrayItem = /^  - /.test(line);
    expect(isKeyLine || isArrayItem, `Stray line detected: ${JSON.stringify(line)}`).toBe(true);
  }
}

describe("buildFrontmatter", () => {
  it("escapes literal newline + frontmatter separator injection in string values", () => {
    const result = buildFrontmatter({ title: "a\n---\nb" });
    // The value must be on a single line using YAML \\n escape sequences
    expect(result).toBe('title: "a\\n---\\nb"');
    assertNoStrayLines(result);
  });

  it("escapes hashtag containing a colon in array items", () => {
    const result = buildFrontmatter({ tags: ["foo: bar"] });
    expect(result).toContain('  - "foo: bar"');
    assertNoStrayLines(result);
  });

  it("escapes array item starting with a dash", () => {
    const result = buildFrontmatter({ tags: ["- item"] });
    expect(result).toContain('  - "- item"');
    assertNoStrayLines(result);
  });

  it("escapes hashtag containing a hash sign", () => {
    const result = buildFrontmatter({ tags: ["#fyp"] });
    expect(result).toContain('  - "#fyp"');
    assertNoStrayLines(result);
  });

  it("does not over-quote plain values (regression guard)", () => {
    const result = buildFrontmatter({ title: "hello world", tags: ["cooking"] });
    expect(result).toContain("title: hello world");
    expect(result).toContain("  - cooking");
    assertNoStrayLines(result);
  });

  it("round-trips quotes and backslashes correctly", () => {
    const result = buildFrontmatter({ title: 'say "hi" \\ bye' });
    expect(result).toBe('title: "say \\"hi\\" \\\\ bye"');
    assertNoStrayLines(result);
  });

  it("escapes carriage return and tab in string values", () => {
    const result = buildFrontmatter({ title: "line1\r\nline2\ttabbed" });
    expect(result).toBe('title: "line1\\r\\nline2\\ttabbed"');
    assertNoStrayLines(result);
  });

  it("quotes empty string values", () => {
    const result = buildFrontmatter({ title: "" });
    expect(result).toBe('title: ""');
    assertNoStrayLines(result);
  });
});

describe("updateNoteFrontmatter", () => {
  it("produces exactly one frontmatter separator and preserves body after hostile update", () => {
    const content = "---\ntitle: old\n---\nbody text";
    const result = updateNoteFrontmatter(content, {
      tags: ["a: b"],
      title: "x\ny",
    });
    expect(result).not.toBeNull();
    // Only one \n---\n separator should exist (after the frontmatter block)
    const separatorCount = (result!.match(/\n---\n/g) || []).length;
    expect(separatorCount).toBe(1);
    // Body must be unchanged
    expect(result!.endsWith("\nbody text")).toBe(true);
    // Tags should be escaped
    expect(result!).toContain('  - "a: b"');
    // Title with newline must be escaped
    expect(result!).toContain('title: "x\\ny"');
  });
});
