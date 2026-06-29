# Task 7 Report — per-platform parsers live in descriptors

## Status: DONE

## Commit
`617808c` on `feat/platform-descriptor-abstraction`

## Gate Results
- **Golden (30 assertions):** 30/30
- **extract.test.ts (article handling + schema variants):** 13/13
- **Full suite:** 1809/1809 passed (0 failed)
- **tsc --noEmit:** clean

---

## Approach: ESM live-binding circular import (safe)

The "flip" creates: `extract.ts → registry.ts → tiktok.ts → extract.ts` (and similarly for twitter).

This is safe in Vite/vitest native ESM because:
1. All extract.ts symbols that descriptors import (extractTikTokMedia, extractTikTokSubtitleUrl, extractTwitterMedia, expandTweetUrls, getTwitterUserName, getTwitterUserScreenName) are `export function` — hoisted at module link phase.
2. Descriptors only reference those imports inside function body closures, never at module-init time.
3. PLATFORMS = { tiktok, twitter } in registry.ts is evaluated after both descriptor modules complete (no TDZ).
4. No new files created.

---

## Changes

### tiktok.ts
- Removed 5 Task-1 wrapper imports. Kept: extractTikTokMedia, extractTikTokSubtitleUrl.
- parse.id: `record?.itemId || raw?.id || raw?.video?.id || null`
- parse.caption: `raw?.desc || ""`
- parse.authorName: `raw.author?.nickname || raw.author?.uniqueId || "Unknown"`
- parse.authorHandle: `raw.author?.uniqueId || null`
- parse.url: inline username + itemId → `https://www.tiktok.com/@${u}/video/${id}`
- parse.media / subtitleUrl: unchanged wrappers.
- getBookmarkRawData inlined as `record?.rawData || record?.castData || null`.

### twitter.ts
- Removed 5 Task-1 wrapper imports.
- Added: getTwitterUserName, getTwitterUserScreenName, expandTweetUrls, extractTwitterMedia (from extract.ts); roostUnwrapTweet (from normalize); article functions (from article-extract).
- parse.id: `record?.itemId || raw?.rest_id || raw?.legacy?.id_str || null` — legacy.id_str fallback preserved verbatim.
- parse.caption: full article-result extraction (article.article_results.result + quoted_status_result path) BEFORE tweet-text path, then expandTweetUrls(roostUnwrapTweet(raw)).
- parse.authorName: getTwitterUserName(raw) || getTwitterUserScreenName(raw) || "Unknown"
- parse.authorHandle: getTwitterUserScreenName(raw)
- parse.url: inline username (getTwitterUserScreenName) + itemId → https://x.com/…/status/…
- parse.media: extractTwitterMedia(record) (unchanged).

### extract.ts
- Added: import getPlatform from registry; import type Platform from types/sync.
- Removed: article-extract imports (now unused).
- Exported: getTwitterUserName, getTwitterUserScreenName, expandTweetUrls (now needed by twitter.ts).
- 5 public functions replaced with thin delegators: `return getPlatform(platform as Platform).parse.X(record)` for tiktok/twitter; farcaster fallback logic kept inline.

---

## Article pre-branch logic preserved
Entire twitter branch of extractBookmarkText (both article paths + quoted_status_result path) moved verbatim into twitter.ts parse.caption. extract.test.ts article tests: 13/13.

## legacy.id_str fallback preserved
twitter.ts parse.id: third position in `record?.itemId || raw?.rest_id || raw?.legacy?.id_str || null`.

## No recursion
parse.url inlines username/itemId directly rather than calling extractBookmarkAuthorUsername/getBookmarkItemId back through extract.ts. parse.* methods call no extract.ts functions that delegate to themselves.

## Concerns
None.

---

## Fix wave (cycle break)

### Functions moved

**To `packages/core/src/lib/twitter-helpers.ts`** (new file):
- `BookmarkRecord` type
- `getBookmarkRawData` (private helper, now exported)
- `getTwitterUser`, `getTwitterUserLegacy`, `getTwitterUserCore` (private helpers)
- `getTwitterUserName`, `getTwitterUserScreenName` (exported)
- `stripMediaUrls`, `getTweetMediaUrls`, `expandTweetUrls` (exported)
- `extractTwitterMedia` (exported) — quoted-tweet article path reimplemented inline using `extractArticleContent`/`renderArticleNoteBody`/`renderArticleStubBody` from `./article-extract` (no platform deps) to avoid routing through the registry

**To `packages/core/src/lib/tiktok-helpers.ts`** (new file):
- `extractTikTokMedia`, `extractTikTokSubtitleUrl` (exported)
- Private copy of `getBookmarkRawData` one-liner

### extract.ts changes
- Removed all moved function bodies
- Added re-exports from `./twitter-helpers` and `./tiktok-helpers` for backward compat (existing callers unchanged)
- Updated header comment — removed "pure functions, no platform deps" claim; now describes delegation pattern and the helper module split
- `BookmarkRecord` re-exported from `./twitter-helpers`

### Importers updated
- `platforms/twitter.ts`: imports `getTwitterUserName`, `getTwitterUserScreenName`, `expandTweetUrls`, `extractTwitterMedia` from `@/lib/twitter-helpers`
- `platforms/tiktok.ts`: imports `extractTikTokMedia`, `extractTikTokSubtitleUrl` from `@/lib/tiktok-helpers`
- `platforms/descriptor.ts`: `import type { BookmarkRecord, extractTwitterMedia } from "@/lib/twitter-helpers"` + `import type { extractTikTokMedia } from "@/lib/tiktok-helpers"` (no longer imports from `@/lib/extract`)
- `pipeline/shared.ts`: imports `stripMediaUrls`, `getTweetMediaUrls` from `@/lib/twitter-helpers`
- `lib/__tests__/strip-media-urls.test.ts`: imports from `../twitter-helpers`

### Cycle-verification grep results (both must be empty)
```
grep -rn "@/lib/extract" packages/core/src/platforms/  → (empty) ✓
grep -rn "@/platforms" packages/core/src/lib/twitter-helpers.ts  → (empty) ✓
```

### Gate results
- **Golden (30 assertions):** 30/30 ✓
- **extract.test.ts:** 13/13 ✓
- **Full suite:** 1809/1809 passed (0 failed) ✓
- **tsc --noEmit:** clean ✓

### Notes
- First attempt broke the `quote-of-article` regression test (`tweet-render.test.ts`) because the original `extractTwitterMedia` routed through `extractBookmarkText → getPlatform("twitter").parse.caption` which applies the article path. Fixed by importing `article-extract` directly in `twitter-helpers.ts` (no platform cycle since `article-extract.ts` has zero imports) and reimplementing the same article check inline.
- All other callers of `extractTikTokMedia`, `extractTikTokSubtitleUrl`, `extractTwitterMedia` (resync-runner, tiktok-record-writer, views/tweet-view-model, golden tests) continue to import from `@/lib/extract` — the re-exports keep them working without path changes.
