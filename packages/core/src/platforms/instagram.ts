import type { PlatformDescriptor } from "./descriptor";
import {
  roostParseEpoch,
  roostBookmarkId,
} from "@/lib/normalize-helpers";
import { extractInstagramMedia, buildInstagramUrl } from "@/lib/instagram-helpers";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import instagramDiscoveryProbeSource from "../probes/instagram-discovery.probe";

/** Phase 2 prep: parse + vault data are live, but enabled stays false until the
 *  sync fn lands (Task 9) so the Hub never surfaces a card that can't sync. */
export const instagram: PlatformDescriptor = {
  id: "instagram",
  hubId: "instagram",
  displayName: "Instagram",
  card: { title: "Instagram", eduCopy: "Syncs your Instagram saved posts via your Obsidian webview login." },
  origin: "https://www.instagram.com",
  profileUrl: "https://www.instagram.com/",
  authCookies: ["sessionid"],
  enabled: false,
  probeSource: instagramDiscoveryProbeSource,
  vault: { folder: "Instagram", attachPrefix: "instagram", icon: "camera" },
  parse: {
    id: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return record?.itemId || raw?.code || null;
    },
    caption: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return raw?.caption?.text || "";
    },
    authorName: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return raw?.user?.full_name || raw?.user?.username || "Unknown";
    },
    authorHandle: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return raw?.user?.username || null;
    },
    url: (record) => {
      const raw = record?.rawData || record?.castData || null;
      const code = record?.itemId || raw?.code || null;
      return code ? buildInstagramUrl(code) : null;
    },
    media: (record) => extractInstagramMedia(record),
    normalize: (item, options) => {
      const itemId: string | undefined = item.code;
      if (!itemId) return null;
      const published = roostParseEpoch(item.taken_at);
      return {
        id: roostBookmarkId("instagram", itemId),
        platform: "instagram", itemId,
        rawData: item,
        saved_at: options.savedAt || published || new Date().toISOString(),
        published_at: published,
        captured_via: options.capturedVia || "sync",
      };
    },
  },
  // sync intentionally omitted until Task 9.
};
