#!/usr/bin/env npx tsx
/**
 * Experiment D: Playwright CDP screencast → H.264 MP4 (validates toolchain for web targets).
 * Does not drive Obsidian; uses tests/promo/fixtures/demo-page.html as a stand-in.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import {
  PROMO_VIDEO_HEIGHT,
  PROMO_VIDEO_WIDTH,
} from "../lib/dimensions.mts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const demoHtml = path.join(repoRoot, "tests/promo/fixtures/demo-page.html");
const videosDir = path.join(repoRoot, "docs/promo/videos");
const outFile = path.join(videosDir, "experiment-d-playwright-screencast.mp4");
const size = { width: PROMO_VIDEO_WIDTH, height: PROMO_VIDEO_HEIGHT };
const fps = 25;

function resolveFfmpeg(): string {
  const env = process.env.FFMPEG_PATH;
  if (env && fs.existsSync(env)) return env;
  return execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const ffmpeg = resolveFfmpeg();
  fs.mkdirSync(videosDir, { recursive: true });
  const demoUrl = `file://${demoHtml}`;

  const ff = spawn(
    ffmpeg,
    [
      "-y",
      "-f",
      "image2pipe",
      "-vcodec",
      "mjpeg",
      "-r",
      String(fps),
      "-i",
      "-",
      "-an",
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      outFile,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: size });

  await page.screencast.start({
    size,
    quality: 85,
    onFrame: async (frame) => {
      ff.stdin.write(frame.data);
    },
  });

  await page.goto(demoUrl);
  await page.waitForTimeout(800);
  await page.click("#run-btn");
  await page.waitForTimeout(3_200);
  await page.hover(".tile:first-child");
  await page.waitForTimeout(600);

  await page.screencast.stop();
  ff.stdin.end();

  await new Promise<void>((resolve, reject) => {
    ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))));
  });

  await browser.close();

  const kb = Math.round(fs.statSync(outFile).size / 1024);
  console.log(`Experiment D output: ${outFile} (${kb} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
