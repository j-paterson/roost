import type { PlatformDescriptor } from "./descriptor";
import { roostParseEpoch, roostBookmarkId } from "@/lib/normalize-helpers";
import { extractRedditMedia, buildRedditUrl } from "@/lib/reddit-helpers";
import { syncReddit } from "@/sync/reddit-sync";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import redditProbeSource from "../probes/reddit-probe.probe";

/** Live sync platform: fetches Reddit saved posts via the authenticated webview
 *  and writes them to the vault using the standard sync pipeline. */
export const reddit: PlatformDescriptor = {
  id: "reddit",
  hubId: "reddit",
  displayName: "Reddit",
  card: { title: "Reddit", eduCopy: "Syncs your saved Reddit posts." },
  origin: "https://www.reddit.com",
  profileUrl: "https://www.reddit.com/",
  authCookies: ["reddit_session"],
  enabled: true,
  probeSource: redditProbeSource,
  vault: { folder: "Reddit", attachPrefix: "reddit", icon: "message-circle" },
  parse: {
    id: (r) => { const raw = r?.rawData || r?.castData || null; return r?.itemId || raw?.id || null; },
    caption: (r) => { const raw = r?.rawData || r?.castData || null; return raw?.selftext || raw?.title || ""; },
    authorName: (r) => { const raw = r?.rawData || r?.castData || null; return raw?.author || "Unknown"; },
    authorHandle: (r) => { const raw = r?.rawData || r?.castData || null; return raw?.author || null; },
    url: (r) => { const raw = r?.rawData || r?.castData || null; return raw?.permalink ? buildRedditUrl(raw.permalink) : null; },
    media: (r) => extractRedditMedia(r),
    normalize: (item, options) => {
      const itemId: string | undefined = item.id;
      if (!itemId) return null;
      const published = roostParseEpoch(item.created_utc);
      return { id: roostBookmarkId("reddit", itemId), platform: "reddit", itemId, rawData: item,
        saved_at: options.savedAt || published || new Date().toISOString(), published_at: published, captured_via: options.capturedVia || "sync" };
    },
  },
  sync: (wc, webviewEl, opts, onProgress, onRecords, onLog) =>
    syncReddit(wc, webviewEl, opts, onProgress, onRecords, onLog),
};
