import { Vault, TFile, TFolder, MetadataCache } from "obsidian";
import type { ElectronWebview } from "@/types/sync";
import { buildFrontmatter, ensureFolder, updateNoteFrontmatter, parseFrontmatterEntries, type FrontmatterValue } from "@/lib/vault-helpers";
import { VaultIndex, type IncompleteIdsResult } from "./vault-writer/vault-index";
export type { IncompleteByCategory, IncompleteIdsResult } from "./vault-writer/vault-index";
import { NoteFileWriter, articleFrontmatterFields } from "./vault-writer/note-file-writer";
export { articleFrontmatterFields } from "./vault-writer/note-file-writer";
import { type NormalizedRecord } from "../lib/normalize";
import { type EnrichmentId } from "@/lib/enrichments";
import { renderCardAsync } from "./card-renderer";
import {
  getBookmarkPlatform, getBookmarkItemId, extractBookmarkText,
  extractBookmarkAuthor, extractBookmarkAuthorUsername, extractBookmarkUrl,
  extractBookmarkPublishedAt, extractTwitterMedia, extractTikTokMedia,
  extractTikTokSubtitleUrl, parseWebVTT,
  sanitizeFilename, buildTikTokVideoUrl,
  type BookmarkRecord,
} from "../lib/extract";
import {
  downloadTwitterImage, downloadTwitterVideo,
  downloadTikTokVideo, downloadTikTokImage,
  downloadTikTokSubtitle,
} from "./media-downloader";
import { fetchTikTokOembed, buildOembedRawJson } from "./oembed-fallback";
import { type ThreadSegment } from "./thread-fetcher";


interface ThreadSegmentMeta {
  rest_id: string;
  pages: number[];
  isFocal: boolean;
  isQuoted: boolean;
  text: string;
}

interface ThreadMeta {
  success: boolean;
  attempted_at: string;
  focalIndex: number;
  pageCount: number;
  segments: ThreadSegmentMeta[];
}

function noteDirPath(filePath: string): string {
  return filePath.replace(/\/[^/]+\.md$/, "");
}

async function loadQuotedTweetBitmap(url: string | null | undefined): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const bytes = await downloadTwitterImage(url);
    if (!bytes) return null;
    return await createImageBitmap(new Blob([bytes]));
  } catch {
    return null;
  }
}

interface VaultWriterOpts {
  vault: Vault;
  syncFolder: string;
  /** Obsidian's metadata cache. When provided, scanExistingIds and
   *  scanIncompleteIds read roost_id from the in-memory frontmatter cache
   *  instead of reading every note's content from disk — orders of magnitude
   *  faster on large vaults (esp. on cloud-storage backends like Synology
   *  Drive where every read is a sync round-trip). Optional for backward
   *  compatibility; when omitted, falls back to the legacy disk-read path. */
  metadataCache?: MetadataCache;
  /** Electron <webview> element for TikTok video downloads (private Electron API) */
  tiktokWebview?: ElectronWebview;
  onLog?: (msg: string) => void;
}

export class VaultWriter {
  private vault: Vault;
  private syncFolder: string;
  private tiktokWc: ElectronWebview | undefined;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private ensuredFolders = new Set<string>();
  private noteWriter: NoteFileWriter;
  /** Cumulative counters across all writeBatch calls */
  private cumulative = { pushed: 0, resynced: 0, skipped: 0, processed: 0 };
  /** Current stop signal — checked during downloads */
  private currentStopSignal: { stopped: boolean } | null = null;

  constructor(opts: VaultWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.tiktokWc = opts.tiktokWebview;
    this.log = opts.onLog || (() => {});
    this.index = new VaultIndex({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      metadataCache: opts.metadataCache,
      tiktokWebview: opts.tiktokWebview,
      log: this.log,
    });
    this.noteWriter = new NoteFileWriter({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      log: this.log,
      index: this.index,
      ensuredFolders: this.ensuredFolders,
    });
  }

  async getExistingIds(): Promise<Set<string>> {
    return this.index.getExistingIds();
  }

