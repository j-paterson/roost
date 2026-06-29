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
  extractTikTokMedia,
  extractTikTokSubtitleUrl,
} from "@/lib/tiktok-helpers";
import {
  roostParseEpoch,
  roostTrimTikTok,
  roostBookmarkId,
} from "@/lib/normalize-helpers";
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
    id: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return record?.itemId || raw?.id || raw?.video?.id || null;
    },
    caption: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return "";
      return raw.desc || "";
    },
    authorName: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return "Unknown";
      return raw.author?.nickname || raw.author?.uniqueId || "Unknown";
    },
    authorHandle: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return null;
      return raw.author?.uniqueId || null;
    },
    url: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return null;
      const username = raw.author?.uniqueId || null;
      const itemId = record?.itemId || raw?.id || raw?.video?.id || null;
      if (username && itemId) return `https://www.tiktok.com/@${username}/video/${itemId}`;
      return null;
    },
    media: (record) => extractTikTokMedia(record),
    subtitleUrl: (record) => extractTikTokSubtitleUrl(record),
    normalize: (item, options) => {
      const itemId: string | undefined = item.id || item.video?.id;
      if (!itemId) return null;
      const published = roostParseEpoch(item.createTime);
      return {
        id: roostBookmarkId("tiktok", itemId),
        platform: "tiktok", itemId,
        rawData: roostTrimTikTok(item),
        saved_at: options.savedAt || published || new Date().toISOString(),
        published_at: published,
        captured_via: options.capturedVia || "sync",
      };
    },
  },
};
