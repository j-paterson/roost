/**
 * Twitter/X platform descriptor.
 * Config values copied verbatim from:
 *   - webview-manager.ts  (AUTH_COOKIES, PLATFORM_ORIGIN, create() url)
 *   - config.ts           (PLATFORM_DISPLAY["twitter"])
 *   - platform-card.tsx   (TITLES["x"], EDU_COPY["x"])
 */
import type { PlatformDescriptor } from "./descriptor";
import { syncTwitter } from "@/sync/twitter-sync";
import {
  roostUnwrapTweet,
  roostParseTwitterDate,
  roostBookmarkId,
} from "@/lib/normalize-helpers";
import {
  extractArticleContent,
  renderArticleNoteBody,
  renderArticleStubBody,
  type ArticleResultRaw,
} from "@/lib/article-extract";
import {
  getTwitterUserName,
  getTwitterUserScreenName,
  expandTweetUrls,
  extractTwitterMedia,
} from "@/lib/twitter-helpers";
// @ts-ignore — raw probe loaded as string by esbuild/vitest rawProbePlugin
import twitterProbeSource from "../probes/twitter-probe.probe";

export const twitter: PlatformDescriptor = {
  id: "twitter",
  hubId: "x",
  displayName: "X",
  card: {
    title: "X / Twitter",
    eduCopy: "Syncs X bookmarks via your Obsidian webview login.",
  },
  origin: "https://x.com",
  profileUrl: "https://x.com/",
  authCookies: ["auth_token"],
  enabled: true,
  probeSource: twitterProbeSource,
  sync: (wc, webviewEl, opts, onProgress, onRecords, onLog) =>
    syncTwitter(wc, webviewEl, opts, onProgress, onRecords, onLog),
  parse: {
    id: (record) => {
      const raw = record?.rawData || record?.castData || null;
      return record?.itemId || raw?.rest_id || raw?.legacy?.id_str || null;
    },
    caption: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return "";
      // Article path — runs BEFORE the tweet text path.
      // Articles can be the bookmark itself or appear under quoted_status_result.
      const articleResult: ArticleResultRaw | null =
        (raw as typeof raw & { article?: { article_results?: { result?: ArticleResultRaw } } })
          .article?.article_results?.result ??
        (raw as typeof raw & { quoted_status_result?: { result?: { article?: { article_results?: { result?: ArticleResultRaw } } } } })
          .quoted_status_result?.result?.article?.article_results?.result ??
        null;

      if (articleResult) {
        const parsed = extractArticleContent(articleResult);
        if (parsed) return renderArticleNoteBody(parsed);
        return renderArticleStubBody(articleResult);
      }

      return expandTweetUrls(roostUnwrapTweet(raw));
    },
    authorName: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return "Unknown";
      return getTwitterUserName(raw) || getTwitterUserScreenName(raw) || "Unknown";
    },
    authorHandle: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return null;
      return getTwitterUserScreenName(raw);
    },
    url: (record) => {
      const raw = record?.rawData || record?.castData || null;
      if (!raw) return null;
      const username = getTwitterUserScreenName(raw);
      const itemId = record?.itemId || raw?.rest_id || raw?.legacy?.id_str || null;
      if (username && itemId) return `https://x.com/${username}/status/${itemId}`;
      return null;
    },
    media: (record) => extractTwitterMedia(record),
    normalize: (item, options) => {
      const tweet = roostUnwrapTweet(item);
      const itemId: string | undefined = tweet?.rest_id || item?.rest_id || item?.legacy?.id_str;
      if (!itemId) return null;
      const published = roostParseTwitterDate(tweet?.legacy?.created_at);
      return {
        id: roostBookmarkId("twitter", itemId),
        platform: "twitter", itemId,
        rawData: tweet || item,
        saved_at: options.savedAt || published || new Date().toISOString(),
        published_at: published,
        captured_via: options.capturedVia || "sync",
      };
    },
  },
};
