/**
 * Regenerate card.png for the active X bookmark note (dev iteration aid).
 */
import { Notice, TFile, type App } from "obsidian";
import { renderCardAsync } from "@/sync/card-renderer";

export async function regenerateCardForActiveNote(app: App): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file || !(file instanceof TFile)) {
    new Notice("No active note.");
    return;
  }
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!fm) {
    new Notice("Active note has no frontmatter.");
    return;
  }
  if (typeof fm.platform === "string" && fm.platform !== "twitter") {
    new Notice(`Card images are only generated for X bookmarks (platform: ${fm.platform}).`);
    return;
  }

  const rawAuthor = typeof fm.author === "string"
    ? fm.author.replace(/^\[\[People\//, "").replace(/\]\]$/, "")
    : "";
  const username = rawAuthor.replace(/^@/, "") || null;
  const author = (rawAuthor || "Unknown").replace(/^@/, "");
  const published = typeof fm.published === "string" ? fm.published : null;

  const raw = await app.vault.read(file);
  const body = raw.replace(/^---[\s\S]*?\n---\n?/, "").trim();
  if (!body) {
    new Notice("Note body is empty — nothing to render.");
    return;
  }

  const coverRaw = typeof fm.cover === "string" ? fm.cover : "";
  const coverMatch = coverRaw.match(/^\[\[(.+?)\]\]$/);
  const coverPath = coverMatch ? coverMatch[1] : coverRaw;
  const attachFolder = coverPath
    ? coverPath.replace(/\/[^/]+$/, "")
    : file.path.replace(/\.md$/, "").replace(/\/note$/, "");

  const data = await renderCardAsync({
    author,
    username,
    text: body,
    publishedAt: published,
    subContext: null,
  });
  if (!data) {
    new Notice("renderCardAsync returned null — see console for details.");
    return;
  }
  const outPath = `${attachFolder}/card.png`;
  const existing = app.vault.getAbstractFileByPath(outPath);
  if (existing instanceof TFile) {
    await app.vault.modifyBinary(existing, data);
  } else {
    await app.vault.createBinary(outPath, data);
  }
  new Notice(`Regenerated ${outPath}`);
}
