import { requestUrl } from "obsidian";
import * as fs from "fs";
import * as path from "path";

/** Probe an HTTP endpoint; returns true on a 2xx response, false on error/non-2xx. */
export async function httpProbe(url: string): Promise<boolean> {
  try {
    const res = await requestUrl({ url, method: "GET" });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

export interface ResolveBinaryOpts {
  /** Directories from $PATH. */
  pathDirs: string[];
  /** Extra well-known install dirs to check after PATH. */
  extraDirs: string[];
  /** Existence predicate (injected for testing). */
  exists: (candidatePath: string) => boolean;
}

/** Resolve an executable to an absolute path by scanning PATH then extraDirs.
 *  Returns the first existing candidate, or null. Pure — all IO is injected. */
export function resolveBinary(name: string, opts: ResolveBinaryOpts): string | null {
  for (const dir of [...opts.pathDirs, ...opts.extraDirs]) {
    const candidate = path.join(dir, name);
    if (opts.exists(candidate)) return candidate;
  }
  return null;
}

/** Common non-PATH install locations for CLI tools (macOS/Linux). */
const COMMON_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

/** Production binary check: scans real $PATH + COMMON_BIN_DIRS using fs. */
export function findBinary(name: string): string | null {
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return resolveBinary(name, {
    pathDirs,
    extraDirs: COMMON_BIN_DIRS,
    exists: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    },
  });
}
