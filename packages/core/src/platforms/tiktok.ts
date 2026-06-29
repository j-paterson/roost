/**
 * TikTok platform descriptor.
 * Config values copied verbatim from:
 *   - webview-manager.ts  (AUTH_COOKIES, PLATFORM_ORIGIN, create() url)
 *   - config.ts           (PLATFORM_DISPLAY["tiktok"])
 *   - platform-card.tsx   (TITLES["tiktok"], EDU_COPY["tiktok"])
 */
import type { PlatformDescriptor } from "./descriptor";
import { syncTikTok } from "@/sync/tiktok-sync";
import {
  getBookmarkItemId,
  extractBookmarkText,
  extractBookmarkAuthor,
  extractBookmarkAuthorUsername,
  extractBookmarkUrl,
  extractTikTokMedia,
  extractTikTokSubtitleUrl,
} from "@/lib/extract";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import tiktokProbeSource from "../probes/tiktok-probe.probe";

export const tiktok: PlatformDescriptor = {
  id: "tiktok",
  hubId: "tiktok",
  displayName: "TikTok",
  card: {
    title: "TikTok",
    eduCopy: "Syncs TikTok bookmarks via your Obsidian webview login.",
  },
  origin: "https://www.tiktok.com",
  profileUrl: "https://www.tiktok.com/profile",
  authCookies: ["sessionid", "sessionid_ss"],
  enabled: true,
  probeSource: tiktokProbeSource,
  sync: (wc, webviewEl, opts, onProgress, onRecords, onLog) =>
    syncTikTok(wc, webviewEl, opts, onProgress, onRecords, onLog),
  parse: {
    id: (record) => getBookmarkItemId(record),
    caption: (record) => extractBookmarkText(record),
    authorName: (record) => extractBookmarkAuthor(record),
    authorHandle: (record) => extractBookmarkAuthorUsername(record),
    url: (record) => extractBookmarkUrl(record),
    media: (record) => extractTikTokMedia(record),
    subtitleUrl: (record) => extractTikTokSubtitleUrl(record),
  },
};
