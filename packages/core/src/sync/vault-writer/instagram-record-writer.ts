import { Vault } from "obsidian";
import { buildFrontmatter, ensureFolder } from "@/lib/vault-helpers";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter } from "./note-file-writer";
import { type MediaDownloader } from "./media-downloader";
import { type NormalizedRecord } from "../../lib/normalize";
import type { ElectronWebview } from "@/types/sync";
import { sanitizeFilename } from "../../lib/extract";
import { extractInstagramMedia } from "../../lib/instagram-helpers";
import { downloadInstagramMedia } from "../media-downloader";

interface InstagramRecordWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  mediaDownloader: MediaDownloader;
  ensuredFolders: Set<string>;
  instagramWc: ElectronWebview | undefined;
}

export class InstagramRecordWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private ensuredFolders: Set<string>;
  private instagramWc: ElectronWebview | undefined;

  constructor(opts: InstagramRecordWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.mediaDownloader = opts.mediaDownloader;
    this.ensuredFolders = opts.ensuredFolders;
    this.instagramWc = opts.instagramWc;
  }

  async writeInstagramRecord(record: NormalizedRecord): Promise<void> {
    const { text, url, published, itemId, handle } = this.noteWriter.extractCommon(record);
    const media = extractInstagramMedia(record);
    const folderPath = `${this.syncFolder}/Instagram`;
    const attachFolder = `${folderPath}/instagram-${itemId}`;

    await ensureFolder(this.vault, folderPath, this.ensuredFolders);
    const authorLink = await this.noteWriter.createAuthorNote(handle, "instagram");
    const wc = this.instagramWc;
    const mediaEmbeds: string[] = [];
    let coverFile: string | null = null;

    // Build the list of assets to fetch (image, video, or each carousel child).
    type Asset = { url: string; name: string; isCover?: boolean };
    const assets: Asset[] = [];
    if (media.isCarousel) {
      media.carousel.forEach((c) => {
        if (c.type === 2) {
          assets.push({ url: c.url, name: `${c.index + 1}.mp4` });
          if (c.coverUrl) assets.push({ url: c.coverUrl, name: `${c.index + 1}.jpg`, isCover: c.index === 0 });
        } else {
          assets.push({ url: c.url, name: `${c.index + 1}.jpg`, isCover: c.index === 0 });
        }
      });
    } else if (media.mediaType === 2 && media.videoUrl) {
      assets.push({ url: media.videoUrl, name: "video.mp4" });
      if (media.coverUrl) assets.push({ url: media.coverUrl, name: "cover.jpg", isCover: true });
    } else if (media.images.length > 0) {
      assets.push({ url: media.images[0].url, name: "1.jpg", isCover: true });
    } else if (media.coverUrl) {
      assets.push({ url: media.coverUrl, name: "cover.jpg", isCover: true });
    }

    if (assets.length > 0 && wc) {
      for (const a of assets) {
        const embed = await this.mediaDownloader.downloadAndSave(
          () => downloadInstagramMedia(wc, a.url), attachFolder, a.name,
        );
        if (embed) {
          mediaEmbeds.push(embed);
          if (a.isCover) coverFile = `${attachFolder}/${a.name}`;
        }
      }
    } else if (assets.length > 0) {
      this.log(`[instagram] no webview handle — skipping media for ${record.id}`);
    }

    // Content-less guard: a webview was available but no media downloaded (e.g.
    // an expired IG CDN URL → HTTP 410) and there's no caption. Writing this
    // would create a note + raw.json-only folder with nothing to show or embed.
    // Skip it — the item stays un-written, so a later sync retries with fresh
    // URLs if the post is still downloadable. Only applies when `wc` was present
    // (a missing webview is transient — keep the note and retry). See the
    // embedding identity-fallback for why content-less items were problematic.
    if (wc && coverFile === null && mediaEmbeds.length === 0 && !text.trim()) {
      this.log(`[instagram] no media + no caption for ${record.id} — skipping content-less note`);
      return;
    }

    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));

    const collectionTags = media.collections.map((c) => `collection/${sanitizeFilename(c)}`);
    const tags = [...new Set(["instagram", ...collectionTags])];
    const fm = buildFrontmatter({
      roost_id: record.id,
      title: text.replace(/\n/g, " "),
      cover: coverFile ? `[[${coverFile}]]` : undefined,
      platform: "instagram",
      author: authorLink,
      url,
      collections: media.collections.length ? media.collections : undefined,
      published: published ? published.split("T")[0] : undefined,
      saved: record.saved_at?.split("T")[0],
      tags,
      stats_likes: media.stats?.likes || undefined,
      stats_comments: media.stats?.comments || undefined,
    });
    await this.noteWriter.writeNote(folderPath, sanitizeFilename(`${handle} - ${itemId}`) + ".md", fm, []);
  }
}
