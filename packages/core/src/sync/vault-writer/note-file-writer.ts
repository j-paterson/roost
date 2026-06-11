import { Vault, TFile } from "obsidian";
import { buildFrontmatter, ensureAuthorNote, updateNoteFrontmatter, type FrontmatterValue } from "@/lib/vault-helpers";
import { getEnrichmentById, enrichmentVersionField, type EnrichmentId } from "@/lib/enrichments";
import { getBookmarkPlatform, getBookmarkItemId, extractBookmarkText, extractBookmarkAuthor, extractBookmarkAuthorUsername, extractBookmarkUrl, extractBookmarkPublishedAt, sanitizeFilename } from "../../lib/extract";
import { articleWordCount, type ArticleResultRaw } from "@/lib/article-extract";
import { type NormalizedRecord } from "../../lib/normalize";
import { type VaultIndex } from "./vault-index";

/**
 * Return the index past the closing `\n---` of the frontmatter block, or -1
 * if the content has no valid frontmatter. Used by rewriteNoteBody to split
 * the existing file into "everything up to and including the closing ---" and
 * "body markdown".
 *
 * The note format written by writeNote / updateNoteFrontmatter is:
 *   ---\n{yaml}\n---\n{body}
 * So the closing delimiter is "\n---\n" and the split point is the index
 * immediately after that 5-character sequence.
 */
function findFrontmatterEnd(content: string): number {
  if (!content.startsWith("---\n")) return -1;
  const second = content.indexOf("\n---\n", 4);
  if (second < 0) return -1;
  return second + 5; // index of first char after "\n---\n"
}

export function articleFrontmatterFields(raw: unknown): Record<string, unknown> {
  const tweet = (raw ?? {}) as Record<string, unknown>;
  const direct = (tweet.article as { article_results?: { result?: ArticleResultRaw } })?.article_results?.result;
  const quoted = (tweet.quoted_status_result as { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } })?.result?.article?.article_results?.result;
  const ar = direct ?? quoted;
  if (!ar) return {};

  const fields: Record<string, unknown> = {
    is_article: true,
    article_title: ar.title || "",
  };
  if (ar.content_state) {
    fields.word_count = articleWordCount(ar);
  } else {
    fields.article_fetch_failed = true;
  }
  if (typeof ar.metadata?.first_published_at_secs === "number") {
    fields.article_published_at = new Date(ar.metadata.first_published_at_secs * 1000).toISOString();
  }
  return fields;
}

interface NoteFileWriterOpts {
  vault: Vault;
  syncFolder: string;
  log: (msg: string) => void;
  index: VaultIndex;
  ensuredFolders: Set<string>;
}

export class NoteFileWriter {
  private vault: Vault;
  private syncFolder: string;
  private log: (msg: string) => void;
  private index: VaultIndex;
  private ensuredFolders: Set<string>;
  private createdAuthors = new Set<string>();

  constructor(opts: NoteFileWriterOpts) {
    this.vault = opts.vault;
    this.syncFolder = opts.syncFolder;
    this.log = opts.log;
    this.index = opts.index;
    this.ensuredFolders = opts.ensuredFolders;
  }

  extractCommon(record: NormalizedRecord) {
    const text = extractBookmarkText(record);
    const author = extractBookmarkAuthor(record);
    const username = extractBookmarkAuthorUsername(record);
    const url = extractBookmarkUrl(record);
    const published = extractBookmarkPublishedAt(record);
    const itemId = getBookmarkItemId(record)!;
    const handle = username ? `@${username}` : author;
    return { text, author, username, url, published, itemId, handle };
  }

