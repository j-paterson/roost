import { Vault, MetadataCache } from "obsidian";
import type { ElectronWebview, Platform } from "@/types/sync";
import { TwitterRecordWriter } from "./vault-writer/twitter-record-writer";
import { TikTokRecordWriter } from "./vault-writer/tiktok-record-writer";
import { InstagramRecordWriter } from "./vault-writer/instagram-record-writer";
import { RedditRecordWriter } from "./vault-writer/reddit-record-writer";
import { VaultIndex, type IncompleteIdsResult } from "./vault-writer/vault-index";
export type { IncompleteByCategory, IncompleteIdsResult } from "./vault-writer/vault-index";
import { NoteFileWriter } from "./vault-writer/note-file-writer";
export { articleFrontmatterFields } from "./vault-writer/note-file-writer";
import { MediaDownloader } from "./vault-writer/media-downloader";
import { ResyncRunner } from "./vault-writer/resync-runner";
import { type NormalizedRecord } from "../lib/normalize";
import { type EnrichmentId } from "@/lib/enrichments";
import { getBookmarkPlatform } from "../lib/extract";
import { WRITE_CONCURRENCY } from "@/config";


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
  /** Electron <webview> element for Instagram media downloads */
  instagramWebview?: ElectronWebview;
  /** Resolved ffmpeg binary path for v.redd.it video muxing; undefined when
   *  the ffmpeg lego is absent (video falls back to video-only, no audio). */
  redditFfmpegPath?: string;
  onLog?: (msg: string) => void;
}

