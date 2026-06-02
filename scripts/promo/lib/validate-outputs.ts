import * as fs from "node:fs";
import * as path from "node:path";

/** PNGs produced by `99-promo-capture.spec.ts` (before hook + tests). */
export const EXPECTED_SCREENSHOT_SLUGS = [
  "01-sidebar-library",
  "01b-sidebar-crop",
  "02-gallery-recipes-grid",
  "02b-gallery-leaf",
  "03-gallery-recipes-expanded",
  "04-places-map-grid",
  "05-media-feed-split",
  "06-smart-assign-staging",
  "06b-staging-tree",
  "07-explorer-grid",
] as const;

/** Hub shot name varies if hub root is not found. */
export const HUB_SCREENSHOT_ALTERNATIVES = [
  "08-roost-hub",
  "08-roost-hub-fallback-window",
] as const;

/** Burst clip folders from `99b-promo-video-burst.spec.ts`. */
export const EXPECTED_BURST_SLUGS = [
  "02-gallery-recipes-grid",
  "04-places-map-grid",
  "06-smart-assign-staging",
] as const;

export const MIN_PNG_BYTES = 8_000;

export type ValidateResult = {
  ok: boolean;
  missing: string[];
  tooSmall: string[];
  found: string[];
};

export function validateScreenshots(
  screenshotsDir: string,
  minBytes = MIN_PNG_BYTES,
): ValidateResult {
  const missing: string[] = [];
  const tooSmall: string[] = [];
  const found: string[] = [];

  for (const slug of EXPECTED_SCREENSHOT_SLUGS) {
    const file = path.join(screenshotsDir, `${slug}.png`);
    const err = checkPng(file, minBytes);
    if (err === "missing") missing.push(slug);
    else if (err === "small") tooSmall.push(slug);
    else found.push(slug);
  }

  const hubOk = HUB_SCREENSHOT_ALTERNATIVES.some((slug) => {
    const file = path.join(screenshotsDir, `${slug}.png`);
    return checkPng(file, minBytes) === "ok";
  });
  if (!hubOk) {
    missing.push("08-roost-hub (or fallback)");
  } else {
    const slug = HUB_SCREENSHOT_ALTERNATIVES.find((s) => {
      const file = path.join(screenshotsDir, `${s}.png`);
      return checkPng(file, minBytes) === "ok";
    })!;
    found.push(slug);
  }

  return {
    ok: missing.length === 0 && tooSmall.length === 0,
    missing,
    tooSmall,
    found,
  };
}

export function validateBurstDirs(
  burstsDir: string,
  opts?: { minFrames?: number; minBytesPerFrame?: number },
): ValidateResult {
  const minFrames = opts?.minFrames ?? 12;
  const minBytes = opts?.minBytesPerFrame ?? 5_000;
  const missing: string[] = [];
  const tooSmall: string[] = [];
  const found: string[] = [];

  for (const slug of EXPECTED_BURST_SLUGS) {
    const dir = path.join(burstsDir, slug);
    if (!fs.existsSync(dir)) {
      missing.push(slug);
      continue;
    }
    const frames = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    if (frames.length < minFrames) {
      missing.push(`${slug} (${frames.length}/${minFrames} frames)`);
      continue;
    }
    const bad = frames.find((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return stat.size < minBytes;
    });
    if (bad) tooSmall.push(`${slug}/${bad}`);
    else found.push(slug);
  }

  return {
    ok: missing.length === 0 && tooSmall.length === 0,
    missing,
    tooSmall,
    found,
  };
}

export function validateMp4(
  filePath: string,
  minBytes = 20_000,
): "ok" | "missing" | "small" {
  if (!fs.existsSync(filePath)) return "missing";
  if (fs.statSync(filePath).size < minBytes) return "small";
  return "ok";
}

function checkPng(
  filePath: string,
  minBytes: number,
): "ok" | "missing" | "small" {
  if (!fs.existsSync(filePath)) return "missing";
  if (fs.statSync(filePath).size < minBytes) return "small";
  return "ok";
}
