import { Vault, TFile, TFolder, TAbstractFile, MetadataCache } from "obsidian";
import type { ElectronWebview } from "@/types/sync";
import { getSyncFiles, parseRoostId, loadDeletedIds } from "@/lib/vault-utils";
import { MUSIC_SUBCATEGORIES } from "@/config";
import { MEDIA_FIELDS } from "@/pipeline/media-pipeline";
import { ENRICHMENTS, isVersionStale, enrichmentVersionField } from "@/lib/enrichments";
import { needsArticleBodyBackfill } from "@/lib/article-utils";
import { sanitizeFilename } from "@/lib/extract";
import { threadAnchor } from "../thread-fetcher";

/** scanIncompleteIds breakdown — one Set per enrichment category. Keys
 *  match EnrichmentDef ids one-for-one. */
export interface IncompleteByCategory {
  /** raw.json sidecar missing entirely. Recovered by re-syncing the item. */
  rawJson: Set<string>;
  /** Media file (cover image, video, video poster, or numbered images for
   *  multi-image tweets) is missing or in legacy format. */
  mediaFiles: Set<string>;
  /** Twitter only. Self-thread root or tail with no thread.json yet (or
   *  with a bogus failure marker that's been deleted for retry). */
  thread: Set<string>;
  /** Twitter only. Item is an X Article whose raw.json has the article stub
   *  but no content_state. Filled by the article-backfill command. */
  articleBody: Set<string>;
  /** Music item (roost_subcategory === "Music") missing playback URL
   *  resolution. Filled by the Media pipeline's playback step (Spotify
   *  track ID from TikTok DSP metadata, YouTube videoId fallback). */
  playback: Set<string>;
  /** Twitter only. Tweet note whose body has not been rendered to markdown yet. */
  tweetBody: Set<string>;
  /** Twitter only. Note that has never been checked for bookmark-folder membership
   *  (no enrichment_v_folder stamp yet). */
  folder: Set<string>;
}

export interface IncompleteIdsResult {
  /** Union of every byCategory bucket — the set sync uses for filtering
   *  "needs resync" work. An item appears here once even if it lands in
   *  multiple buckets (e.g. missing both media and thread). */
  all: Set<string>;
  byCategory: IncompleteByCategory;
}

interface VaultIndexOpts {
  vault: Vault;
  syncFolder: string;
  metadataCache?: MetadataCache;
  tiktokWebview?: ElectronWebview;
  log: (msg: string) => void;
}

export class VaultIndex {
  private vault: Vault;
  private syncFolder: string;
  private metadataCache: MetadataCache | undefined;
  private tiktokWc: ElectronWebview | undefined;
  private log: (msg: string) => void;

  /** Set of all known roost_ids in the sync folder. Populated by scanExistingIds. */
  existingIds: Set<string> | null = null;
  /** roost_id → note TFile reference (populated by scanExistingIds and scanIncompleteIds) */
  notePathMap = new Map<string, TFile>();

  constructor(opts: VaultIndexOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.metadataCache = opts.metadataCache;
    this.tiktokWc = opts.tiktokWebview;
    this.log = opts.log;
  }

  /**
   * Read a file's roost_id without a disk read when metadataCache is available.
   * Falls back to vault.cachedRead + parseRoostId when not. The metadataCache
   * path is ~100x faster on a 19K-file vault on Synology Drive.
   */
  async readRoostId(file: TFile): Promise<string | null> {
    if (this.metadataCache) {
      const fm = this.metadataCache.getFileCache(file)?.frontmatter;
      const id = fm?.roost_id;
      if (typeof id === "string") return id;
      // No cache entry yet — fall through to disk read for first-load case.
    }
    try {
      const content = await this.vault.cachedRead(file);
      return parseRoostId(content);
    } catch {
      return null;
    }
  }

  async getExistingIds(): Promise<Set<string>> {
    if (!this.existingIds) {
      this.existingIds = await this.scanExistingIds();
    }
    return this.existingIds;
  }

  /**
   * Find the existing attachment folder for a note. The note's parent directory
   * is the authoritative location — resync must write there, not construct a new
   * path from API data (which may differ for Eagle-imported items).
   */
  findExistingAttachFolder(roostId: string, platform: string, itemId: string, fallbackFolder: string): string {
    const noteFile = this.notePathMap.get(roostId);
    if (noteFile) {
      const noteDir = noteFile.path.replace(/\/[^/]+\.md$/, "");
      return `${noteDir}/${platform}-${itemId}`;
    }
    return `${fallbackFolder}/${platform}-${itemId}`;
  }

  findNoteForId(roostId: string, folderPath: string, handle: string, itemId: string): TFile | null {
    // Direct lookup by standard naming
    const direct = this.vault.getAbstractFileByPath(
      `${folderPath}/${sanitizeFilename(`${handle} - ${itemId}`)}.md`
    );
    if (direct instanceof TFile) return direct;
    // Eagle-imported notes use a different filename — fall back to notePathMap
    return this.notePathMap.get(roostId) ?? null;
  }

