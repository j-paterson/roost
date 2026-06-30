/**
 * Media downloader — handles image/video fetching for bookmark sync.
 * Uses Obsidian's requestUrl (no CORS) for images and direct downloads.
 * Uses webview executeJavaScript for TikTok videos (needs auth cookies).
 */
import { requestUrl } from "obsidian";
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
