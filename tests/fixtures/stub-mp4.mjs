// stub-mp4.mjs — generate a tiny, valid .mp4 placeholder for test fixtures.
//
// The real fixture videos (multi-MB, copied from a production vault) bloated
// git history. Nothing in the test suite reads video *bytes* — code only checks
// that a video file EXISTS at the expected path (see views/feed/card-helpers.ts
// `resolveVideoUrl`, which looks for media.mp4 / video.mp4 / media.mov). So a
// few-hundred-byte valid MP4 container is a perfect stand-in.
//
// Strategy:
//   1. If ffmpeg is available, emit a real, playable ~1-2 KB clip (16x16, 0.1s).
//   2. Otherwise, write a minimal but structurally-valid MP4 (ftyp + mdat) that
//      file-type sniffers recognize as video/mp4. Won't play, but exists & types
//      correctly — enough for path resolution and card rendering tests.
//
// Usage:
//   import { writeStubMp4, STUB_MP4 } from "./stub-mp4.mjs";
//   writeStubMp4("tests/fixtures/vault/Bookmarks/_assets/bm_0/media.mp4");
//
//   # or as a CLI to (re)create a placeholder at a path:
//   node tests/fixtures/stub-mp4.mjs path/to/media.mp4

import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";

/**
 * Minimal valid MP4: an `ftyp` box (major brand isom) followed by an empty
 * `mdat` box. Recognized as video/mp4 by content sniffers; ~32 bytes.
 */
function buildMinimalMp4() {
  const box = (type, body) => {
    const b = Buffer.from(body);
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + b.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, b]);
  };
  const ftyp = box("ftyp", Buffer.concat([
    Buffer.from("isom", "ascii"),        // major_brand
    Buffer.from([0x00, 0x00, 0x02, 0x00]), // minor_version
    Buffer.from("isomiso2mp41", "ascii"), // compatible_brands
  ]));
  const mdat = box("mdat", Buffer.alloc(0));
  return Buffer.concat([ftyp, mdat]);
}

export const STUB_MP4 = buildMinimalMp4();

/** True if a real ffmpeg-encoded clip was written, false if the minimal stub. */
export function writeStubMp4(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-f", "lavfi", "-i", "color=c=black:s=16x16:d=0.1",
       "-c:v", "libx264", "-pix_fmt", "yuv420p", filePath],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    fs.writeFileSync(filePath, STUB_MP4);
    return false;
  }
}

// CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const target = process.argv[2];
  if (!target) {
    console.error("usage: node stub-mp4.mjs <path/to/media.mp4>");
    process.exit(1);
  }
  const real = writeStubMp4(target);
  const bytes = fs.statSync(target).size;
  console.log(`Wrote ${real ? "ffmpeg" : "minimal"} stub (${bytes} bytes) -> ${target}`);
}