  /** Result of scanIncompleteIds — an item can land in multiple buckets if
   *  it's missing more than one enrichment, but `all` is the union of every
   *  bucket and is the set sync uses for filtering "needs resync" work. */
  async scanIncompleteIds(): Promise<IncompleteIdsResult> {
    const t0 = Date.now();
    const byCategory: IncompleteByCategory = {
      rawJson: new Set<string>(),
      mediaFiles: new Set<string>(),
      thread: new Set<string>(),
      articleBody: new Set<string>(),
      playback: new Set<string>(),
      tweetBody: new Set<string>(),
      folder: new Set<string>(),
    };
    this.notePathMap.clear();
    const files = getSyncFiles(this.vault, this.syncFolder);
    this.log(`Scanning ${files.length} notes for incomplete items...`);
    // Info-only counters. missingVideo isn't a resync trigger (TikTok video
    // refetch needs a live webview, so we report rather than queue). totalAdds
    // tracks per-bucket inserts before union, so the log can call out items
    // tagged for >1 enrichment when that happens.
    let missingVideo = 0;

    // Per-file scan logic. The disk reads (thread.json + raw.json) are the
    // bottleneck on cloud-backed vaults; we run them in parallel batches
    // below so 11K Twitter notes don't serialize their reads.
    const scanOne = async (file: TFile): Promise<void> => {
      try {
        const id = await this.readRoostId(file);
        if (!id) return;
        const dir = file.path.replace(/\/[^/]+\.md$/, "");
        const platform = id.startsWith("tiktok:") ? "tiktok" : id.startsWith("twitter:") ? "twitter" : null;
        if (!platform) return;
        const itemId = id.split(":")[1];
        const attachFolder = `${dir}/${platform}-${itemId}`;

        this.notePathMap.set(id, file);

        if (!this.vault.getAbstractFileByPath(`${attachFolder}/raw.json`)) {
          byCategory.rawJson.add(id);
          return;
        }
        const folder = this.vault.getAbstractFileByPath(attachFolder);
        if (!(folder instanceof TFolder)) return;

        const children: TAbstractFile[] = folder.children;
        const childNames = new Set(children.map(c => c.name));
        const hasMedia = children.some(c =>
          c.name.endsWith(".jpg") || c.name.endsWith(".mp4") || c.name.endsWith(".png")
        );
        if (!hasMedia) {
          if (platform !== "tiktok" || this.tiktokWc) {
            byCategory.mediaFiles.add(id);
          } else {
            missingVideo++;
          }
        } else if (platform === "twitter" && !childNames.has("1.jpg") && !childNames.has("1.png") && !childNames.has("video.mp4") && childNames.has("media.jpg")) {
          // Legacy single: image exists only as the old media.jpg (no canonical
          // 1.jpg, no PNG carousel, no video) — migrate media.jpg -> 1.jpg.
          byCategory.mediaFiles.add(id);
        } else if (platform === "twitter" && childNames.has("video.mp4") && !childNames.has("video-poster.jpg")) {
          // Video tweet missing its poster image — the gallery cover falls back to
          // <img src=video.mp4> which can't render. Resync to download the poster
          // and rewrite the cover frontmatter.
          byCategory.mediaFiles.add(id);
        }

        // Twitter only: thread + article-body detection. Both branches need
        // raw.json contents, so we lazy-load it once per item and share the
        // parse. Only fires for items we haven't already routed to a bucket
        // — once an item is queued for resync, the rewrite will refresh
        // every enrichment so per-bucket double-tagging would just be noise.
        if (platform === "twitter") {
          let rawCache: unknown | undefined;
          const getRaw = async (): Promise<unknown> => {
            if (rawCache !== undefined) return rawCache;
            const rawFile = this.vault.getAbstractFileByPath(`${attachFolder}/raw.json`);
            if (!(rawFile instanceof TFile)) return rawCache = null;
            try { return rawCache = JSON.parse(await this.vault.cachedRead(rawFile)); }
            catch { return rawCache = null; }
          };

          // Thread state — flag self-thread tails that haven't been enriched.
          // A legitimate thread.json must have segments OR `attempted: true`.
          // Older bogus markers (empty segments, no `attempted` flag) are
          // deleted so the item gets re-flagged and retried.
          let threadJsonBlocks = childNames.has("thread.json");
          if (threadJsonBlocks) {
            const tjFile = this.vault.getAbstractFileByPath(`${attachFolder}/thread.json`);
            if (tjFile instanceof TFile) {
              try {
                const tj = JSON.parse(await this.vault.cachedRead(tjFile));
                const isBogus = tj?.success === false
                  && (!Array.isArray(tj?.segments) || tj.segments.length === 0)
                  && tj?.attempted !== true;
                if (isBogus) {
                  await this.vault.delete(tjFile);
                  threadJsonBlocks = false;
                }
              } catch { /* unreadable — leave it alone */ }
            }
          }
          if (!threadJsonBlocks) {
            const raw = await getRaw() as any;
            if (raw && raw._thread_probed !== true) {
              const hasTail = threadAnchor(raw) || threadAnchor(raw.quoted_status_result?.result);
              const rid = raw.rest_id;
              const cid = raw.legacy?.conversation_id_str;
              const rc = raw.legacy?.reply_count || 0;
              const isRootCandidate = !!(rid && cid && rid === cid && rc > 0);
              if (hasTail || isRootCandidate) byCategory.thread.add(id);
            }
          }

          // Article body — flag X Articles whose raw.json has the article
          // stub but no content_state yet. The bookmark endpoint only
          // returns preview_text; the full body needs a separate
          // TweetResultByRestId fetch (handled by article-backfill).
          if (needsArticleBodyBackfill(await getRaw())) byCategory.articleBody.add(id);
        }

        // Schema-version invalidation. The data-based predicates above
        // answer "is this enrichment present at all?". This loop answers
        // "is the present enrichment stale because the schema bumped?".
        // Missing version field is *not* stale — legacy items aren't
        // auto-flagged; only an explicit version < current trips it.
        const fm = this.metadataCache?.getFileCache(file)?.frontmatter as
          | Record<string, unknown>
          | undefined;
        if (fm) {
          for (const def of ENRICHMENTS) {
            if (isVersionStale(def.id, fm, def.schemaVersion, def.legacyAliases)) {
              (byCategory as unknown as Record<string, Set<string>>)[def.id]?.add(id);
            }
          }
          // Playback detection — music items with no media_spotify_id
          // yet. Pipeline writes the key even when no DSP match (as
          // YAML null), so "key absent" cleanly distinguishes "never
          // tried" from "tried and didn't match".
          const subcat = fm.roost_subcategory;
          if (
            typeof subcat === "string"
            && MUSIC_SUBCATEGORIES.has(subcat.toLowerCase())
            && !(MEDIA_FIELDS.spotifyId in fm)
          ) {
            byCategory.playback.add(id);
          }

          // Tweet-body first-rollout detection. Flag X tweet notes that have
          // never had their body rendered to markdown (no enrichment_v_tweetBody
          // stamp yet). isVersionStale stays false for absent fields, so this
          // explicit predicate is what surfaces legacy tweets on first rollout.
          // X Articles are excluded (Decision 4 — they already render real md).
          if (
            fm.platform === "twitter"
            && fm.is_article !== true
            && fm[enrichmentVersionField("tweetBody")] === undefined
          ) {
            byCategory.tweetBody.add(id);
          }
          // Folder-membership first-rollout detection: any Twitter note with no
          // enrichment_v_folder stamp has never been folder-checked. Stamp-absent
          // is the completeness signal (the backfill stamps even not-in-a-folder
          // tweets), so this surfaces the whole legacy corpus on first rollout.
          if (
            fm.platform === "twitter"
            && fm[enrichmentVersionField("folder")] === undefined
          ) {
            byCategory.folder.add(id);
          }
        }
      } catch { /* skip */ }
    };

    // Process in parallel batches. A batch size of 50 saturates Synology
    // Drive's concurrency without overwhelming it; on local SSD the runtime
    // is identical to higher values. Net win on cloud vaults: 30-50x.
    const BATCH_SIZE = 50;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(scanOne));
    }

    const all = new Set<string>();
    for (const set of Object.values(byCategory)) for (const id of set) all.add(id);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const parts: string[] = [];
    if (byCategory.rawJson.size) parts.push(`${byCategory.rawJson.size} raw-json`);
    if (byCategory.mediaFiles.size) parts.push(`${byCategory.mediaFiles.size} media`);
    if (byCategory.thread.size) parts.push(`${byCategory.thread.size} thread`);
    if (byCategory.articleBody.size) parts.push(`${byCategory.articleBody.size} article-body`);
    if (byCategory.folder.size) parts.push(`${byCategory.folder.size} folder`);
    if (missingVideo) parts.push(`${missingVideo} need video webview`);
    const breakdown = parts.length ? ` — ${parts.join(" · ")}` : "";
    this.log(`Scan done in ${elapsed}s: ${all.size} incomplete${breakdown}`);
    return { all, byCategory };
  }

  async scanExistingIds(): Promise<Set<string>> {
    const t0 = Date.now();
    const ids = new Set<string>();
    const folder = this.vault.getAbstractFileByPath(this.syncFolder);
    if (!folder) return ids;
    const files = getSyncFiles(this.vault, this.syncFolder);
    this.log(`Scanning ${files.length} notes for existing IDs...`);
    for (const file of files) {
      const id = await this.readRoostId(file);
      if (id) {
        ids.add(id);
        this.notePathMap.set(id, file);
      }
    }
    // Merge in tombstoned (deleted) IDs so they are treated as already-known
    const deleted = loadDeletedIds(this.vault);
    for (const id of deleted) ids.add(id);
    this.log(`Found ${ids.size} existing IDs (${deleted.size} deleted) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return ids;
  }
}
