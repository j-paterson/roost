#!/usr/bin/env npx tsx
/**
 * Verify promo capture outputs exist and meet minimum size thresholds.
 *
 * Usage:
 *   npx tsx scripts/promo/verify-capture.mts
 *   npx tsx scripts/promo/verify-capture.mts --bursts --videos
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateBurstDirs,
  validateScreenshots,
} from "./lib/validate-outputs.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screenshotsDir = path.join(repoRoot, "docs/promo/screenshots");
const burstsDir = path.join(repoRoot, "docs/promo/bursts");
const videosDir = path.join(repoRoot, "docs/promo/videos");

const checkBursts = process.argv.includes("--bursts");
const checkVideos = process.argv.includes("--videos");

function printResult(label: string, result: ReturnType<typeof validateScreenshots>): void {
  console.log(`\n${label}`);
  if (result.found.length) console.log(`  ok (${result.found.length}): ${result.found.join(", ")}`);
  if (result.missing.length) console.log(`  missing: ${result.missing.join(", ")}`);
  if (result.tooSmall.length) console.log(`  too small: ${result.tooSmall.join(", ")}`);
}

const shots = validateScreenshots(screenshotsDir);
printResult("Screenshots (capture:promo)", shots);

let exitCode = shots.ok ? 0 : 1;

if (checkBursts) {
  const bursts = validateBurstDirs(burstsDir);
  printResult("Burst frames (capture:promo:burst)", bursts);
  if (!bursts.ok) exitCode = 1;
}

if (checkVideos) {
  console.log("\nVideos (docs/promo/videos/)");
  if (!fs.existsSync(videosDir)) {
    console.log("  missing: videos directory (run promo:slideshow or promo:bursts:encode)");
    exitCode = 1;
  } else {
    const mp4s = fs.readdirSync(videosDir).filter((f) => f.endsWith(".mp4"));
    if (mp4s.length === 0) {
      console.log("  missing: no .mp4 files");
      exitCode = 1;
    } else {
      for (const f of mp4s) {
        const size = fs.statSync(path.join(videosDir, f)).size;
        console.log(`  ok: ${f} (${Math.round(size / 1024)} KB)`);
      }
    }
  }
}

if (!shots.ok) {
  console.log("\nRun: npm run capture:promo");
}
process.exit(exitCode);
