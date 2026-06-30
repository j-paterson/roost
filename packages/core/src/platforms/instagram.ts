import type { PlatformDescriptor } from "./descriptor";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import instagramDiscoveryProbeSource from "../probes/instagram-discovery.probe";

/** Discovery-only platform: wired so the webview-manager can open an Instagram
 *  webview for the live API-discovery e2e. enabled:false → never surfaced in the
 *  Hub or normal sync; sync/parse arrive in Phase 2. */
export const instagram: PlatformDescriptor = {
  id: "instagram",
  hubId: "instagram",
  displayName: "Instagram",
  card: { title: "Instagram", eduCopy: "Instagram saved/collections (discovery)." },
  origin: "https://www.instagram.com",
  profileUrl: "https://www.instagram.com/",
  authCookies: ["sessionid"],
  enabled: false,
  probeSource: instagramDiscoveryProbeSource,
  // sync + parse intentionally omitted — discovery-only (Phase 2).
};