  /**
   * If a prior sync already probed this Twitter record's thread, copy the
   * cached `_thread_probed` / `_thread` / `_quoted_thread` flags from the
   * stored raw.json onto `record.rawData`. Returns true when hydrated so the
   * caller can skip re-probing. A previous failed probe (`_thread_probe_failed`)
   * is NOT hydrated — those items should be retried.
   *
   * Requires scanIncompleteIds() to have run first so notePathMap is populated
   * for records living under roost_category subfolders.
   */
  async hydrateThreadFromCache(record: NormalizedRecord): Promise<boolean> {
    if (getBookmarkPlatform(record) !== "twitter") return false;
    const itemId = getBookmarkItemId(record);
    if (!itemId) return false;
    const attachFolder = this.index.findExistingAttachFolder(record.id, "twitter", itemId, `${this.syncFolder}/X`);
    const rawFile = this.vault.getAbstractFileByPath(`${attachFolder}/raw.json`);
    if (!(rawFile instanceof TFile)) return false;
    try {
      const raw = JSON.parse(await this.vault.cachedRead(rawFile));
      const probed = raw?._thread_probed === true;
      const hasThread = Array.isArray(raw?._thread) && raw._thread.length >= 2;
      if (!probed && !hasThread) return false;
      if (probed) record.rawData._thread_probed = true;
      if (hasThread) record.rawData._thread = raw._thread;
      if (Array.isArray(raw?._quoted_thread) && raw._quoted_thread.length >= 2) {
        record.rawData._quoted_thread = raw._quoted_thread;
      }
      return true;
    } catch { return false; }
  }

  async writeBatch(
    records: NormalizedRecord[],
    stopSignal?: { stopped: boolean },
  ): Promise<{ pushed: number; skipped: number; resynced: number }> {
    if (!this.index.existingIds) {
      this.index.existingIds = await this.index.scanExistingIds();
    }

    let pushed = 0, skipped = 0, resynced = 0;
    const batchT0 = Date.now();
    const cum = this.cumulative;
    this.currentStopSignal = stopSignal || null;

    for (let i = 0; i < records.length; i++) {
      if (stopSignal?.stopped) break;
      const record = records[i];

      // Yield every 20 items so React can flush log updates to the UI
      if (i > 0 && i % 20 === 0) {
        this.log(`  ${cum.processed + i} processed (${cum.pushed + pushed} new, ${cum.resynced + resynced} resync, ${cum.skipped - cum.resynced + skipped - resynced} skip)`);
        await new Promise(r => setTimeout(r, 0));
      }

      if (this.index.existingIds.has(record.id)) {
        const t0 = Date.now();
        try { await this.resyncRecord(record); resynced++; } catch (e: unknown) { this.log(`[resync-err] ${record.id}: ${e instanceof Error ? e.message : String(e)}`); }
        const elapsed = Date.now() - t0;
        if (elapsed > 3000) this.log(`[slow] resync ${record.id} took ${(elapsed / 1000).toFixed(1)}s`);
        skipped++;
        continue;
      }

      try {
        const t0 = Date.now();
        const platform = getBookmarkPlatform(record);

        if (platform === "twitter") {
          await this.writeTwitterRecord(record);
        } else if (platform === "tiktok") {
          await this.writeTikTokRecord(record);
        } else {
          await this.noteWriter.writeGenericRecord(record);
        }
        this.index.existingIds.add(record.id);
        pushed++;
        const elapsed = Date.now() - t0;
        if (elapsed > 3000) this.log(`[slow] write ${record.id} took ${(elapsed / 1000).toFixed(1)}s`);
      } catch (e: unknown) {
        this.log(`[error] ${record.id}: ${e instanceof Error ? e.message : String(e)}`);
        skipped++;
      }
    }

    cum.pushed += pushed;
    cum.resynced += resynced;
    cum.skipped += skipped;
    cum.processed += records.length;

    const batchElapsed = Date.now() - batchT0;
    if (records.length > 0) {
      this.log(`Batch done: ${records.length} in ${(batchElapsed / 1000).toFixed(1)}s — total: ${cum.pushed} new, ${cum.resynced} resync, ${cum.skipped - cum.resynced} skip (${cum.processed} processed)`);
    }
    return { pushed, skipped, resynced };
  }

