import { describe, it, expect } from "vitest";
import type { App, BasesEntry } from "obsidian";
import { detectContentType, extractDomain, ContentType } from "../content-detector";

function mkEntry(
  file: { extension?: string; path?: string },
  fm: Record<string, unknown> = {},
): BasesEntry {
  return {
    file: { extension: file.extension, path: file.path ?? "x.md", basename: "x" },
    getValue: (k: string) => fm[k],
  } as unknown as BasesEntry;
}

const app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;

describe("detectContentType", () => {
  it("returns Media for media file extensions (png, mp4, pdf)", () => {
    expect(detectContentType(mkEntry({ extension: "png" }), app)).toBe(ContentType.Media);
    expect(detectContentType(mkEntry({ extension: "mp4" }), app)).toBe(ContentType.Media);
    expect(detectContentType(mkEntry({ extension: "pdf" }), app)).toBe(ContentType.Media);
    expect(detectContentType(mkEntry({ extension: "jpg" }), app)).toBe(ContentType.Media);
  });

  it("returns Bookmark when entry has a valid roost_id", () => {
    const entry = mkEntry({ extension: "md" }, { "note.roost_id": "abc123" });
    expect(detectContentType(entry, app)).toBe(ContentType.Bookmark);
  });

  it("does NOT return Bookmark when roost_id is the string 'null'", () => {
    const entry = mkEntry({ extension: "md" }, { "note.roost_id": "null" });
    // hasValue rejects "null" string — should fall through to Note (no url, no cover)
    expect(detectContentType(entry, app)).toBe(ContentType.Note);
  });

  it("does NOT return Bookmark when roost_id is the string 'undefined'", () => {
    const entry = mkEntry({ extension: "md" }, { "note.roost_id": "undefined" });
    expect(detectContentType(entry, app)).toBe(ContentType.Note);
  });

  it("returns Link for http/https url when no roost_id and no resolvable attachment", () => {
    const entry = mkEntry({ extension: "md" }, { "note.url": "https://example.com/x" });
    expect(detectContentType(entry, app)).toBe(ContentType.Link);
  });

  it("returns Link for http url", () => {
    const entry = mkEntry({ extension: "md" }, { "note.url": "http://example.com/x" });
    expect(detectContentType(entry, app)).toBe(ContentType.Link);
  });

  it("does NOT return Link for non-http url (falls through to Note)", () => {
    const entry = mkEntry({ extension: "md" }, { "note.url": "mailto:a@b.c" });
    expect(detectContentType(entry, app)).toBe(ContentType.Note);
  });

  it("returns Note when no roost_id, no cover/banner, no url", () => {
    const entry = mkEntry({ extension: "md" });
    expect(detectContentType(entry, app)).toBe(ContentType.Note);
  });
});

describe("extractDomain", () => {
  it("strips www. prefix from domain", () => {
    expect(extractDomain("https://www.example.com/path")).toBe("example.com");
  });

  it("preserves subdomain without www.", () => {
    expect(extractDomain("http://sub.example.co.uk")).toBe("sub.example.co.uk");
  });

  it("returns raw string on parse failure", () => {
    expect(extractDomain("not a url")).toBe("not a url");
  });
});
