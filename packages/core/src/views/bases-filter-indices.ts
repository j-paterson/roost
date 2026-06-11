import type { BasesEntry } from "obsidian";
import { filterEntryIndices } from "@/lib/vault-utils";

/** Explorer folder path filter → flat indices */
export function computeExplorerFolderIndices(
  entries: BasesEntry[],
  folderPath: string,
): number[] {
  const prefix = `${folderPath}/`;
  return filterEntryIndices(entries, (entry) => {
    const path = entry.file.path;
    return path.startsWith(prefix) || entry.file.parent?.path === folderPath;
  });
}
