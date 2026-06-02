/**
 * Shared helpers for locating and merging X/Twitter article content within
 * tweet raw-data objects.
 *
 * These were previously duplicated between src/sync/twitter-sync.ts and
 * src/sync/article-backfill.ts. Centralised here so both callers stay in sync.
 */

import type { ArticleResultRaw } from "@/lib/article-extract";

/**
 * Extract the article_results.result from a raw tweet object, checking both
 * the direct (bookmark-of-article) and quoted-tweet paths.
 * Returns null when no article is present.
 */
export function getArticleResultFromRaw(raw: unknown): ArticleResultRaw | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const direct = (r.article as { article_results?: { result?: ArticleResultRaw } })?.article_results?.result;
  if (direct) return direct;
  const quoted = (r.quoted_status_result as { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } })?.result?.article?.article_results?.result;
  if (quoted) return quoted;
  return null;
}

/**
 * True when the raw tweet object carries an X Article stub but no
 * content_state — i.e., the bookmark sync wrote a preview-only article and
 * the article-backfill command (or sync's Step 6 article-fetch) still owes
 * a TweetResultByRestId fetch to fill in the body.
 *
 * Bookmarks-of-articles return article stubs without content_state
 * regardless of the user's request shape; only TweetResultByRestId with
 * `withArticleRichContentState: true` returns the rich content. Items
 * without any article at all return false (predicate is article-only).
 */
export function needsArticleBodyBackfill(raw: unknown): boolean {
  const article = getArticleResultFromRaw(raw);
  return !!article && !article.content_state;
}

/**
 * Return the tweet-ID of the tweet that hosts an article.
 *   - Direct article: the bookmark's own rest_id.
 *   - Quoted article: the quoted tweet's rest_id.
 * Returns null when the raw object carries no article.
 */
export function articleHostTweetId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Direct bookmark-of-article: article is under r.article. Host tweet is the bookmark itself.
  if ((r.article as { article_results?: unknown })?.article_results) {
    return (r as { rest_id?: string }).rest_id ?? null;
  }
  // Quoted article: host tweet is r.quoted_status_result.result.
  const qsr = (r.quoted_status_result as { result?: { rest_id?: string } })?.result;
  if (qsr?.rest_id) return qsr.rest_id;
  return null;
}

/**
 * Merge the content_state from a freshly-fetched tweet (`fetched`) into a
 * NormalizedRecord's rawData. Handles both the direct-article path and the
 * quoted-tweet path, building any missing intermediate objects so the merge
 * never silently drops a successful fetch.
 *
 * `record.rawData` is mutated in place.
 */
export function mergeArticleContentInto(record: { rawData: unknown }, fetched: unknown): void {
  const recRaw = record.rawData as Record<string, unknown>;
  const fetRaw = fetched as Record<string, unknown>;

  const fetDirect = (fetRaw.article as { article_results?: { result?: ArticleResultRaw } })?.article_results?.result;
  if (fetDirect?.content_state) {
    if (recRaw.article && (recRaw.article as { article_results?: { result?: unknown } })?.article_results?.result) {
      (recRaw.article as { article_results: { result: ArticleResultRaw } }).article_results.result = fetDirect;
    } else {
      recRaw.article = { article_results: { result: fetDirect } };
    }
    return;
  }

  const fetQuoted = (fetRaw.quoted_status_result as { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } })?.result?.article?.article_results?.result;
  if (fetQuoted?.content_state) {
    // Build whatever intermediate objects are missing so the merge doesn't
    // silently drop a successful fetch when the record's quoted_status_result
    // shape is incomplete.
    if (!recRaw.quoted_status_result) recRaw.quoted_status_result = {};
    const qsr = recRaw.quoted_status_result as { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } };
    if (!qsr.result) qsr.result = {};
    if (!qsr.result.article) qsr.result.article = {};
    if (!qsr.result.article.article_results) qsr.result.article.article_results = { result: fetQuoted };
    else qsr.result.article.article_results.result = fetQuoted;
  }
}
