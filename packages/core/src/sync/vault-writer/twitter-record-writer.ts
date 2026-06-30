import { Vault, TFile } from "obsidian";
import { buildFrontmatter, ensureFolder, type FrontmatterValue } from "@/lib/vault-helpers";
import { enrichmentVersionField } from "@/lib/enrichments";
import { type VaultIndex } from "./vault-index";
import { type NoteFileWriter, articleFrontmatterFields } from "./note-file-writer";
import { type MediaDownloader } from "./media-downloader";
import { type NormalizedRecord } from "../../lib/normalize";
import { renderCardAsync } from "../card-renderer";
import { renderTweetBody } from "@/lib/tweet-render";
import { RENDERED_TWEET_ENRICHMENT } from "@/sync/tweet-body-backfill";
import {
  getBookmarkPlatform, getBookmarkItemId, extractBookmarkText,
  extractBookmarkAuthor, extractBookmarkAuthorUsername,
  extractTwitterMedia, sanitizeFilename,
  type BookmarkRecord,
} from "../../lib/extract";
import {
  downloadTwitterImage, downloadTwitterVideo,
} from "../media-downloader";
import { type ThreadSegment } from "../thread-fetcher";
import { extractTwitterLink } from "@/lib/twitter-helpers";

export interface ThreadSegmentMeta {
  rest_id: string;
  pages: number[];
  isFocal: boolean;
  isQuoted: boolean;
  text: string;
}

export interface ThreadMeta {
  success: boolean;
  attempted_at: string;
  focalIndex: number;
  pageCount: number;
  segments: ThreadSegmentMeta[];
}

export async function loadQuotedTweetBitmap(url: string | null | undefined): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const bytes = await downloadTwitterImage(url);
    if (!bytes) return null;
    return await createImageBitmap(new Blob([bytes]));
  } catch {
    return null;
  }
}

interface TwitterRecordWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  noteWriter: NoteFileWriter;
  mediaDownloader: MediaDownloader;
  ensuredFolders: Set<string>;
}

