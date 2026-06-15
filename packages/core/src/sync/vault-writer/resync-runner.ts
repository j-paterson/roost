import { Vault } from "obsidian";
import type { ElectronWebview } from "@/types/sync";
import { ensureFolder, updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter, articleFrontmatterFields } from "./note-file-writer";
import { type MediaDownloader, type QuarantinedFile } from "./media-downloader";
import { type TwitterRecordWriter } from "./twitter-record-writer";
import { loadQuotedTweetBitmap, type ThreadMeta } from "./twitter-record-writer";
import { type NormalizedRecord } from "../../lib/normalize";
import { renderCardAsync } from "../card-renderer";
import {
  getBookmarkPlatform, getBookmarkItemId, extractBookmarkText,
  extractBookmarkAuthor, extractBookmarkAuthorUsername, extractBookmarkUrl,
  extractTwitterMedia, extractTikTokMedia,
  extractTikTokSubtitleUrl, parseWebVTT,
} from "../../lib/extract";
import {
  downloadTwitterImage, downloadTwitterVideo,
  downloadTikTokVideo, downloadTikTokImage,
  downloadTikTokSubtitle,
} from "../media-downloader";
import { type ThreadSegment } from "../thread-fetcher";

interface ResyncRunnerOpts {
  vault: Vault;
  syncFolder: string;
  tiktokWc: ElectronWebview | undefined;
  log: (msg: string) => void;
  index: VaultIndex;
  ensuredFolders: Set<string>;
  noteWriter: NoteFileWriter;
  mediaDownloader: MediaDownloader;
  twitterWriter: TwitterRecordWriter;
}

export class ResyncRunner {
  private vault: Vault;
  private syncFolder: string;
  private tiktokWc: ElectronWebview | undefined;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private ensuredFolders: Set<string>;
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private twitterWriter: TwitterRecordWriter;

  constructor(opts: ResyncRunnerOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.tiktokWc = opts.tiktokWc;
    this.log = opts.log;
    this.index = opts.index;
    this.ensuredFolders = opts.ensuredFolders;
    this.noteWriter = opts.noteWriter;
    this.mediaDownloader = opts.mediaDownloader;
    this.twitterWriter = opts.twitterWriter;
  }

  // PUBLIC — called from VaultWriter.writeBatch
  async resyncRecord(record: NormalizedRecord): Promise<void> {
    const platform = getBookmarkPlatform(record);
    const itemId = getBookmarkItemId(record)!;
    const username = extractBookmarkAuthorUsername(record);
    const handle = username ? `@${username}` : extractBookmarkAuthor(record);

    if (platform === "tiktok") {
      const text = extractBookmarkText(record);
      const url = extractBookmarkUrl(record);
      const media = extractTikTokMedia(record);
      const fallbackFolder = `${this.syncFolder}/TikTok`;
      const attachFolder = this.index.findExistingAttachFolder(record.id, "tiktok", itemId, fallbackFolder);
      const folderPath = attachFolder.replace(/\/tiktok-[^/]+$/, "");
      await ensureFolder(this.vault, attachFolder, this.ensuredFolders);

      await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));
      if (media.images.length > 0) {
        await Promise.all(
          media.images.map(img =>
            this.mediaDownloader.downloadAndSave(() => downloadTikTokImage(img.url), attachFolder, `${img.index + 1}.jpg`, true)
          )
        );
      } else if (media.videoUrl && this.tiktokWc) {
        const wc = this.tiktokWc;
        await this.mediaDownloader.downloadAndSave(() => downloadTikTokVideo(wc, media.videoUrl!), attachFolder, "video.mp4", true);
      }
      if (media.coverUrl) {
        await this.mediaDownloader.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg", true);
      }
      let subtitle: string | undefined;
      const subtitleUrl = extractTikTokSubtitleUrl(record);
      if (subtitleUrl && !this.vault.getAbstractFileByPath(`${attachFolder}/subtitle.vtt`)) {
        const vtt = await downloadTikTokSubtitle(subtitleUrl);
        if (vtt) {
          await this.noteWriter.writeSidecar(`${attachFolder}/subtitle.vtt`, vtt);
          const parsed = parseWebVTT(vtt);
          if (parsed.length > 10) subtitle = parsed;
        }
      }

