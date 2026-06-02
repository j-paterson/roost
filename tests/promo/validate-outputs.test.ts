import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_BURST_SLUGS,
  EXPECTED_SCREENSHOT_SLUGS,
  validateBurstDirs,
  validateMp4,
  validateScreenshots,
} from "../../scripts/promo/lib/validate-outputs.ts";

describe("promo validate-outputs", () => {
  let tmp = "";

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  });

  it("flags missing screenshots", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-val-"));
    const result = validateScreenshots(tmp);
    expect(result.ok).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it("accepts valid screenshot set", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-val-"));
    for (const slug of EXPECTED_SCREENSHOT_SLUGS) {
      fs.writeFileSync(path.join(tmp, `${slug}.png`), Buffer.alloc(12_000, 1));
    }
    fs.writeFileSync(path.join(tmp, "08-roost-hub.png"), Buffer.alloc(12_000, 1));
    const result = validateScreenshots(tmp);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("validates burst frame folders", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promo-burst-"));
    for (const slug of EXPECTED_BURST_SLUGS) {
      const dir = path.join(tmp, slug);
      fs.mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 16; i++) {
        fs.writeFileSync(
          path.join(dir, `frame-${String(i).padStart(4, "0")}.png`),
          Buffer.alloc(8_000, 1),
        );
      }
    }
    const result = validateBurstDirs(tmp, { minFrames: 12 });
    expect(result.ok).toBe(true);
  });

  it("validateMp4 detects missing file", () => {
    expect(validateMp4("/nonexistent/file.mp4")).toBe("missing");
  });
});
