import { Vault, TFile, TFolder } from "obsidian";
import { ensureFolder, parseFrontmatterEntries, updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { buildTikTokVideoUrl } from "../../lib/extract";
import { fetchTikTokOembed, buildOembedRawJson } from "../oembed-fallback";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter } from "./note-file-writer";

function noteDirPath(filePath: string): string {
  return filePath.replace(/\/[^/]+\.md$/, "");
}

interface MediaDownloaderOpts {
  vault: Vault;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  ensuredFolders: Set<string>;
}

export class MediaDownloader {
  private vault: Vault;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private ensuredFolders: Set<string>;
  private stopSignal: { stopped: boolean } | null = null;

  constructor(opts: MediaDownloaderOpts) {
    this.vault = opts.vault;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.ensuredFolders = opts.ensuredFolders;
  }

  setStopSignal(signal: { stopped: boolean } | null): void {
    this.stopSignal = signal;
  }

  async clearLegacyCarousel(attachFolder: string): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(attachFolder);
    if (!(folder instanceof TFolder)) return;
    const victims = folder.children.filter(c =>
      c instanceof TFile && (/^\d+\.(jpg|png)$/.test(c.name) || c.name === "card.png")
    );
    for (const v of victims) {
      try { await this.vault.delete(v); } catch { /* ignore */ }
    }
  }

  async downloadAndSave(
    downloadFn: () => Promise<ArrayBuffer | null>,
    attachFolder: string,
    filename: string,
    skipIfExists = false,
  ): Promise<string | null> {
    const destPath = `${attachFolder}/${filename}`;
    if (skipIfExists && this.vault.getAbstractFileByPath(destPath)) {
      return `![[${destPath}]]`;
    }
    if (this.stopSignal?.stopped) return null;
    const t0 = Date.now();
    const data = await downloadFn();
    const dlMs = Date.now() - t0;
    if (!data) {
      if (dlMs > 5000) this.log(`[timeout?] ${filename} download returned null after ${(dlMs / 1000).toFixed(1)}s`);
      return null;
    }
    if (dlMs > 5000) {
      const sizeMB = (data.byteLength / 1024 / 1024).toFixed(1);
      this.log(`[slow] ${filename} download: ${(dlMs / 1000).toFixed(1)}s (${sizeMB} MB)`);
    }
    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    if (this.vault.getAbstractFileByPath(destPath)) {
      return `![[${destPath}]]`;
    }
    await this.vault.createBinary(destPath, data);
    return `![[${destPath}]]`;
  }

  async backfillWithOembed(
    incompleteIds: Set<string>,
    stopSignal?: { stopped: boolean },
  ): Promise<{ attempted: number; success: number; failed: number }> {
    const tiktokIds = [...incompleteIds].filter(id => id.startsWith("tiktok:"));
    if (tiktokIds.length === 0) return { attempted: 0, success: 0, failed: 0 };

    this.log(`oEmbed backfill: ${tiktokIds.length} TikTok items missing raw.json`);
    let success = 0, failed = 0;

    for (let i = 0; i < tiktokIds.length; i++) {
      if (stopSignal?.stopped) break;

      const roostId = tiktokIds[i];
      const itemId = roostId.split(":")[1];
      const noteFile = this.index.notePathMap.get(roostId);
      if (!noteFile) { failed++; continue; }

      const noteDir = noteDirPath(noteFile.path);
      const attachFolder = `${noteDir}/tiktok-${itemId}`;

      if (this.vault.getAbstractFileByPath(`${attachFolder}/raw.json`)) continue;
      let content: string;
      try { content = await this.vault.read(noteFile); } catch { failed++; continue; }

      const fmEnd = content.indexOf("\n---\n", 4);
      const entries = fmEnd !== -1 ? parseFrontmatterEntries(content.slice(4, fmEnd)) : [];
      const authorEntry = entries.find(e => e.key === "author");
      const authorMatch = authorEntry?.fullBlock.match(/\[\[People\/@?([^\]]+)\]\]/);
      const authorHandle = authorMatch?.[1] || "";
      const titleEntry = entries.find(e => e.key === "title");
      const existingTitle = titleEntry?.fullBlock.replace(/^title:\s*"?|"?\s*$/g, "") || "";

      const videoUrl = authorHandle
        ? buildTikTokVideoUrl(authorHandle, itemId)
        : null;

      let oembed = null;
      if (videoUrl) {
        oembed = await fetchTikTokOembed(videoUrl);
      }

      const rawData = buildOembedRawJson(itemId, oembed, { author: authorHandle, title: existingTitle });
      await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
      await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(rawData, null, 2));

      if (oembed) {
        const updates: Record<string, FrontmatterValue> = {};
        if (oembed.title && oembed.title.length > existingTitle.length + 5) {
          updates.title = oembed.title;
        }
        if (rawData.music?.title) {
          updates.sound = rawData.music.authorName
            ? `${rawData.music.title} — ${rawData.music.authorName}`
            : rawData.music.title;
        }
        if (Object.keys(updates).length > 0) {
          const updated = updateNoteFrontmatter(content, updates);
          if (updated) await this.vault.modify(noteFile, updated);
        }
        success++;
      } else {
        failed++;
      }

      if (i > 0 && i % 5 === 0) { // rate limit
        await new Promise(r => setTimeout(r, 200));
        if (i % 50 === 0) this.log(`  oEmbed backfill: ${i}/${tiktokIds.length}`);
      }
    }

    this.log(`oEmbed backfill done: ${success} enriched, ${failed} failed (${tiktokIds.length} attempted)`);
    return { attempted: tiktokIds.length, success, failed };
  }
}
