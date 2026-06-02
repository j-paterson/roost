import { describe, it, expect, vi } from "vitest";
import { writeNoteSafe } from "@/lib/vault-helpers";

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
