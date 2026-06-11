import * as path from "path";

export function cacheDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".roost", "cache");
}

export function cachePath(vaultRoot: string, ...parts: string[]): string {
  return path.join(vaultRoot, ".roost", "cache", ...parts);
}
