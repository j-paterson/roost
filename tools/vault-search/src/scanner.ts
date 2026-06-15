import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { VAULT_PATH, EXCLUDE_DIRS } from "./config";

interface ChangedFile {
  path: string;       // relative to vault
  mtime_ms: number;
  isNew: boolean;
}

export function isExcluded(relPath: string): boolean {
  const segments = relPath.split(path.sep);
  for (const segment of segments) {
    if (!segment) continue;
    if (EXCLUDE_DIRS.has(segment)) return true;
    if (segment.startsWith(".")) return true;
    // Synology Drive sync-conflict folders: e.g.
    // "ObsidianVault_Jesses-MBP.localdomain_May-01-005444-2026_Conflict".
    // These are duplicates of the original vault — indexing them
    // doubles work and pollutes results.
    if (segment.endsWith("_Conflict")) return true;
  }
  return false;
}

export function scanVault(db: Database.Database): {
  changed: ChangedFile[];
  deleted: string[];
} {
  const vaultFiles = new Map<string, number>(); // relativePath → mtime_ms

  // Walk vault
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(VAULT_PATH, fullPath);

      if (entry.isDirectory()) {
        if (isExcluded(relPath)) continue;
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (isExcluded(relPath)) continue;
        const stat = fs.statSync(fullPath);
        vaultFiles.set(relPath, Math.floor(stat.mtimeMs));
      }
    }
  }

  walk(VAULT_PATH);

  // Compare against DB
  const dbFiles = new Map<string, number>();
  const rows = db.prepare("SELECT path, mtime_ms FROM files").all() as { path: string; mtime_ms: number }[];
  for (const row of rows) {
    dbFiles.set(row.path, row.mtime_ms);
  }

  // Find changed/new files
  const changed: ChangedFile[] = [];
  for (const [relPath, mtime] of vaultFiles) {
    const dbMtime = dbFiles.get(relPath);
    if (dbMtime === undefined) {
      changed.push({ path: relPath, mtime_ms: mtime, isNew: true });
    } else if (dbMtime !== mtime) {
      changed.push({ path: relPath, mtime_ms: mtime, isNew: false });
    }
  }

  // Find deleted files
  const deleted: string[] = [];
  for (const dbPath of dbFiles.keys()) {
    if (!vaultFiles.has(dbPath)) {
      deleted.push(dbPath);
    }
  }

  return { changed, deleted };
}