export class TwitterRecordWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private ensuredFolders: Set<string>;

  constructor(opts: TwitterRecordWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.log = opts.log;
    this.index = opts.index;
    this.noteWriter = opts.noteWriter;
    this.mediaDownloader = opts.mediaDownloader;
    this.ensuredFolders = opts.ensuredFolders;
  }

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

  async writeTwitterRecord(record: NormalizedRecord): Promise<void> {
    const { text, url, published, itemId, handle, username } = this.noteWriter.extractCommon(record);
    const media = extractTwitterMedia(record);
    const link = extractTwitterLink(record);
    const folder = media.folder;
    const folderPath = `${this.syncFolder}/X`;
    const attachFolder = `${folderPath}/twitter-${itemId}`;

    await ensureFolder(this.vault, folderPath, this.ensuredFolders);
    const authorLink = await this.noteWriter.createAuthorNote(handle, "twitter");

    const mainThread = (record.rawData._thread as ThreadSegment[] | undefined) || [];
    const quotedThread = (record.rawData._quoted_thread as ThreadSegment[] | undefined) || [];
    const isThreaded = mainThread.length > 0 || quotedThread.length > 0;

    let coverFile: string | null = null;
    let cardThumbPath: string | null = null;
    // Real downloaded media embedded inline in the note body ("![[…]]"). The
    // threaded branch leaves this empty — thread media is the carousel (cover +
    // *.png/*.jpg pages), not inline embeds (Decision 4). card.png (the
    // generated text card) is NEVER pushed here (Decision 2).
    const mediaEmbeds: string[] = [];
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
            this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(photo.url), attachFolder, `${photo.index + 1}.jpg`)
          )
        );
        const firstOk = results.findIndex(r => r);
        if (firstOk >= 0) coverFile = `${attachFolder}/${media.photos[firstOk].index + 1}.jpg`;
        // Embed every photo that downloaded, preserving multi-image order.
        results.forEach((ok, i) => {
          if (ok) mediaEmbeds.push(`![[${attachFolder}/${media.photos[i].index + 1}.jpg]]`);
        });
      } else if (media.videoUrl) {
        await this.mediaDownloader.downloadAndSave(() => downloadTwitterVideo(media.videoUrl!), attachFolder, "video.mp4");
        // Poster JPG lives on the media entry and is the only thing the gallery
        // can render via <img> — the mp4 scrub video layers on top of it.
        if (media.videoPosterUrl) {
          const posterOk = await this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(media.videoPosterUrl!), attachFolder, "video-poster.jpg");
          if (posterOk) {
            coverFile = `${attachFolder}/video-poster.jpg`;
            mediaEmbeds.push(`![[${attachFolder}/video-poster.jpg]]`);
          }
        }
        if (!coverFile && media.cardMeta?.thumbnail) {
          const embed = await this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(media.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg");
          if (embed) {
            coverFile = `${attachFolder}/card-thumb.jpg`;
            cardThumbPath = `${attachFolder}/card-thumb.jpg`;
            mediaEmbeds.push(`![[${attachFolder}/card-thumb.jpg]]`);
          }
        }
      } else if (media.cardMeta?.thumbnail) {
        const embed = await this.mediaDownloader.downloadAndSave(() => downloadTwitterImage(media.cardMeta!.thumbnail!), attachFolder, "card-thumb.jpg");
        if (embed) {
          coverFile = `${attachFolder}/card-thumb.jpg`;
          cardThumbPath = `${attachFolder}/card-thumb.jpg`;
          mediaEmbeds.push(`![[${attachFolder}/card-thumb.jpg]]`);
        }
      } else if (text) {
        const quotedBitmap = await loadQuotedTweetBitmap(media.quotedTweet?.photoUrl);
        const subContext = media.quotedTweet
          ? { type: "quote" as const, author: null, username: media.quotedTweet.author, text: media.quotedTweet.text, image: quotedBitmap }
          : media.replyTo
          ? { type: "reply" as const, author: null, username: media.replyTo, text: null }
          : null;
        const cardData = await renderCardAsync({ author: handle.replace(/^@/, ""), username, text, publishedAt: published, subContext });
        if (cardData) {
          const embed = await this.mediaDownloader.downloadAndSave(() => Promise.resolve(cardData), attachFolder, "card.png");
          if (embed) coverFile = `${attachFolder}/card.png`;
        }
      }
    }

    // Body is the rendered markdown for BOTH threaded and non-threaded tweets;
    // renderTweetBody dispatches threads from rawData._thread itself. The PNG
    // cover (card.png / carousel) is set above and left untouched — the note
    // merely gains a real, searchable, formatted body here, plus the real
    // downloaded media inline (photos / video poster / card-thumb — never
    // card.png). renderTweetBody ignores mediaEmbeds for articles (Decision 3).
    bodyParts = [renderTweetBody(record, { mediaEmbeds })].filter(Boolean);

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
      link_url: link?.url,
      link_title: link?.title,
      link_desc: link?.description,
      link_site: link?.siteName,
      link_image: link && cardThumbPath ? `[[${cardThumbPath}]]` : undefined,
      published: published ? published.split("T")[0] : undefined,
      saved: record.saved_at?.split("T")[0],
      collection: folder ?? undefined,
      tags: ["twitter", ...hashtags.map(t => t.slice(1)), ...(folder ? [`collection/${sanitizeFilename(folder)}`] : [])],
      // Stamp at write time so freshly-synced tweets aren't re-flagged by the
      // first-rollout detection predicate in vault-index.
      [enrichmentVersionField("tweetBody")]: RENDERED_TWEET_ENRICHMENT.schemaVersion,
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

  public async renderThreadPages(opts: {
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
          await this.mediaDownloader.downloadAndSave(
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
          await this.mediaDownloader.downloadAndSave(
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
          await this.mediaDownloader.downloadAndSave(
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
          await this.mediaDownloader.downloadAndSave(
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
}
