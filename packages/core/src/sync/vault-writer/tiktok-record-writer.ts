import { Vault } from "obsidian";
import { buildFrontmatter, ensureFolder } from "@/lib/vault-helpers";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter } from "./note-file-writer";
import { type MediaDownloader } from "./media-downloader";
import { type NormalizedRecord } from "../../lib/normalize";
import type { ElectronWebview } from "@/types/sync";
import {
  extractTikTokMedia,
  extractTikTokSubtitleUrl,
  parseWebVTT,
  sanitizeFilename,
} from "../../lib/extract";
import {
  downloadTikTokImage,
  downloadTikTokVideo,
  downloadTikTokSubtitle,
} from "../media-downloader";

interface TikTokRecordWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  mediaDownloader: MediaDownloader;
  ensuredFolders: Set<string>;
  tiktokWc: ElectronWebview | undefined;
}

export class TikTokRecordWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private ensuredFolders: Set<string>;
  private tiktokWc: ElectronWebview | undefined;

  constructor(opts: TikTokRecordWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.mediaDownloader = opts.mediaDownloader;
    this.ensuredFolders = opts.ensuredFolders;
    this.tiktokWc = opts.tiktokWc;
  }

  async writeTikTokRecord(record: NormalizedRecord): Promise<void> {
    const { text, url, published, itemId, handle } = this.noteWriter.extractCommon(record);
    const media = extractTikTokMedia(record);
    const folderPath = `${this.syncFolder}/TikTok`;
    const attachFolder = `${folderPath}/tiktok-${itemId}`;

    await ensureFolder(this.vault, folderPath, this.ensuredFolders);
    const authorLink = await this.noteWriter.createAuthorNote(handle, "tiktok");
    const mediaEmbeds: string[] = [];

    // coverFile is set ONLY when the underlying download succeeded — otherwise
    // frontmatter would reference a file that was never written, producing a
    // broken-image icon in the gallery. Video still plays because the video
    // download lives on a separate code path.
    let coverFile: string | null = null;

    if (media.images.length > 0) {
      const results = await Promise.all(
        media.images.map(img =>
          this.mediaDownloader.downloadAndSave(() => downloadTikTokImage(img.url), attachFolder, `${img.index + 1}.jpg`)
        )
      );
      mediaEmbeds.push(...results.filter(Boolean) as string[]);
      const firstOk = results.findIndex(r => r);
      if (firstOk >= 0) coverFile = `${attachFolder}/${media.images[firstOk].index + 1}.jpg`;
    } else if (media.videoUrl && this.tiktokWc) {
      const wc = this.tiktokWc;
      const embed = await this.mediaDownloader.downloadAndSave(() => downloadTikTokVideo(wc, media.videoUrl!), attachFolder, "video.mp4");
      if (embed) mediaEmbeds.push(embed);
      if (media.coverUrl) {
        const coverEmbed = await this.mediaDownloader.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg");
        if (coverEmbed) {
          mediaEmbeds.push(coverEmbed);
          coverFile = `${attachFolder}/cover.jpg`;
        }
      }
    } else if (media.coverUrl) {
      const embed = await this.mediaDownloader.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg");
      if (embed) {
        mediaEmbeds.push(embed);
        coverFile = `${attachFolder}/cover.jpg`;
      }
    }

    // Fetch subtitle transcript (best-effort, non-blocking on failure)
    let subtitle: string | undefined;
    const subtitleUrl = extractTikTokSubtitleUrl(record);
    if (subtitleUrl) {
      const vtt = await downloadTikTokSubtitle(subtitleUrl);
      if (vtt) {
        // Cache raw VTT before parsing
        await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
        await this.noteWriter.writeSidecar(`${attachFolder}/subtitle.vtt`, vtt);
        const parsed = parseWebVTT(vtt);
        if (parsed.length > 10) subtitle = parsed;
      }
    }

    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));

    const tags = [...new Set(["tiktok", ...media.hashtags, ...(media.collection ? [`collection/${sanitizeFilename(media.collection)}`] : [])])];
    const fm = buildFrontmatter({
      roost_id: record.id,
      title: text.replace(/\n/g, " "),
      cover: coverFile ? `[[${coverFile}]]` : undefined,
      platform: "tiktok",
      author: authorLink,
      url,
      collection: media.collection,
      sound: media.sound ? `${media.sound.title} — ${media.sound.author}` : undefined,
      published: published ? published.split("T")[0] : undefined,
      saved: record.saved_at?.split("T")[0],
      subtitle,
      tags,
      stats_plays: media.stats?.plays || undefined,
      stats_likes: media.stats?.likes || undefined,
      stats_comments: media.stats?.comments || undefined,
      stats_shares: media.stats?.shares || undefined,
      stats_saves: media.stats?.saves || undefined,
    });
    await this.noteWriter.writeNote(folderPath, sanitizeFilename(`${handle} - ${itemId}`) + ".md", fm, []);
  }
}
