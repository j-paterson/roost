#!/usr/bin/env npx tsx
/**
 * Experiment B: stitch promo PNGs into one carousel MP4 (ffmpeg, no new deps).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promoVideoScalePadFilter } from "./lib/dimensions.mts";
import { EXPECTED_SCREENSHOT_SLUGS, HUB_SCREENSHOT_ALTERNATIVES } from "./lib/validate-outputs.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const screenshotsDir = path.join(repoRoot, "docs/promo/screenshots");
const videosDir = path.join(repoRoot, "docs/promo/videos");
const outFile = path.join(videosDir, "carousel-slideshow.mp4");

const fps = Number(process.env.PROMO_SLIDESHOW_FPS ?? 2);
const secondsPerSlide = Number(process.env.PROMO_SLIDESHOW_SEC ?? 2.5);

function resolveFfmpeg(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  try {
    return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("ffmpeg not found. Install via brew install ffmpeg or set FFMPEG_PATH.");
  }
}

function collectSlides(): string[] {
  const slides: string[] = [];
  for (const slug of EXPECTED_SCREENSHOT_SLUGS) {
    const file = path.join(screenshotsDir, `${slug}.png`);
    if (fs.existsSync(file)) slides.push(file);
  }
  for (const slug of HUB_SCREENSHOT_ALTERNATIVES) {
    const file = path.join(screenshotsDir, `${slug}.png`);
    if (fs.existsSync(file)) {
      slides.push(file);
      break;
    }
  }
  if (slides.length === 0) {
    throw new Error(`No PNGs in ${screenshotsDir}. Run: npm run capture:promo`);
  }
  return slides;
}

function main(): void {
  const ffmpeg = resolveFfmpeg();
  const slides = collectSlides();
  fs.mkdirSync(videosDir, { recursive: true });

  const listFile = path.join(videosDir, ".concat-list.txt");
  const lines = slides.flatMap((file) => [
    `file '${file.replace(/'/g, "'\\''")}'`,
    `duration ${secondsPerSlide}`,
  ]);
  lines.push(`file '${slides[slides.length - 1]!.replace(/'/g, "'\\''")}'`);
  fs.writeFileSync(listFile, lines.join("\n"));

  console.log(`Encoding ${slides.length} slides → ${outFile}`);
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-vf",
      `fps=${fps},${promoVideoScalePadFilter()}`,
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

  fs.unlinkSync(listFile);
  const kb = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`Done: ${outFile} (${kb} KB)`);
}

main();
