// @vitest-environment node
/**
 * Regression guard for muxRedditVideo's ffmpeg invocation.
 *
 * The v.redd.it audio mux silently fell back to video-only for EVERY
 * audio-bearing video because the execFileSync args passed `-user_agent` and
 * `-headers` (HTTP-protocol input options) before `-i <local temp file>`.
 * ffmpeg rejects those options for file inputs ("Option user_agent not found"),
 * threw, and the catch dropped to the video-only copy. The streams are already
 * downloaded to disk via requestUrl, so the mux must NOT pass HTTP options.
 * Caught only by the live e2e (the function does real I/O); this test pins the
 * arg list so it can't regress.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("fs")>();
  return {
    ...real,
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    existsSync: vi.fn(() => true),
    unlinkSync: vi.fn(),
  };
});

let execCalls: { bin: string; args: string[] }[] = [];
vi.mock("child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("child_process")>();
  return {
    ...real,
    execFileSync: vi.fn((bin: string, args: string[]) => {
      execCalls.push({ bin, args });
      return Buffer.from("");
    }),
  };
});

import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { muxRedditVideo } from "@/sync/media-downloader";

const buf = (s: string): ArrayBuffer => {
  const u = new TextEncoder().encode(s);
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength);
};

beforeEach(() => {
  execCalls = [];
  __setRequestUrlImpl(async (req) => {
    const text = req.url.includes("DASHPlaylist.mpd")
      ? "<MPD><BaseURL>DASH_720.mp4</BaseURL><BaseURL>DASH_AUDIO_128.mp4</BaseURL></MPD>"
      : "";
    return { status: 200, headers: {}, json: null, text, arrayBuffer: buf("data") };
  });
});
afterEach(() => __resetRequestUrlImpl());

const OPTS = {
  videoUrl: "https://v.redd.it/abc/DASH_720.mp4",
  dashUrl: "https://v.redd.it/abc/DASHPlaylist.mpd?a=signed-token&v=1&f=sd",
  videoId: "abc",
  hasAudio: true,
  ffmpegPath: "/fake/ffmpeg",
  outPath: "/tmp/out.mp4",
  tmpDir: "/tmp",
};

describe("muxRedditVideo ffmpeg invocation", () => {
  it("muxes the two local files and reports success", async () => {
    const ok = await muxRedditVideo(OPTS);
    expect(ok).toBe(true); // the mux path was taken, not the video-only fallback
    expect(execCalls).toHaveLength(1);
  });

  it("does NOT pass http-only -user_agent/-headers options (they break local-file input)", async () => {
    await muxRedditVideo(OPTS);
    const { args } = execCalls[0];
    expect(args).not.toContain("-user_agent");
    expect(args).not.toContain("-headers");
  });

  it("passes two -i inputs and copies both streams (a real remux)", async () => {
    await muxRedditVideo(OPTS);
    const { args } = execCalls[0];
    expect(args.filter((a) => a === "-i")).toHaveLength(2);
    expect(args).toContain("-c:v");
    expect(args).toContain("-c:a");
    expect(args.filter((a) => a === "copy")).toHaveLength(2);
    expect(args).toContain(OPTS.outPath);
  });

  it("falls back to video-only (no ffmpeg call) when ffmpegPath is undefined", async () => {
    const ok = await muxRedditVideo({ ...OPTS, ffmpegPath: undefined });
    expect(ok).toBe(false);
    expect(execCalls).toHaveLength(0);
  });
});
