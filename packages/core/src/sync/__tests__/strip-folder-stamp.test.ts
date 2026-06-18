import { describe, it, expect } from "vitest";
import { stripFolderStampFromFrontmatter } from "../../../../../scripts/strip-folder-stamp.mjs";

const NOTE = `---\nroost_id: twitter:1\nplatform: twitter\nenrichment_v_folder: 1\ncollection: Recipes\n---\n\nbody text\n`;

describe("stripFolderStampFromFrontmatter", () => {
  it("removes only the enrichment_v_folder line, keeps everything else", () => {
    const { content, changed } = stripFolderStampFromFrontmatter(NOTE);
    expect(changed).toBe(true);
    expect(content).toBe(`---\nroost_id: twitter:1\nplatform: twitter\ncollection: Recipes\n---\n\nbody text\n`);
  });

  it("is a no-op on a note without the key", () => {
    const clean = `---\nroost_id: twitter:2\n---\n\nbody\n`;
    const { content, changed } = stripFolderStampFromFrontmatter(clean);
    expect(changed).toBe(false);
    expect(content).toBe(clean);
  });

  it("does not touch a matching string in the body", () => {
    const tricky = `---\nroost_id: twitter:3\n---\n\nenrichment_v_folder: 1 in prose\n`;
    expect(stripFolderStampFromFrontmatter(tricky).changed).toBe(false);
  });

  it("handles CRLF frontmatter (strips the line, preserves CRLF on the rest)", () => {
    const crlf = `---\r\nroost_id: twitter:4\r\nenrichment_v_folder: 1\r\ncollection: AI\r\n---\r\n\r\nbody\r\n`;
    const { content, changed } = stripFolderStampFromFrontmatter(crlf);
    expect(changed).toBe(true);
    expect(content).toBe(`---\r\nroost_id: twitter:4\r\ncollection: AI\r\n---\r\n\r\nbody\r\n`);
  });
});
