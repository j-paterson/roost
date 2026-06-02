import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readRawJson } from "@/pipeline/shared";
import { Vault, FileSystemAdapter } from "obsidian";

function makeVault(basePath: string): Vault {
  const adapter = new FileSystemAdapter();
  adapter.basePath = basePath;
  const v = new Vault() as Vault & { adapter: FileSystemAdapter };
  v.adapter = adapter;
  return v;
}

describe("readRawJson", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roost-rawjson-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads twitter raw.json under /X/twitter-<id>/", () => {
    const syncFolder = "Bookmarks";
    const dir = path.join(tmp, syncFolder, "X", "twitter-12345");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify({ text: "hi" }));
    const raw = readRawJson(makeVault(tmp), syncFolder, "twitter:12345");
    expect(raw).toEqual({ text: "hi" });
  });

  it("reads tiktok raw.json under /TikTok/tiktok-<id>/", () => {
    const syncFolder = "Bookmarks";
    const dir = path.join(tmp, syncFolder, "TikTok", "tiktok-abc");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "raw.json"), JSON.stringify({ desc: "hi" }));
    const raw = readRawJson(makeVault(tmp), syncFolder, "tiktok:abc");
    expect(raw).toEqual({ desc: "hi" });
  });

  it("returns null when the file is missing", () => {
    const raw = readRawJson(makeVault(tmp), "Bookmarks", "twitter:missing");
    expect(raw).toBeNull();
  });

  it("returns null when the roostId has no platform prefix", () => {
    expect(readRawJson(makeVault(tmp), "Bookmarks", "notaroostid")).toBeNull();
  });

  it("returns null on unknown platform", () => {
    expect(readRawJson(makeVault(tmp), "Bookmarks", "instagram:999")).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const dir = path.join(tmp, "Bookmarks", "X", "twitter-999");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "raw.json"), "{not json");
    expect(readRawJson(makeVault(tmp), "Bookmarks", "twitter:999")).toBeNull();
  });
});
