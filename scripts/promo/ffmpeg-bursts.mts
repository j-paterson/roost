#!/usr/bin/env npx tsx
/**
 * Experiment C: encode each burst frame folder to a short MP4 (WDIO screenshot sequence).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promoVideoScalePadFilter } from "./lib/dimensions.mts";
import { EXPECTED_BURST_SLUGS } from "./lib/validate-outputs.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const burstsDir = path.join(repoRoot, "docs/promo/bursts");
const videosDir = path.join(repoRoot, "docs/promo/videos");

const fps = Number(process.env.PROMO_BURST_FPS ?? 10);

function resolveFfmpeg(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
}

function encodeBurst(ffmpeg: string, slug: string): string {
  const dir = path.join(burstsDir, slug);
  if (!fs.existsSync(dir)) {
    throw new Error(`Missing burst dir ${dir}. Run: npm run capture:promo:burst`);
  }
  const pattern = path.join(dir, "frame-%04d.png");
  const outFile = path.join(videosDir, `${slug}.mp4`);
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-framerate",
      String(fps),
      "-i",
      pattern,
      "-vf",
      promoVideoScalePadFilter(),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "20",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outFile,
    ],
    { stdio: "inherit" },
  );
  return outFile;
}

function main(): void {
  const ffmpeg = resolveFfmpeg();
  fs.mkdirSync(videosDir, { recursive: true });
  const outputs: string[] = [];
  for (const slug of EXPECTED_BURST_SLUGS) {
    console.log(`\nEncoding burst: ${slug}`);
    outputs.push(encodeBurst(ffmpeg, slug));
  }
  console.log("\nBurst clips:");
  for (const f of outputs) {
    console.log(`  ${f} (${Math.round(fs.statSync(f).size / 1024)} KB)`);
  }
}

main();
