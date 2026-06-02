/**
 * Recursive filesystem walk used by backfill commands to enumerate every
 * raw.json sidecar under Bookmarks/<platform>/. Iterative implementation —
 * recursive walks blow the stack on vaults with deeply-nested attach
 * folders (Synology Drive sometimes adds @eaDir/ subdirectories).
 *
 * Synchronous because it operates against the OS filesystem directly
 * (vault.adapter would re-route through Obsidian's async adapter, which
 * is much slower for ~thousand-file traversals on a cloud-backed vault).
 */
import * as fs from "fs";
import * as path from "path";

export function walkDir(root: string, onFile: (filePath: string) => void): void {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) onFile(full);
    }
  }
}
