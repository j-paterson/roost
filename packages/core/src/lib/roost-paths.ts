import * as path from "path";

export function roostDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".roost");
}

export function cacheDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".roost", "cache");
}

export function buildDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".roost", "build");
}

export function cachePath(vaultRoot: string, ...parts: string[]): string {
  return path.join(vaultRoot, ".roost", "cache", ...parts);
}

export function buildPath(vaultRoot: string, ...parts: string[]): string {
  return path.join(vaultRoot, ".roost", "build", ...parts);
}
