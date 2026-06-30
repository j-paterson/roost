/**
 * Media downloader — handles image/video fetching for bookmark sync.
 * Uses Obsidian's requestUrl (no CORS) for images and direct downloads.
 * Uses webview executeJavaScript for TikTok videos (needs auth cookies).
 */
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { requestUrl } from "obsidian";

/** Async ffmpeg invocation — does NOT block the main thread (unlike execFileSync,
 *  which froze the UI for the whole mux). Rejects on non-zero exit or timeout. */
const execFileAsync = promisify(execFile);
import { TIKTOK_VIDEO_DOWNLOAD_TIMEOUT_MS, MEDIA_DOWNLOAD_MAX_RETRIES } from "@/config";
import type { ElectronWebview } from "@/types/sync";

/** Retry a download function up to maxRetries times with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = MEDIA_DOWNLOAD_MAX_RETRIES,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      lastErr = e;
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Race a promise against a timeout. Returns null on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>(r => { timer = setTimeout(() => r(null), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Download any Twitter media (images and videos use the same mechanism) */
async function downloadTwitterMedia(url: string): Promise<ArrayBuffer | null> {
  try {
    return await withRetry(async () => {
      const response = await requestUrl({ url, headers: { Referer: "https://x.com/" } });
      return response.arrayBuffer;
    });
  } catch (e: unknown) {
    console.warn(`[media] Failed to download: ${url}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

// Aliases for call-site clarity
export const downloadTwitterImage = downloadTwitterMedia;
export const downloadTwitterVideo = downloadTwitterMedia;

export async function downloadTikTokImage(url: string): Promise<ArrayBuffer | null> {
  try {
    return await withRetry(async () => {
      const response = await requestUrl({ url, headers: { Referer: "https://www.tiktok.com/" } });
      return response.arrayBuffer;
    });
  } catch (e: unknown) {
    console.warn(`[media] Failed to download: ${url}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Download a TikTok subtitle WebVTT file (public CDN, no auth needed). */
export async function downloadTikTokSubtitle(url: string): Promise<string | null> {
  try {
    const response = await requestUrl({ url });
    return response.text;
  } catch {
    // Subtitle download is best-effort — don't warn loudly
    return null;
  }
}

/**
 * Download TikTok video via the webview's injected probe function.
 * The probe has __tiktokDownloadVideoAsBase64 which fetches with auth cookies.
 */
export async function downloadTikTokVideo(wc: ElectronWebview, videoUrl: string): Promise<ArrayBuffer | null> {
  try {
    const result = await withTimeout(
      withRetry(async () => {
        const base64 = await wc.executeJavaScript(`
          (async () => {
            try {
              if (typeof window.__tiktokDownloadVideoAsBase64 === 'function') {
                return await window.__tiktokDownloadVideoAsBase64(${JSON.stringify(videoUrl)});
              }
              // Fallback: fetch with credentials
              const res = await fetch(${JSON.stringify(videoUrl)}, { credentials: 'include' });
              const blob = await res.blob();
              return await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });
            } catch(e) { return null; }
          })();
        `);
        if (!base64 || typeof base64 !== "string") throw new Error("No base64 data returned");
        return base64;
      }),
      TIKTOK_VIDEO_DOWNLOAD_TIMEOUT_MS,
    );
    if (!result || typeof result !== "string") return null;
    const commaIdx = result.indexOf(",");
    const b64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
    // Node's Buffer avoids the triple-copy that atob + char-by-char produces
    const buf = Buffer.from(b64, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e: unknown) {
    console.warn(`[media] Failed to download TikTok video: ${videoUrl}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

const REDDIT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

export async function downloadRedditImage(url: string): Promise<ArrayBuffer | null> {
  try {
    return await withRetry(async () => {
      const res = await requestUrl({ url, headers: { "User-Agent": REDDIT_UA, "Referer": "https://www.reddit.com/" } });
      return res.arrayBuffer;
    });
  } catch (e) {
    console.warn(`[media] reddit image failed: ${url}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Audio BaseURL from a v.redd.it DASHPlaylist.mpd — covers every naming era
 *  (CMAF_AUDIO_*, DASH_AUDIO_*, DASH_audio.mp4, bare audio). Returns null when
 *  the manifest has no audio representation. */
export function parseRedditAudioBaseUrl(mpdText: string): string | null {
  const m = mpdText.match(/<BaseURL>((?:CMAF|DASH)_AUDIO_\d+(?:\.mp4)?|DASH_audio(?:\.mp4)?|audio(?:\.mp4)?)<\/BaseURL>/i);
  return m ? m[1] : null;
}

export interface MuxRedditVideoOpts {
  videoUrl: string;
  dashUrl: string | null;
  videoId: string;
  hasAudio: boolean;
  ffmpegPath: string | undefined;
  outPath: string;
  tmpDir: string;
}

/**
 * Download a v.redd.it video (+ audio if available) and mux to outPath.
 * Returns true when a properly muxed file was written, false when video-only
 * fallback was used (no ffmpeg, no audio track, or any failure).
 * Mirrors the execFileSync ffmpeg pattern from pipeline/describe-items.ts.
 */
export async function muxRedditVideo(opts: MuxRedditVideoOpts): Promise<boolean> {
  const { videoUrl, dashUrl, videoId, hasAudio, ffmpegPath, outPath, tmpDir } = opts;

  // Download video stream
  let videoBytes: ArrayBuffer;
  try {
    const res = await requestUrl({
      url: videoUrl,
      headers: { "User-Agent": REDDIT_UA, "Referer": "https://www.reddit.com/" },
    });
    videoBytes = res.arrayBuffer;
  } catch (e) {
    console.warn(`[media] reddit video download failed: ${videoUrl}`, e instanceof Error ? e.message : String(e));
    return false;
  }

  const videoTmp = path.join(tmpDir, `${videoId}-video.mp4`);
  let audioTmp: string | null = null;
  fs.writeFileSync(videoTmp, Buffer.from(videoBytes));

  try {
    // Attempt mux when all conditions are met
    if (ffmpegPath && hasAudio && dashUrl) {
      try {
        const mpdRes = await requestUrl({
          url: dashUrl,
          headers: { "User-Agent": REDDIT_UA, "Referer": "https://www.reddit.com/" },
        });
        const audioBase = parseRedditAudioBaseUrl(mpdRes.text);

        if (audioBase) {
          // Audio URL is dashUrl's directory + audioBase
          const audioUrl = dashUrl.replace(/\/[^/]+$/, `/${audioBase}`);
          const audioRes = await requestUrl({
            url: audioUrl,
            headers: { "User-Agent": REDDIT_UA, "Referer": "https://www.reddit.com/" },
          });
          audioTmp = path.join(tmpDir, `${videoId}-audio.mp4`);
          fs.writeFileSync(audioTmp, Buffer.from(audioRes.arrayBuffer));

          // Mux the two LOCAL temp files. Note: NO -user_agent/-headers here —
          // those are HTTP-protocol input options and ffmpeg rejects them for
          // file inputs ("Option user_agent not found"), which silently forced
          // every audio-bearing video into the video-only fallback. The streams
          // are already downloaded via requestUrl, so ffmpeg just remuxes them.
          await execFileAsync(ffmpegPath, [
            "-y",
            "-i", videoTmp,
            "-i", audioTmp,
            "-c:v", "copy",
            "-c:a", "copy",
            "-loglevel", "error",
            outPath,
          ], { timeout: 120000 });

          return true;
        }
      } catch (e) {
        console.warn(`[media] reddit mux failed for ${videoId}, falling back to video-only`, e instanceof Error ? e.message : String(e));
      }
    }

    // Video-only fallback
    fs.copyFileSync(videoTmp, outPath);
    return false;
  } finally {
    try { if (fs.existsSync(videoTmp)) fs.unlinkSync(videoTmp); } catch { /* ignore */ }
    if (audioTmp) { try { if (fs.existsSync(audioTmp)) fs.unlinkSync(audioTmp); } catch { /* ignore */ } }
  }
}

/**
 * Download Instagram media (image/video/carousel child) via the webview's
 * injected probe. IG CDN URLs are time-limited, so this MUST run during sync
 * while the instagram.com webview is live. Mirrors downloadTikTokVideo.
 */
export async function downloadInstagramMedia(wc: ElectronWebview, url: string): Promise<ArrayBuffer | null> {
  try {
    const result = await withTimeout(
      withRetry(async () => {
        const base64 = await wc.executeJavaScript(
          `window.__roostIgFetchMediaBase64(${JSON.stringify(url)})`,
        );
        if (!base64 || typeof base64 !== "string") throw new Error("No base64 data returned");
        return base64;
      }),
      TIKTOK_VIDEO_DOWNLOAD_TIMEOUT_MS,
    );
    if (!result || typeof result !== "string") return null;
    const commaIdx = result.indexOf(",");
    const b64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
    const buf = Buffer.from(b64, "base64");
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  } catch (e: unknown) {
    console.warn(`[media] Failed to download Instagram media: ${url}`, e instanceof Error ? e.message : String(e));
    return null;
  }
}
