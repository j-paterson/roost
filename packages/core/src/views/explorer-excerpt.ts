/**
 * Text excerpt preview for explorer note cards.
 */
import type { App, TFile } from "obsidian";
import { stripFrontmatter } from "@/lib/vault-utils";

const excerptCache = new WeakMap<TFile, string>();

export async function getExplorerExcerpt(
  file: TFile,
  app: App,
  maxLen = 150,
): Promise<string> {
  const cached = excerptCache.get(file);
  if (cached !== undefined) return cached;

  try {
    const content = await app.vault.cachedRead(file);
    let body = stripFrontmatter(content);
    body = body.trim()
      .replace(/^#+\s+/gm, "")
      .replace(/\!?\[\[.*?\]\]/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[*_~`]/g, "")
      .replace(/^>\s*/gm, "")
      .replace(/^-\s+/gm, "")
      .replace(/\n{2,}/g, "\n")
      .trim();
    const excerpt = body.slice(0, maxLen) + (body.length > maxLen ? "…" : "");
    excerptCache.set(file, excerpt);
    return excerpt;
  } catch {
    return "";
  }
}
