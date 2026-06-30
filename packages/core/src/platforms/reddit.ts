import type { PlatformDescriptor } from "./descriptor";
import { roostParseEpoch, roostBookmarkId } from "@/lib/normalize-helpers";
import { extractRedditMedia, buildRedditUrl } from "@/lib/reddit-helpers";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import redditDiscoveryProbeSource from "../probes/reddit-discovery.probe";

/** Discovery-only platform: wired so the webview-manager can open a Reddit
 *  webview for login + cookie export (the dev-gated "Open Reddit (login)" /
 *  "Export Reddit session cookies" commands). enabled:false → never surfaced in
 *  the Hub or normal sync; sync/parse arrive once the design/research lands. */
export const reddit: PlatformDescriptor = {
  id: "reddit",
  hubId: "reddit",
  displayName: "Reddit",
  card: { title: "Reddit", eduCopy: "Reddit saved posts (login + discovery)." },
  origin: "https://www.reddit.com",
  profileUrl: "https://www.reddit.com/",
  authCookies: ["reddit_session"],
  enabled: false,
  probeSource: redditDiscoveryProbeSource,
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
};
