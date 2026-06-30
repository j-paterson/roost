import { Vault } from "obsidian";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildFrontmatter, ensureFolder } from "@/lib/vault-helpers";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter } from "./note-file-writer";
import { type MediaDownloader } from "./media-downloader";
import { type NormalizedRecord } from "../../lib/normalize";
import { sanitizeFilename } from "../../lib/extract";
import { extractRedditMedia, extractRedditLink } from "../../lib/reddit-helpers";
import { domainFromUrl } from "../../lib/link-card";
import { downloadRedditImage, muxRedditVideo } from "../media-downloader";

interface RedditRecordWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  mediaDownloader: MediaDownloader;
  ensuredFolders: Set<string>;
  /** Resolved ffmpeg binary path, or undefined when the ffmpeg lego is absent
   *  (→ v.redd.it video falls back to video-only, no audio mux). */
  ffmpegPath: string | undefined;
}

export class RedditRecordWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private ensuredFolders: Set<string>;
  private ffmpegPath: string | undefined;

  constructor(opts: RedditRecordWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.mediaDownloader = opts.mediaDownloader;
    this.ensuredFolders = opts.ensuredFolders;
    this.ffmpegPath = opts.ffmpegPath;
  }

  async writeRedditRecord(record: NormalizedRecord): Promise<void> {
    const { url, published, itemId, handle } = this.noteWriter.extractCommon(record);
    const raw = record.rawData || {};
    const media = extractRedditMedia(record);
    const link = extractRedditLink(record);
    const folderPath = `${this.syncFolder}/Reddit`;
    const attachFolder = `${folderPath}/reddit-${itemId}`;

    await ensureFolder(this.vault, folderPath, this.ensuredFolders);
    const authorLink = await this.noteWriter.createAuthorNote(handle, "reddit");
    let coverFile: string | null = null;

    if (media.kind === "image" || media.kind === "gallery") {
      for (const img of media.images) {
        const name = `${img.index + 1}.${img.ext}`;
        const embed = await this.mediaDownloader.downloadAndSave(
          () => downloadRedditImage(img.url), attachFolder, name,
        );
        if (embed && coverFile === null) coverFile = `${attachFolder}/${name}`;
      }
    } else if (media.kind === "video" && media.videoUrl && media.videoId) {
      // Mux to an OS temp file (ffmpeg writes there), then import the bytes into
      // the vault via downloadAndSave. muxRedditVideo returns false WITHOUT
      // writing outPath when the video DOWNLOAD itself fails — so guard
      // existence before importing.
      const outPath = path.join(os.tmpdir(), `roost-reddit-${itemId}.mp4`);
      try {
        await muxRedditVideo({
          videoUrl: media.videoUrl,
          dashUrl: media.dashUrl,
          videoId: media.videoId,
          hasAudio: media.hasAudio,
          ffmpegPath: this.ffmpegPath,
          outPath,
          tmpDir: os.tmpdir(),
        });
        if (fs.existsSync(outPath)) {
          const embed = await this.mediaDownloader.downloadAndSave(
            async () => {
              const b = fs.readFileSync(outPath);
              return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
            },
            attachFolder, "video.mp4",
          );
          if (embed) coverFile = `${attachFolder}/video.mp4`;
        }
      } catch (e) {
        this.log(`[reddit] video mux failed for ${record.id}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch { /* ignore */ }
      }
      // Video posters live on signed (external-)preview.redd.it with no permanent
      // i.redd.it copy — fetch the signed URL (query intact) or the cover 404s.
      const posterUrl = media.coverDownloadUrl ?? media.coverUrl;
      if (posterUrl) {
        const embed = await this.mediaDownloader.downloadAndSave(
          () => downloadRedditImage(posterUrl), attachFolder, "cover.jpg",
        );
        if (embed) coverFile = `${attachFolder}/cover.jpg`; // poster is the gallery cover
      }
    } else if (media.kind === "link") {
      const posterUrl = media.coverDownloadUrl ?? media.coverUrl;
      if (posterUrl) {
        const embed = await this.mediaDownloader.downloadAndSave(
          () => downloadRedditImage(posterUrl), attachFolder, "cover.jpg",
        );
        if (embed) coverFile = `${attachFolder}/cover.jpg`;
      }
    }

    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));

    // Note body: the post's selftext (markdown). Removed/deleted → stub.
    const sel = typeof raw.selftext === "string" ? raw.selftext : "";
    const body = (sel === "[removed]" || sel === "[deleted]")
      ? "> [post removed]"
      : sel;

    const subreddit = typeof raw.subreddit === "string" ? raw.subreddit : "";
    const tags = [...new Set(["reddit", ...(subreddit ? [`subreddit/${sanitizeFilename(subreddit)}`] : [])])];

    const fm = buildFrontmatter({
      roost_id: record.id,
      title: typeof raw.title === "string" ? raw.title.replace(/\n/g, " ") : "",
      cover: coverFile ? `[[${coverFile}]]` : undefined,
      platform: "reddit",
      author: authorLink,
      url,
      subreddit: subreddit ? `r/${subreddit}` : undefined,
      link_url: link?.url,
      link_title: link?.title,
      link_site: link?.siteName ?? (link ? (domainFromUrl(link.url) ?? undefined) : undefined),
      link_image: link && coverFile ? `[[${coverFile}]]` : undefined,
      published: published ? published.split("T")[0] : undefined,
      saved: record.saved_at?.split("T")[0],
      tags,
      stats_score: typeof raw.score === "number" ? raw.score : undefined,
      stats_comments: typeof raw.num_comments === "number" ? raw.num_comments : undefined,
    });
    await this.noteWriter.writeNote(
      folderPath,
      sanitizeFilename(`${handle} - ${itemId}`) + ".md",
      fm,
      body ? [body] : [],
    );
  }
}