      const noteFile = this.index.findNoteForId(record.id, folderPath, handle, itemId);
      if (noteFile) {
        const content = await this.vault.read(noteFile);
        const hasFile = (name: string) => this.vault.getAbstractFileByPath(`${attachFolder}/${name}`) !== null;
        const coverFile = hasFile("1.jpg") ? `${attachFolder}/1.jpg`
          : hasFile("cover.jpg") ? `${attachFolder}/cover.jpg` : null;
        const updates: Record<string, FrontmatterValue> = {};
        if (text) updates.title = text.replace(/\n/g, " ");
        if (url) updates.url = url;
        if (media.sound) updates.sound = `${media.sound.title} — ${media.sound.author}`;
        if (coverFile) updates.cover = `[[${coverFile}]]`;
        if (media.stats) {
          updates.stats_plays = media.stats.plays;
          updates.stats_likes = media.stats.likes;
          updates.stats_comments = media.stats.comments;
          updates.stats_shares = media.stats.shares;
          updates.stats_saves = media.stats.saves;
        }
        if (subtitle) updates.subtitle = subtitle;

        const updated = updateNoteFrontmatter(content, updates);
        if (updated) {
          await this.vault.modify(noteFile, updated);
        }
      }
    } else if (platform === "twitter") {
      const { text, url, published } = this.noteWriter.extractCommon(record);
      const twitterMedia = extractTwitterMedia(record);
      const attachFolder = this.index.findExistingAttachFolder(record.id, "twitter", itemId, `${this.syncFolder}/X`);
      const folderPath = attachFolder.replace(/\/twitter-[^/]+$/, "");
      await ensureFolder(this.vault, attachFolder, this.ensuredFolders);

      await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));

      const mainThread = (record.rawData._thread as ThreadSegment[] | undefined) || [];
      const quotedThread = (record.rawData._quoted_thread as ThreadSegment[] | undefined) || [];
      const isThreaded = mainThread.length > 0 || quotedThread.length > 0;

      let coverFile: string | null = null;
      let threadMeta: ThreadMeta | null = null;

      if (isThreaded) {
        // First-time thread materialization (no thread.json yet): quarantine any
        // pre-enhancement numbered media so the new carousel can own N.jpg/N.png,
        // but DO NOT destroy it until the new carousel is confirmed on disk —
        // a dead-URL render must never lose the existing copy.
        let quarantined: QuarantinedFile[] = [];
        if (!this.vault.getAbstractFileByPath(`${attachFolder}/thread.json`)) {
          quarantined = await this.mediaDownloader.quarantineLegacyCarousel(attachFolder);
        }
        const result = await this.twitterWriter.renderThreadPages({
          record, attachFolder, handle, username,
          mainThread, quotedThread, skipIfExists: true,
        });
        const coverOnDisk = !!result.coverFile
          && this.vault.getAbstractFileByPath(result.coverFile) != null;
        if (coverOnDisk) {
          // New carousel produced a usable cover — safe to drop the old copies.
          await this.mediaDownloader.dropQuarantine(quarantined);
          coverFile = result.coverFile;
          threadMeta = result.meta;
        } else {
          // Render produced no usable media (e.g. dead CDN URLs). Restore the
          // quarantined originals, keep the existing cover, and do NOT
          // materialize the thread this run so it retries when the source is
          // alive again.
          await this.mediaDownloader.restoreQuarantine(quarantined);
          coverFile = null;
          threadMeta = null;
        }
      } else {
        if (twitterMedia.photos.length > 0) {
          await Promise.all(
            twitterMedia.photos.map(photo =>
              this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(photo.url), attachFolder, `${photo.index + 1}.jpg`, true)
            )
          );
        } else if (twitterMedia.videoUrl) {
          await this.mediaDownloader.downloadAndSave(() => downloadTwitterVideo(twitterMedia.videoUrl!), attachFolder, "video.mp4", true);
          if (twitterMedia.videoPosterUrl) {
            await this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(twitterMedia.videoPosterUrl!), attachFolder, "video-poster.jpg", true);
          }
        }
        if (twitterMedia.cardMeta?.thumbnail) {
          await this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(twitterMedia.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg", true);
        }
        if (!twitterMedia.photos.length && !twitterMedia.videoUrl && !twitterMedia.cardMeta?.thumbnail && text) {
          if (!this.vault.getAbstractFileByPath(`${attachFolder}/card.png`)) {
            const quotedBitmap = await loadQuotedTweetBitmap(twitterMedia.quotedTweet?.photoUrl);
            const subContext = twitterMedia.quotedTweet
              ? { type: "quote" as const, author: null, username: twitterMedia.quotedTweet.author, text: twitterMedia.quotedTweet.text, image: quotedBitmap }
              : twitterMedia.replyTo
              ? { type: "reply" as const, author: null, username: twitterMedia.replyTo, text: null }
              : null;
            const cardData = await renderCardAsync({ author: handle.replace(/^@/, ""), username, text, publishedAt: published, subContext });
            if (cardData) {
              await this.mediaDownloader.downloadAndSave(() => Promise.resolve(cardData), attachFolder, "card.png", true);
            }
          }
        }

        // Pick a cover that <img> can actually render — video.mp4 produces a
        // broken-image icon in the gallery. Prefer real images by checking
        // what exists on disk rather than what the API promised.
        const hasFile = (name: string) => this.vault.getAbstractFileByPath(`${attachFolder}/${name}`) !== null;
        coverFile = twitterMedia.photos.length > 0 ? `${attachFolder}/1.jpg`
          : hasFile("video-poster.jpg") ? `${attachFolder}/video-poster.jpg`
          : hasFile("card-thumb.jpg") ? `${attachFolder}/card-thumb.jpg`
          : hasFile("card.png") ? `${attachFolder}/card.png`
          : hasFile("thumb.png") ? `${attachFolder}/thumb.png`
          : null;
      }

      if (threadMeta) {
        await this.noteWriter.writeSidecar(`${attachFolder}/thread.json`, JSON.stringify(threadMeta, null, 2));
      } else if (
        record.rawData?._thread_probe_failed === true
        && !this.vault.getAbstractFileByPath(`${attachFolder}/thread.json`)
      ) {
        await this.noteWriter.writeSidecar(`${attachFolder}/thread.json`, JSON.stringify({
          success: false,
          attempted: true,
          attempted_at: new Date().toISOString(),
          reason: "fetch_failed",
          segments: [],
        }, null, 2));
      }

      const noteFile = this.index.findNoteForId(record.id, folderPath, handle, itemId);
      if (noteFile) {
        const content = await this.vault.read(noteFile);
        const updates: Record<string, FrontmatterValue> = {};
        if (text) updates.title = text.replace(/\n/g, " ");
        if (url) updates.url = url;
        if (coverFile) updates.cover = `[[${coverFile}]]`;
        if (threadMeta) {
          updates.thread_length = threadMeta.pageCount;
          updates.focal_index = threadMeta.focalIndex;
        }
        // Merge article frontmatter fields so article_fetch_failed is cleared
        // when content_state is now present, and is_article / article_title /
        // word_count / article_published_at are kept in sync.
        const articleFields = articleFrontmatterFields(record.rawData);
        for (const [k, v] of Object.entries(articleFields)) {
          updates[k] = v as FrontmatterValue;
          // If content_state is now present, explicitly clear the failure flag
          // (articleFrontmatterFields omits it when content_state exists, but
          // the existing note may still have it set from a prior stub write).
          if (k === "word_count") updates.article_fetch_failed = undefined;
        }
        // For articles: override title with clean article_title. Without this
        // override, `text` from extractBookmarkText (rendered article markdown
        // or stub) gets jammed into the YAML title field with newlines flattened.
        if (typeof articleFields.article_title === "string" && articleFields.article_title) {
          updates.title = articleFields.article_title;
        }
        const updated = updateNoteFrontmatter(content, updates);
        if (updated) {
          await this.vault.modify(noteFile, updated);
        }
        // Rewrite the note body if this is an article and content_state is now
        // available. For non-articles, rewriteNoteBody is a no-op (not called).
        if (articleFields.is_article === true) {
          await this.noteWriter.rewriteNoteBody(record);
        }
      }
    }
  }
}
