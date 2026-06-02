import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const experimentScripts = [
  "scripts/promo/verify-capture.mts",
  "scripts/promo/ffmpeg-slideshow.mts",
  "scripts/promo/ffmpeg-bursts.mts",
  "scripts/promo/experiments/playwright-screencast.mts",
  "tests/promo/fixtures/demo-page.html",
];

describe("promo experiment harness", () => {
  for (const rel of experimentScripts) {
    it(`includes ${rel}`, () => {
      expect(fs.existsSync(path.join(repoRoot, rel))).toBe(true);
    });
  }

  it("ffmpeg is available when PROMO_REQUIRE_FFMPEG=1", () => {
    if (process.env.PROMO_REQUIRE_FFMPEG !== "1") return;
    expect(() => execFileSync("which", ["ffmpeg"], { encoding: "utf8" })).not.toThrow();
  });

  it("playwright is installed when PROMO_REQUIRE_PLAYWRIGHT=1", () => {
    if (process.env.PROMO_REQUIRE_PLAYWRIGHT !== "1") return;
    const pkg = path.join(repoRoot, "node_modules/playwright/package.json");
    expect(fs.existsSync(pkg)).toBe(true);
  });
});
