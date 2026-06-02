import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const vaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "vault/Bookmarks",
);

function readFm(filePath: string): Record<string, unknown> {
  const text = fs.readFileSync(filePath, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---/);
  expect(match).toBeTruthy();
  const fm: Record<string, unknown> = {};
  for (const line of match![1].split("\n")) {
    const m = line.match(/^([a-z0-9_]+):\s*(.+)$/i);
    if (!m) continue;
    const key = m[1];
    const raw = m[2].trim();
    if (raw === "null") {
      fm[key] = null;
      continue;
    }
    try {
      fm[key] = JSON.parse(raw);
    } catch {
      fm[key] = raw;
    }
  }
  return fm;
}

describe("fixture vault quality", () => {
  it("categorized bookmarks have titles and no null literals in frontmatter", () => {
    const files = fs.readdirSync(vaultRoot).filter((f) => /^bm_\d+\.md$/.test(f));
    expect(files.length).toBe(35);
    for (const file of files) {
      const fm = readFm(path.join(vaultRoot, file));
      expect(fm.title, file).toBeTruthy();
      for (const [k, v] of Object.entries(fm)) {
        expect(v, `${file}.${k}`).not.toBe(null);
        expect(String(v), `${file}.${k}`).not.toBe("null");
      }
    }
  });

  it("every Recipes bookmark has recipe_cuisine", () => {
    for (let i = 0; i < 5; i++) {
      const fm = readFm(path.join(vaultRoot, `bm_${i}.md`));
      expect(fm.roost_category).toBe("Recipes");
      expect(fm.recipe_cuisine).toBeTruthy();
      expect(fm.recipe_dish).toBeTruthy();
    }
  });

  it("Places bookmarks have coordinates for map pins", () => {
    for (let i = 5; i < 10; i++) {
      const fm = readFm(path.join(vaultRoot, `bm_${i}.md`));
      expect(fm.place_city).toBeTruthy();
      expect(typeof fm.place_lat).toBe("number");
      expect(typeof fm.place_lng).toBe("number");
    }
  });

  it("Media list fixtures have creator and where", () => {
    for (let i = 10; i < 15; i++) {
      const fm = readFm(path.join(vaultRoot, `bm_${i}.md`));
      expect(fm.media_title).toBeTruthy();
      expect(fm.media_creator).toBeTruthy();
      expect(fm.media_where).toBeTruthy();
    }
  });
});
