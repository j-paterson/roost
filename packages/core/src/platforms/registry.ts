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
import { instagram } from "./instagram";

// Use getter properties so each read returns the live module binding value.
// This breaks the circular-import snapshot problem where
// instagram.ts → instagram-sync.ts → normalize.ts → registry.ts → instagram.ts
// would capture instagram=undefined in the PLATFORMS object literal before
// instagram.ts finishes evaluating.
// The direct Record<Platform, PlatformDescriptor> type annotation (no cast)
// preserves compile-time completeness: a missing Platform key is a tsc error.
export const PLATFORMS: Record<Platform, PlatformDescriptor> = {
  get tiktok() { return tiktok; },
  get twitter() { return twitter; },
  get instagram() { return instagram; },
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

/** Vault folder names for all platforms that define a vault block. */
export function platformFolders(): string[] {
  return Object.values(PLATFORMS).map((p) => p.vault?.folder).filter((f): f is string => !!f);
}

/** Map a vault folder name back to its platform id (e.g. "X" → "twitter"). */
export function folderToPlatform(folder: string): Platform | null {
  for (const p of Object.values(PLATFORMS)) {
    if (p.vault?.folder === folder) return p.id;
  }
  return null;
}