  private async clearLegacyCarousel(attachFolder: string): Promise<void> {
    const folder = this.vault.getAbstractFileByPath(attachFolder);
    if (!(folder instanceof TFolder)) return;
    const victims = folder.children.filter(c =>
      c instanceof TFile && (/^\d+\.(jpg|png)$/.test(c.name) || c.name === "card.png")
    );
    for (const v of victims) {
      try { await this.vault.delete(v); } catch { /* ignore */ }
    }
  }

  private async downloadAndSave(
    downloadFn: () => Promise<ArrayBuffer | null>,
    attachFolder: string,
    filename: string,
    skipIfExists = false,
  ): Promise<string | null> {
    const destPath = `${attachFolder}/${filename}`;
    if (skipIfExists && this.vault.getAbstractFileByPath(destPath)) {
      return `![[${destPath}]]`;
    }
    if (this.currentStopSignal?.stopped) return null;
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

  private async writeTwitterRecord(record: NormalizedRecord): Promise<void> {
    const { text, url, published, itemId, handle, username } = this.noteWriter.extractCommon(record);
    const media = extractTwitterMedia(record);
    const folderPath = `${this.syncFolder}/X`;
    const attachFolder = `${folderPath}/twitter-${itemId}`;

    await ensureFolder(this.vault, folderPath, this.ensuredFolders);
    const authorLink = await this.noteWriter.createAuthorNote(handle, "twitter");

    const mainThread = (record.rawData._thread as ThreadSegment[] | undefined) || [];
    const quotedThread = (record.rawData._quoted_thread as ThreadSegment[] | undefined) || [];
    const isThreaded = mainThread.length > 0 || quotedThread.length > 0;

    let coverFile: string | null = null;
    let threadMeta: ThreadMeta | null = null;
    let bodyParts: string[] = [];

    if (isThreaded) {
      const result = await this.renderThreadPages({
        record, attachFolder, handle, username,
        mainThread, quotedThread, skipIfExists: false,
      });
      coverFile = result.coverFile;
      threadMeta = result.meta;
      bodyParts = result.bodyParts;
    } else {
      // coverFile is set ONLY when the underlying download succeeded, otherwise
      // frontmatter would reference a file that was never written (e.g. expired
      // CDN URL, rate limit) and the gallery renders a broken-image icon.
      if (media.photos.length > 0) {
        const results = await Promise.all(
          media.photos.map(photo =>
            this.downloadAndSave(() => downloadTwitterImage(photo.url), attachFolder, `${photo.index + 1}.jpg`)
          )
        );
        const firstOk = results.findIndex(r => r);
        if (firstOk >= 0) coverFile = `${attachFolder}/${media.photos[firstOk].index + 1}.jpg`;
      } else if (media.videoUrl) {
        await this.downloadAndSave(() => downloadTwitterVideo(media.videoUrl!), attachFolder, "video.mp4");
        // Poster JPG lives on the media entry and is the only thing the gallery
        // can render via <img> — the mp4 scrub video layers on top of it.
        if (media.videoPosterUrl) {
          const posterOk = await this.downloadAndSave(() => downloadTwitterImage(media.videoPosterUrl!), attachFolder, "video-poster.jpg");
          if (posterOk) coverFile = `${attachFolder}/video-poster.jpg`;
        }
        if (!coverFile && media.cardMeta?.thumbnail) {
          const embed = await this.downloadAndSave(() => downloadTwitterImage(media.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg");
          if (embed) coverFile = `${attachFolder}/card-thumb.jpg`;
        }
      } else if (media.cardMeta?.thumbnail) {
        const embed = await this.downloadAndSave(() => downloadTwitterImage(media.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg");
        if (embed) coverFile = `${attachFolder}/card-thumb.jpg`;
      } else if (text) {
        const quotedBitmap = await loadQuotedTweetBitmap(media.quotedTweet?.photoUrl);
        const subContext = media.quotedTweet
          ? { type: "quote" as const, author: null, username: media.quotedTweet.author, text: media.quotedTweet.text, image: quotedBitmap }
          : media.replyTo
          ? { type: "reply" as const, author: null, username: media.replyTo, text: null }
          : null;
        const cardData = await renderCardAsync({ author: handle.replace(/^@/, ""), username, text, publishedAt: published, subContext });
        if (cardData) {
          const embed = await this.downloadAndSave(() => Promise.resolve(cardData), attachFolder, "card.png");
          if (embed) coverFile = `${attachFolder}/card.png`;
        }
      }
    }

    const hashtags = (text.match(/#\w+/g) || [] as string[]);

    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);
    await this.noteWriter.writeSidecar(`${attachFolder}/raw.json`, JSON.stringify(record.rawData, null, 2));

    if (threadMeta) {
      await this.noteWriter.writeSidecar(`${attachFolder}/thread.json`, JSON.stringify(threadMeta, null, 2));
    } else if (record.rawData?._thread_probe_failed === true) {
      await this.noteWriter.writeSidecar(`${attachFolder}/thread.json`, JSON.stringify({
        success: false,
        attempted: true,
        attempted_at: new Date().toISOString(),
        reason: "fetch_failed",
        segments: [],
      }, null, 2));
    }

    const fmFields: Record<string, FrontmatterValue> = {
      roost_id: record.id,
      title: text.replace(/\n/g, " "),
      cover: coverFile ? `[[${coverFile}]]` : undefined,
      platform: "twitter",
      author: authorLink,
      url,
      published: published ? published.split("T")[0] : undefined,
      saved: record.saved_at?.split("T")[0],
      tags: ["twitter", ...hashtags.map(t => t.slice(1))],
    };
    if (threadMeta) {
      fmFields.thread_length = threadMeta.pageCount;
      fmFields.focal_index = threadMeta.focalIndex;
    }
    const articleFieldsWrite = articleFrontmatterFields(record.rawData);
    for (const [k, v] of Object.entries(articleFieldsWrite)) {
      fmFields[k] = v as FrontmatterValue;
    }
    // For articles, the `text` from extractBookmarkText is the rendered article
    // markdown (or stub). That body content does NOT belong in the YAML title
    // field. Override with the clean article title.
    if (typeof articleFieldsWrite.article_title === "string" && articleFieldsWrite.article_title) {
      fmFields.title = articleFieldsWrite.article_title;
    }
    const fm = buildFrontmatter(fmFields);
    await this.noteWriter.writeNote(folderPath, sanitizeFilename(`${handle} - ${itemId}`) + ".md", fm, bodyParts);
  }

  private async renderThreadPages(opts: {
    record: NormalizedRecord;
    attachFolder: string;
    handle: string;
    username: string | null;
    mainThread: ThreadSegment[];
    quotedThread: ThreadSegment[];
    skipIfExists: boolean;
  }): Promise<{ coverFile: string | null; meta: ThreadMeta; bodyParts: string[] }> {
    const { record, attachFolder, handle, username, mainThread, quotedThread, skipIfExists } = opts;
    const rawRestId = record.rawData.rest_id;
    const focalId = typeof rawRestId === "string" && rawRestId ? rawRestId : record.itemId;
    if (focalId !== rawRestId) {
      this.log(`[thread] ${record.id}: rawData.rest_id missing/invalid — using itemId ${record.itemId} as focal id`);
    }

    // If main wasn't enriched but quoted was, synthesize a single main segment from the focal tweet.
    const mainSegments: ThreadSegment[] = mainThread.length > 0
      ? mainThread
      : [{ rest_id: focalId, raw: record.rawData }];

    await ensureFolder(this.vault, attachFolder, this.ensuredFolders);

    const segmentMetas: ThreadSegmentMeta[] = [];
    let pageCounter = 0;

    for (const seg of mainSegments) {
      const segRec: BookmarkRecord = { platform: "twitter", itemId: seg.rest_id, rawData: seg.raw };
      const segMedia = extractTwitterMedia(segRec);
      const segText = extractBookmarkText(segRec);
      const segPublished = seg.raw?.legacy?.created_at
        ? new Date(seg.raw.legacy.created_at).toISOString()
        : null;
      const isFocal = seg.rest_id === focalId;
      const pages: number[] = [];

      if (segMedia.photos.length > 0) {
        for (const photo of segMedia.photos) {
          pageCounter++;
          await this.downloadAndSave(
            () => downloadTwitterImage(photo.url),
            attachFolder,
            `${pageCounter}.jpg`,
            skipIfExists,
          );
          pages.push(pageCounter);
        }
      } else {
        // Inline quote on the focal card only when the quoted tweet is NOT itself a thread
        const showQuote = isFocal && quotedThread.length === 0 && !!segMedia.quotedTweet;
        const quotedBitmap = showQuote ? await loadQuotedTweetBitmap(segMedia.quotedTweet!.photoUrl) : null;
        const subContext = showQuote
          ? { type: "quote" as const, author: null, username: segMedia.quotedTweet!.author, text: segMedia.quotedTweet!.text, image: quotedBitmap }
          : null;
        const cardData = await renderCardAsync({
          author: handle.replace(/^@/, ""),
          username,
          text: segText,
          publishedAt: segPublished,
          subContext,
          focal: isFocal,
        });
        if (cardData) {
          pageCounter++;
          await this.downloadAndSave(
            () => Promise.resolve(cardData),
            attachFolder,
            `${pageCounter}.png`,
            skipIfExists,
          );
          pages.push(pageCounter);
        }
      }

      segmentMetas.push({ rest_id: seg.rest_id, pages, isFocal, isQuoted: false, text: segText });
    }

    for (const seg of quotedThread) {
      const segRec: BookmarkRecord = { platform: "twitter", itemId: seg.rest_id, rawData: seg.raw };
      const segMedia = extractTwitterMedia(segRec);
      const segText = extractBookmarkText(segRec);
      const segPublished = seg.raw?.legacy?.created_at
        ? new Date(seg.raw.legacy.created_at).toISOString()
        : null;
      const qAuthor = extractBookmarkAuthor(segRec);
      const qUsername = extractBookmarkAuthorUsername(segRec);
      const pages: number[] = [];

      if (segMedia.photos.length > 0) {
        for (const photo of segMedia.photos) {
          pageCounter++;
          await this.downloadAndSave(
            () => downloadTwitterImage(photo.url),
            attachFolder,
            `${pageCounter}.jpg`,
            skipIfExists,
          );
          pages.push(pageCounter);
        }
      } else {
        const cardData = await renderCardAsync({
          author: qAuthor,
          username: qUsername,
          text: segText,
          publishedAt: segPublished,
          subContext: null,
        });
        if (cardData) {
          pageCounter++;
          await this.downloadAndSave(
            () => Promise.resolve(cardData),
            attachFolder,
            `${pageCounter}.png`,
            skipIfExists,
          );
          pages.push(pageCounter);
        }
      }

      segmentMetas.push({ rest_id: seg.rest_id, pages, isFocal: false, isQuoted: true, text: segText });
    }

    const focalSeg = segmentMetas.find(s => s.isFocal);
    const focalIndex = focalSeg?.pages[0] ?? 1;
    let coverFile: string | null = null;
    if (focalSeg && focalSeg.pages.length > 0) {
      const first = focalSeg.pages[0];
      const jpgPath = `${attachFolder}/${first}.jpg`;
      const pngPath = `${attachFolder}/${first}.png`;
      if (this.vault.getAbstractFileByPath(jpgPath)) coverFile = jpgPath;
      else if (this.vault.getAbstractFileByPath(pngPath)) coverFile = pngPath;
    }

    const bodyParts: string[] = [];
    const mainTexts = segmentMetas.filter(s => !s.isQuoted).map(s => s.text).filter(Boolean);
    const quotedTexts = segmentMetas.filter(s => s.isQuoted).map(s => s.text).filter(Boolean);
    if (mainTexts.length > 0) bodyParts.push(mainTexts.join("\n\n---\n\n"));
    if (quotedTexts.length > 0) {
      bodyParts.push("", "**Quoted thread:**", "", quotedTexts.join("\n\n---\n\n"));
    }

    const meta: ThreadMeta = {
      success: true,
      attempted_at: new Date().toISOString(),
      focalIndex,
      pageCount: pageCounter,
      segments: segmentMetas,
    };

    return { coverFile, meta, bodyParts };
  }

  private async writeTikTokRecord(record: NormalizedRecord): Promise<void> {
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
          this.downloadAndSave(() => downloadTikTokImage(img.url), attachFolder, `${img.index + 1}.jpg`)
        )
      );
      mediaEmbeds.push(...results.filter(Boolean) as string[]);
      const firstOk = results.findIndex(r => r);
      if (firstOk >= 0) coverFile = `${attachFolder}/${media.images[firstOk].index + 1}.jpg`;
    } else if (media.videoUrl && this.tiktokWc) {
      const wc = this.tiktokWc;
      const embed = await this.downloadAndSave(() => downloadTikTokVideo(wc, media.videoUrl!), attachFolder, "video.mp4");
      if (embed) mediaEmbeds.push(embed);
      if (media.coverUrl) {
        const coverEmbed = await this.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg");
        if (coverEmbed) {
          mediaEmbeds.push(coverEmbed);
          coverFile = `${attachFolder}/cover.jpg`;
        }
      }
    } else if (media.coverUrl) {
      const embed = await this.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg");
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

  /**
   * Re-render a note's body from the record's rawData, and for article records
   * also update article-related frontmatter atomically in the same vault.modify
   * call. This mirrors what resyncRecord does so both write paths leave the note
   * in the same final state:
   *   - article_fetch_failed is cleared when content_state is now present
   *   - is_article / article_title / word_count / article_published_at are synced
   *
   * Used by article-backfill and by resyncRecord (Step 6 flush).
   */
  async rewriteNoteBody(record: NormalizedRecord): Promise<void> {
    return this.noteWriter.rewriteNoteBody(record);
  }

  /** Stamp the current schema version onto a note's frontmatter for a given
   *  enrichment id. Called by backfill commands after a successful resync so
   *  scanIncompleteIds' isVersionStale check has a baseline to compare
   *  against on a future schemaVersion bump.
   *
   *  No-op when the note can't be located or the version is already current. */
  async stampEnrichmentVersion(roostId: string, enrichmentId: EnrichmentId, version: number): Promise<void> {
    return this.noteWriter.stampEnrichmentVersion(roostId, enrichmentId, version);
  }

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
            this.downloadAndSave(() => downloadTikTokImage(img.url), attachFolder, `${img.index + 1}.jpg`, true)
          )
        );
      } else if (media.videoUrl && this.tiktokWc) {
        const wc = this.tiktokWc;
        await this.downloadAndSave(() => downloadTikTokVideo(wc, media.videoUrl!), attachFolder, "video.mp4", true);
      }
      if (media.coverUrl) {
        await this.downloadAndSave(() => downloadTikTokImage(media.coverUrl!), attachFolder, "cover.jpg", true);
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
        const coverFile = media.images.length > 0 ? `${attachFolder}/1.jpg`
          : media.coverUrl ? `${attachFolder}/cover.jpg` : null;
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
        // First-time thread materialization (no thread.json yet): clear any
        // pre-enhancement numbered media so the new carousel can own N.jpg/N.png
        // without colliding with the old single focal image or a leftover card.png.
        if (!this.vault.getAbstractFileByPath(`${attachFolder}/thread.json`)) {
          await this.clearLegacyCarousel(attachFolder);
        }
        const result = await this.renderThreadPages({
          record, attachFolder, handle, username,
          mainThread, quotedThread, skipIfExists: true,
        });
        coverFile = result.coverFile;
        threadMeta = result.meta;
      } else {
        if (twitterMedia.photos.length > 0) {
          await Promise.all(
            twitterMedia.photos.map(photo =>
              this.downloadAndSave(() => downloadTwitterImage(photo.url), attachFolder, `${photo.index + 1}.jpg`, true)
            )
          );
        } else if (twitterMedia.videoUrl) {
          await this.downloadAndSave(() => downloadTwitterVideo(twitterMedia.videoUrl!), attachFolder, "video.mp4", true);
          if (twitterMedia.videoPosterUrl) {
            await this.downloadAndSave(() => downloadTwitterImage(twitterMedia.videoPosterUrl!), attachFolder, "video-poster.jpg", true);
          }
        }
        if (twitterMedia.cardMeta?.thumbnail) {
          await this.downloadAndSave(() => downloadTwitterImage(twitterMedia.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg", true);
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
              await this.downloadAndSave(() => Promise.resolve(cardData), attachFolder, "card.png", true);
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
          await this.rewriteNoteBody(record);
        }
      }
    }
  }

  async scanIncompleteIds(): Promise<IncompleteIdsResult> {
    return this.index.scanIncompleteIds();
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
