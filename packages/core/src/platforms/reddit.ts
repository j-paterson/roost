import type { PlatformDescriptor } from "./descriptor";
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
  // sync + parse + vault intentionally omitted — discovery-only.
};
