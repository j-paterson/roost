/**
 * Platform registry — the central map of all known platforms.
 *
 * Import getPlatform / enabledPlatforms to look up descriptors.
 * Do NOT import consumers (hub, webview-manager, etc.) from here.
 */
import type { Platform } from "@/types/sync";
import type { PlatformDescriptor } from "./descriptor";
import { tiktok } from "./tiktok";
import { twitter } from "./twitter";

export const PLATFORMS: Record<Platform, PlatformDescriptor> = {
  tiktok,
  twitter,
};

/**
 * Look up a platform descriptor by its canonical id.
 * Throws on unknown id so callers get a hard failure rather than silently
 * working with an undefined descriptor.
 */
export function getPlatform(id: Platform): PlatformDescriptor {
  const descriptor = PLATFORMS[id];
  if (!descriptor) throw new Error(`Unknown platform: ${id}`);
  return descriptor;
}

/** Return all descriptors whose `enabled` flag is true. */
export function enabledPlatforms(): PlatformDescriptor[] {
  return Object.values(PLATFORMS).filter((p) => p.enabled);
}