export class VaultWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private ensuredFolders = new Set<string>();
  private noteWriter: NoteFileWriter;
  private mediaDownloader: MediaDownloader;
  private twitterWriter: TwitterRecordWriter;
  private tiktokWriter: TikTokRecordWriter;
  private instagramWriter: InstagramRecordWriter;
  private redditWriter: RedditRecordWriter;
  private resyncRunner: ResyncRunner;
  /** Table-driven dispatch for writeBatch — maps platform id to its write fn.
   *  Platforms absent from this map fall through to writeGenericRecord. */
  private writeDispatch: Partial<Record<Platform, (r: NormalizedRecord) => Promise<void>>>;
  /** Cumulative counters across all writeBatch calls */
  private cumulative = { pushed: 0, resynced: 0, skipped: 0, processed: 0 };

  constructor(opts: VaultWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
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
    this.mediaDownloader = new MediaDownloader({
      vault: opts.vault,
      log: this.log,
      index: this.index,
      noteWriter: this.noteWriter,
      ensuredFolders: this.ensuredFolders,
    });
    this.twitterWriter = new TwitterRecordWriter({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      log: this.log,
      index: this.index,
      noteWriter: this.noteWriter,
      mediaDownloader: this.mediaDownloader,
      ensuredFolders: this.ensuredFolders,
    });
    this.tiktokWriter = new TikTokRecordWriter({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      log: this.log,
      index: this.index,
      noteWriter: this.noteWriter,
      mediaDownloader: this.mediaDownloader,
      ensuredFolders: this.ensuredFolders,
      tiktokWc: opts.tiktokWebview,
    });
    this.instagramWriter = new InstagramRecordWriter({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      log: this.log,
      index: this.index,
      noteWriter: this.noteWriter,
      mediaDownloader: this.mediaDownloader,
      ensuredFolders: this.ensuredFolders,
      instagramWc: opts.instagramWebview,
    });
    this.redditWriter = new RedditRecordWriter({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      log: this.log,
      index: this.index,
      noteWriter: this.noteWriter,
      mediaDownloader: this.mediaDownloader,
      ensuredFolders: this.ensuredFolders,
      ffmpegPath: opts.redditFfmpegPath,
    });
    this.resyncRunner = new ResyncRunner({
      vault: opts.vault,
      syncFolder: opts.syncFolder,
      tiktokWc: opts.tiktokWebview,
      log: this.log,
      index: this.index,
      ensuredFolders: this.ensuredFolders,
      noteWriter: this.noteWriter,
      mediaDownloader: this.mediaDownloader,
      twitterWriter: this.twitterWriter,
      instagramWriter: this.instagramWriter,
      redditWriter: this.redditWriter,
    });
    this.writeDispatch = {
      twitter: (r) => this.twitterWriter.writeTwitterRecord(r),
      tiktok: (r) => this.tiktokWriter.writeTikTokRecord(r),
      instagram: (r) => this.instagramWriter.writeInstagramRecord(r),
      reddit: (r) => this.redditWriter.writeRedditRecord(r),
    };
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
    return this.twitterWriter.hydrateThreadFromCache(record);
  }

  async writeBatch(
    records: NormalizedRecord[],
    stopSignal?: { stopped: boolean },
  ): Promise<{ pushed: number; skipped: number; resynced: number }> {
    if (!this.index.existingIds) {
      this.index.existingIds = await this.index.scanExistingIds();
    }

    let pushed = 0, skipped = 0, resynced = 0, completed = 0;
    const batchT0 = Date.now();
    const cum = this.cumulative;
    this.mediaDownloader.setStopSignal(stopSignal || null);
    const existingIds = this.index.existingIds;

    // Process one record: resync if already on disk, else write. Each item is
    // network-/ffmpeg-bound, so several run concurrently (pool below) to overlap
    // the waits. Counter mutations are safe — JS runs these to completion between
    // awaits, never truly in parallel.
    const processRecord = async (record: NormalizedRecord): Promise<void> => {
      if (existingIds.has(record.id)) {
        const t0 = Date.now();
        try { await this.resyncRunner.resyncRecord(record); resynced++; } catch (e: unknown) { this.log(`[resync-err] ${record.id}: ${e instanceof Error ? e.message : String(e)}`); }
        const elapsed = Date.now() - t0;
        if (elapsed > 3000) this.log(`[slow] resync ${record.id} took ${(elapsed / 1000).toFixed(1)}s`);
        skipped++;
      } else {
        try {
          const t0 = Date.now();
          const platform = getBookmarkPlatform(record);
          await (this.writeDispatch[platform as Platform] ?? ((r: NormalizedRecord) => this.noteWriter.writeGenericRecord(r)))(record);
          existingIds.add(record.id);
          pushed++;
          const elapsed = Date.now() - t0;
          if (elapsed > 3000) this.log(`[slow] write ${record.id} took ${(elapsed / 1000).toFixed(1)}s`);
        } catch (e: unknown) {
          this.log(`[error] ${record.id}: ${e instanceof Error ? e.message : String(e)}`);
          skipped++;
        }
      }
      completed++;
      // Periodic progress line; the awaited Promise.race below already yields to
      // the event loop so React can flush these to the UI.
      if (completed % 20 === 0) {
        this.log(`  ${cum.processed + completed} processed (${cum.pushed + pushed} new, ${cum.resynced + resynced} resync, ${cum.skipped - cum.resynced + skipped - resynced} skip)`);
      }
    };

    // Bounded-concurrency pool: keep up to WRITE_CONCURRENCY records in flight.
    const inflight = new Set<Promise<void>>();
    for (const record of records) {
      if (stopSignal?.stopped) break;
      const p = processRecord(record).finally(() => inflight.delete(p));
      inflight.add(p);
      if (inflight.size >= WRITE_CONCURRENCY) await Promise.race(inflight);
    }
    await Promise.all(inflight);

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

  /** Delegating wrapper — callers (thread-backfill, media-backfill) call this;
   *  the actual logic lives in ResyncRunner. */
  async resyncRecord(record: NormalizedRecord): Promise<void> {
    return this.resyncRunner.resyncRecord(record);
  }

  async scanIncompleteIds(): Promise<IncompleteIdsResult> {
    return this.index.scanIncompleteIds();
  }

  async backfillWithOembed(
    incompleteIds: Set<string>,
    stopSignal?: { stopped: boolean },
  ): Promise<{ attempted: number; success: number; failed: number }> {
    return this.mediaDownloader.backfillWithOembed(incompleteIds, stopSignal);
  }
}