  async writeSidecar(filePath: string, content: string): Promise<void> {
    const existing = this.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, content);
    } else {
      await this.vault.create(filePath, content);
    }
  }

  async createAuthorNote(handle: string, platform: string): Promise<string> {
    return ensureAuthorNote(this.vault, handle, platform, this.createdAuthors, this.ensuredFolders);
  }

  async writeNote(folderPath: string, filename: string, frontmatter: string, bodyParts: string[]): Promise<void> {
    const content = `---\n${frontmatter}\n---\n\n${bodyParts.join("\n")}\n`;
    const filePath = `${folderPath}/${filename}`;
    if (!this.vault.getAbstractFileByPath(filePath)) {
      await this.vault.create(filePath, content);
    }
  }

  async writeGenericRecord(record: NormalizedRecord): Promise<void> {
    const { text, url, published, handle } = this.extractCommon(record);
    const fm = buildFrontmatter({
      platform: record.platform, roost_id: record.id, author: handle, url, published, saved: record.saved_at,
    });
    const bodyParts = [text, "", `— ${handle}`];
    const folderPath = `${this.syncFolder}/Other`;
    await this.writeNote(folderPath, sanitizeFilename(`${handle} - ${record.itemId}`) + ".md", fm, bodyParts);
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
    const platform = getBookmarkPlatform(record);
    const itemId = getBookmarkItemId(record);
    if (!itemId) return;
    const username = extractBookmarkAuthorUsername(record);
    const handle = username ? `@${username}` : extractBookmarkAuthor(record);
    const folderPath = platform === "twitter"
      ? `${this.syncFolder}/X`
      : platform === "tiktok"
      ? `${this.syncFolder}/TikTok`
      : `${this.syncFolder}/Other`;
    const noteFile = this.index.findNoteForId(record.id, folderPath, handle, itemId);
    if (!noteFile) return;

    let existing: string;
    try { existing = await this.vault.read(noteFile); } catch { return; }

    const fmEnd = findFrontmatterEnd(existing);
    if (fmEnd < 0) return; // no frontmatter — skip rather than corrupt the file

    // For article records, update frontmatter atomically with the body so that
    // article_fetch_failed is cleared (and word_count / title / published_at are
    // kept in sync) without requiring a separate resync pass.
    const articleFields = articleFrontmatterFields(record.rawData);
    let base = existing;
    if (Object.keys(articleFields).length > 0) {
      const fmUpdates: Record<string, FrontmatterValue> = {};
      for (const [k, v] of Object.entries(articleFields)) {
        fmUpdates[k] = v as FrontmatterValue;
        // word_count being present means content_state is available — clear the
        // failure flag that was set when only a stub was written.
        if (k === "word_count") fmUpdates.article_fetch_failed = undefined;
      }
      // Override the YAML title with the clean article title. Older syncs
      // wrote the rendered body markdown (with newlines flattened to spaces)
      // into the title field — a corruption that survives until something
      // explicitly overwrites it. The sweep path through rewriteNoteBody is
      // the natural place to do that fix-up since it's already touching the
      // note for every article.
      if (typeof articleFields.article_title === "string" && articleFields.article_title) {
        fmUpdates.title = articleFields.article_title;
      }
      // A successful rewriteNoteBody for an article means content_state has
      // just landed in raw.json — stamp the registry's schemaVersion so a
      // future bump auto-invalidates this item via isVersionStale.
      const articleDef = getEnrichmentById("articleBody");
      if (articleDef) fmUpdates[enrichmentVersionField("articleBody")] = articleDef.schemaVersion;
      const withFm = updateNoteFrontmatter(existing, fmUpdates);
      if (withFm) base = withFm;
    }

    // Re-split after the (possibly updated) frontmatter to place the new body.
    const newFmEnd = findFrontmatterEnd(base);
    if (newFmEnd < 0) return;

    const newBody = extractBookmarkText(record);
    // writeNote emits "---\n{fm}\n---\n\n{body}\n" — match that blank-line
    // separator so re-renders are idempotent (no spurious mtime updates).
    const newContent = base.slice(0, newFmEnd) + "\n" + newBody + "\n";
    if (newContent === existing) return; // no-op
    await this.vault.modify(noteFile, newContent);
  }

  /** Stamp the current schema version onto a note's frontmatter for a given
   *  enrichment id. Called by backfill commands after a successful resync so
   *  scanIncompleteIds' isVersionStale check has a baseline to compare
   *  against on a future schemaVersion bump.
   *
   *  No-op when the note can't be located or the version is already current. */
  async stampEnrichmentVersion(roostId: string, enrichmentId: EnrichmentId, version: number): Promise<void> {
    const file = this.index.notePathMap.get(roostId);
    if (!file) return;
    let content: string;
    try { content = await this.vault.read(file); } catch { return; }
    const updated = updateNoteFrontmatter(content, { [enrichmentVersionField(enrichmentId)]: version });
    if (updated && updated !== content) {
      await this.vault.modify(file, updated);
    }
  }
}
