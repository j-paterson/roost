/**
 * Twitter/X platform descriptor.
 * Config values copied verbatim from:
 *   - webview-manager.ts  (AUTH_COOKIES, PLATFORM_ORIGIN, create() url)
 *   - config.ts           (PLATFORM_DISPLAY["twitter"])
 *   - platform-card.tsx   (TITLES["x"], EDU_COPY["x"])
 */
import type { PlatformDescriptor } from "./descriptor";
import { syncTwitter } from "@/sync/twitter-sync";
import {
  getBookmarkItemId,
  extractBookmarkText,
  extractBookmarkAuthor,
  extractBookmarkAuthorUsername,
  extractBookmarkUrl,
  extractTwitterMedia,
} from "@/lib/extract";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import twitterProbeSource from "../probes/twitter-probe.probe";

export const twitter: PlatformDescriptor = {
  id: "twitter",
  hubId: "x",
  displayName: "X",
  card: {
    title: "X / Twitter",
    eduCopy: "Syncs X bookmarks via your Obsidian webview login.",
  },
  origin: "https://x.com",
  profileUrl: "https://x.com/",
  authCookies: ["auth_token"],
  enabled: true,
  probeSource: twitterProbeSource,
  sync: (wc, webviewEl, opts, onProgress, onRecords, onLog) =>
    syncTwitter(wc, webviewEl, opts, onProgress, onRecords, onLog),
  parse: {
    id: (record) => getBookmarkItemId(record),
    caption: (record) => extractBookmarkText(record),
    authorName: (record) => extractBookmarkAuthor(record),
    authorHandle: (record) => extractBookmarkAuthorUsername(record),
    url: (record) => extractBookmarkUrl(record),
    media: (record) => extractTwitterMedia(record),
  },
};
