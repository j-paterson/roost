import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadPipelineCache, savePipelineCache } from "@/pipeline/shared";
import { Vault, FileSystemAdapter } from "obsidian";

function makeVault(basePath: string): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = basePath;
  const v = new Vault() as Vault & { adapter: FileSystemAdapter };
  v.adapter = adapter;
  return v;
}

interface TestEntry {
  triage: string;
  n: number;
}

describe("loadPipelineCache / savePipelineCache", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-pcache-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns {} when the cache file does not exist", () => {
    const cache = loadPipelineCache<TestEntry>(makeVault(tmp), "thing-cache.json");
    expect(cache).toEqual({});
  });

  it("round-trips entries via save then load", () => {
    const vault = makeVault(tmp);
    const written = { "twitter:1": { triage: "recipe", n: 1 }, "tiktok:2": { triage: "skip", n: 2 } };
    savePipelineCache(vault, "thing-cache.json", written);
    const read = loadPipelineCache<TestEntry>(vault, "thing-cache.json");
    expect(read).toEqual(written);
  });

  it("creates the .roost/cache directory if missing", () => {
    const vault = makeVault(tmp);
    savePipelineCache(vault, "x.json", { a: { triage: "t", n: 0 } });
    expect(fs.existsSync(path.join(tmp, ".roost", "cache", "x.json"))).toBe(true);
  });

  it("returns {} on malformed JSON", () => {
    fs.mkdirSync(path.join(tmp, ".roost", "cache"), { recursive: true });
    fs.writeFileSync(path.join(tmp, ".roost", "cache", "broken.json"), "{not json");
    expect(loadPipelineCache<TestEntry>(makeVault(tmp), "broken.json")).toEqual({});
  });
});
