# Plan 031: Render X tweets as formatted markdown bodies (new `tweetBody` enrichment)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in "STOP conditions" occurs, stop and report — do not
> improvise. When done, update the status row in `plans/README.md`.
>
> This plan was hardened by an adversarial review pass; the fixes from that
> review are already baked into the steps below (concrete article dispatch,
> markdown escaping, the corrected test path, pasted backfill boilerplate).

## Base setup (do this FIRST — not optional)

This plan targets the **decomposed VaultWriter** on `origin/main` (commit
`b7d19e8`), where `packages/core/src/sync/vault-writer/` holds the collaborator
files cited below. The local default branch (`hub-ux-and-typecheck` @ `719d54a`)
is an **older pre-decomposition snapshot** where these methods live in a single
monolithic `vault-writer.ts` — do **not** execute there.

```bash
git fetch origin
git checkout -b advisor/031-tweet-rendered-body origin/main
ls packages/core/src/sync/vault-writer/        # must list twitter-record-writer.ts, note-file-writer.ts, vault-index.ts, resync-runner.ts, …
git rev-parse --short HEAD                      # expect b7d19e8 (or a later origin/main commit; then run the drift check below)
```

**Drift check**: if HEAD is past `b7d19e8`, run
`git diff --stat b7d19e8..HEAD -- packages/core/src/sync/vault-writer/ packages/core/src/lib/enrichments.ts packages/core/src/lib/extract.ts packages/core/src/sync/card-renderer.ts packages/core/src/sync/media-backfill.ts`.
If any cited file changed, compare the "Current state" excerpts against the live
code before editing; on a material mismatch, STOP and report. If
`packages/core/src/sync/vault-writer/` does not exist, STOP — you are on the
monolith snapshot.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED
- **Depends on**: none (richer thread bodies benefit from the `thread`
  enrichment having run first — see Maintenance notes; not a hard dependency)
- **Category**: direction / tech-debt
- **Planned at**: commit `b7d19e8` (origin/main, decomposed VaultWriter), 2026-06-12

## Why this matters

Today a **text-only X tweet** is stored as a generated PNG (`card.png`, rendered
via `OffscreenCanvas` in `card-renderer.ts`) referenced as the note `cover`. The
note **body is empty**; the tweet's text survives only in the frontmatter
`title` with **all newlines flattened to spaces**
(`twitter-record-writer.ts:182`). So the text is **not full-text-searchable in
Obsidian, not selectable, not accessible, and loses every line break, mention,
hashtag, link, quoted-tweet, and reply** — the PNG only *colors* those entities
(`card-renderer.ts:125`) for pixels, it never produces real links.

This plan adds a **rendered markdown body to every X tweet note** — line breaks,
linkified `@mentions`/`#hashtags`/URLs, quoted-tweet and reply context as
blockquotes, inline media embeds, and explicit thread structure — as a **new
registry enrichment** (`tweetBody`) that (a) runs automatically on new tweets at
sync time and (b) **re-runs across all existing tweets via a backfill command**
(the user's "reimport"). The generated `card.png` **stays as the gallery cover**
(product decision); the note merely *gains* a real, searchable, formatted body.

## Decisions already made (do not re-litigate)

1. **`card.png` stays** as the gallery cover. This plan **adds** a markdown body;
   it does not remove or change image generation or the `cover` frontmatter.
2. **Scope = all tweets**: text, media, and thread tweets get a consistent
   rendered markdown body. Media tweets keep their media cover *and* gain the
   caption/body.
3. **Full fidelity**: line breaks/paragraphs; linkify URLs (already
   t.co-expanded), `@mentions` (→ `https://x.com/<user>`), `#hashtags`
   (→ `https://x.com/hashtag/<tag>`), emoji passthrough; quoted-tweet and reply
   context as blockquotes; inline media embeds; explicit thread structure.
4. **Articles are untouched.** X Articles already render real markdown; the
   renderer and the backfill must leave them byte-identical (Steps 1, 4, 6).

## Current state

The X write/enrich machinery lives in `sync/vault-writer/` collaborators plus a
couple of `lib/` helpers. Files you touch or reuse:

- `packages/core/src/sync/vault-writer/twitter-record-writer.ts` —
  `writeTwitterRecord` (line 96) picks cover + body; `renderThreadPages`
  (line 209) renders the thread carousel + body.
- `packages/core/src/sync/vault-writer/note-file-writer.ts` — `rewriteNoteBody`
  (line 125) re-renders a note's body from `extractBookmarkText`;
  `stampEnrichmentVersion` (line 194); `writeNote` (line 97). It already imports
  `getEnrichmentById, enrichmentVersionField, type EnrichmentId` from
  `@/lib/enrichments` (line 3) and `getBookmarkPlatform` (line 4); `const
  platform = getBookmarkPlatform(record)` is in scope at line 126.
- `packages/core/src/sync/vault-writer/vault-index.ts` — `IncompleteByCategory`
  (line 13), bucket init (line 123-128), detection predicates (thread @ 225,
  articleBody @ 233), schema-version invalidation loop (line 245-248). Imports
  `{ ENRICHMENTS, isVersionStale }` from `@/lib/enrichments` at line 6
  (`enrichmentVersionField` is **not** yet imported here — you will add it).
- `packages/core/src/lib/enrichments.ts` — `EnrichmentId` union (line 24),
  `EnrichmentDef` (line 41), `ENRICHMENTS` array (line 91). Confirmed exports:
  `enrichmentVersionField` (line 177), `getEnrichmentById` (line 130),
  `isVersionStale` (line 193).
- `packages/core/src/lib/extract.ts` — `extractBookmarkText` (line 148),
  `extractTwitterMedia` (line 222, returns
  `{ photos, videoUrl, videoPosterUrl, cardMeta, quotedTweet, replyTo }`).
  **`expandTweetUrls` is module-private (line 138) — do not import it**; use
  `extractBookmarkText` as the text source (it already returns the expanded
  plain text for a non-article tweet — see the dispatch excerpt below).
- `packages/core/src/lib/article-utils.ts` — `needsArticleBodyBackfill`
  (exported, line 37). Useful for article detection.
- `packages/core/src/sync/card-renderer.ts` — `ENTITY_RE` (line 125) +
  `tokenizeRuns` (line 128, pasted below); `splitParagraphs` (line 39). **Reuse
  the regex + loop pattern by copying them into the new file; do not import from
  or modify card-renderer.ts.** (You may *read* it freely.)
- `packages/core/src/lib/article-extract.ts` — `renderInlineWithEntities`
  (line 248): the existing markdown linkifier (it does **not** escape
  markdown-significant chars because article DraftJS text is structurally clean
  — tweet free-text is **not**, so you must escape; see Step 2).
- `packages/core/src/sync/media-backfill.ts` — **the primary template** for the
  backfill driver: a no-network backfill that walks `raw.json`, builds a record,
  calls a writer method, and stamps the version. Mirror it closely (Step 6).
- `packages/core/src/sync/thread-backfill.ts` — `THREAD_ENRICHMENT` (line 291),
  the `EnrichmentDef` shape to copy.
- `packages/core/src/plugin/register-roost-commands.ts:68-79` — commands
  **auto-register** by iterating `ENRICHMENTS`; adding the registry entry gives
  you a Cmd+P command + a hub backlog row. No edit needed there.

### Key excerpts (verbatim at `b7d19e8`)

**`extractBookmarkText` twitter dispatch** (`extract.ts:148-170`) — note it
routes to the article renderer on **either a direct OR a quoted** article:

```ts
export function extractBookmarkText(record: BookmarkRecord): string {
  const raw = getBookmarkRawData(record);
  if (!raw) return "";
  if (getBookmarkPlatform(record) === "tiktok") return raw.desc || "";
  if (getBookmarkPlatform(record) === "twitter") {
    const tweetForArticle = raw as RawApiData;
    const articleResult: ArticleResultRaw | null =
      (tweetForArticle …).article?.article_results?.result ??
      (tweetForArticle …).quoted_status_result?.result?.article?.article_results?.result ??
      null;
    if (articleResult) {
      const parsed = extractArticleContent(articleResult);
      if (parsed) return renderArticleNoteBody(parsed);
      return renderArticleStubBody(articleResult);
    }
    return expandTweetUrls(roostUnwrapTweet(raw));
  }
  return raw.text || raw.body?.text || "";
}
```

⚠️ **This is the quoted-article trap (Step 1 must handle it):** a *plain tweet
that quotes an Article* makes `extractBookmarkText` return the **quoted
article's** markdown and drop the host tweet's own text. Your renderer must only
treat a **direct** article as an article; for a quote-of-article, render the host
tweet text and the quoted article as a blockquote.

**`tokenizeRuns` + `ENTITY_RE`** (`card-renderer.ts:125-141`) — copy these:

```ts
const ENTITY_RE = /(@[A-Za-z0-9_]{1,15})|(#[\w]+)|(https?:\/\/\S+|[A-Za-z0-9-]+\.[A-Za-z]{2,}\/\S*|\S+\.(?:com|net|org|io|ai|co|app|dev|me|gg|xyz|so)\b\S*)/g;

export function tokenizeRuns(line: string): TextRun[] {
  const runs: TextRun[] = [];
  let lastIndex = 0;
  ENTITY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENTITY_RE.exec(line))) {
    if (m.index > lastIndex) runs.push({ text: line.slice(lastIndex, m.index) });
    runs.push({ text: m[0], color: ENTITY_COLOR });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < line.length) runs.push({ text: line.slice(lastIndex) });
  return runs.length > 0 ? runs : [{ text: line }];
}
```

**Standalone text tweet → PNG, empty body** (`twitter-record-writer.ts:148-161`):

```ts
      } else if (text) {
        const quotedBitmap = await loadQuotedTweetBitmap(media.quotedTweet?.photoUrl);
        const subContext = media.quotedTweet ? { … } : media.replyTo ? { … } : null;
        const cardData = await renderCardAsync({ author: handle.replace(/^@/, ""), username, text, publishedAt: published, subContext });
        if (cardData) {
          const embed = await this.mediaDownloader.downloadAndSave(() => Promise.resolve(cardData), attachFolder, "card.png");
          if (embed) coverFile = `${attachFolder}/card.png`;
        }
      }
    }
```

`let bodyParts: string[] = [];` is declared at **line 111** (mutable — you may
reassign it). For the non-threaded branch it is never populated, so
`writeNote(…, bodyParts)` (line 206) writes an empty body. `title:
text.replace(/\n/g, " ")` (line 182) is the only place the text lands.

**Body re-render path** (`note-file-writer.ts:125-185`) — the "reimport" engine.
The article-frontmatter block (lines 148-174) is a **no-op for non-articles**
(`articleFrontmatterFields` returns `{}`), so for plain/thread tweets this is a
pure body rewrite. `newBody` is the single body source:

```ts
    const newBody = extractBookmarkText(record);
    const newContent = base.slice(0, newFmEnd) + "\n" + newBody + "\n";
    if (newContent === existing) return; // no-op — idempotent
    await this.vault.modify(noteFile, newContent);
```

**Detection + version invalidation** (`vault-index.ts:233-262`):

```ts
          if (needsArticleBodyBackfill(await getRaw())) byCategory.articleBody.add(id);
        }
        const fm = this.metadataCache?.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
        if (fm) {
          for (const def of ENRICHMENTS) {
            if (isVersionStale(def.id, fm, def.schemaVersion)) {
              (byCategory as unknown as Record<string, Set<string>>)[def.id]?.add(id);
            }
          }
          // …playback detection… (block continues to line 261; `if (fm)` closes 262)
        }
```

`isVersionStale` returns **false** when the version field is **absent** — so the
version loop will not flag legacy tweets on first rollout; Step 4's explicit
predicate handles that. The `?.add` is why the `tweetBody` bucket init (Step 4.4)
is **mandatory** — without the bucket, future schema bumps silently no-op.

**media-backfill walk + writer + record** (`media-backfill.ts`, the template):

```ts
// walk (lines 73-109): platform "X" only for us
for (const platform of ["X"] as const) {
  const platformRoot = path.join(vaultRoot, plugin.settings.syncFolder, platform);
  if (!fs.existsSync(platformRoot)) continue;
  walkDir(platformRoot, (filePath) => {
    if (!filePath.endsWith("raw.json")) return;
    const attachFolder = path.dirname(filePath);
    const outerItemId = path.basename(attachFolder).replace(/^twitter-/, "");
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return; }
    queue.push({ attachFolder, outerItemId, raw });
  });
}
// writer (lines 125-132)
const writer = new VaultWriter({
  vault: plugin.app.vault,
  syncFolder: plugin.settings.syncFolder,
  metadataCache: plugin.app.metadataCache,
  onLog: log,
});
await writer.scanIncompleteIds().catch(() => {});
// per-item record (lines 141-149)
const record: NormalizedRecord = {
  id: `twitter:${q.outerItemId}`, platform: "twitter", itemId: q.outerItemId,
  rawData: q.raw, saved_at: new Date().toISOString(), published_at: null, captured_via: "backfill",
};
```

`MEDIA_ENRICHMENT` (`media-backfill.ts:188-197`) and `THREAD_ENRICHMENT`
(`thread-backfill.ts:291-299`) are the two `EnrichmentDef` shapes to copy.

## Commands you will need

| Purpose   | Command                       | Expected on success                       |
|-----------|-------------------------------|-------------------------------------------|
| Install   | `npm ci`                      | exit 0                                     |
| Baseline  | `npm test 2>&1 \| tail -3`    | record the passing count BEFORE you start  |
| Typecheck | `npm run typecheck`           | exit 0, no output                          |
| Unit test | `npm test`                    | all pass (≥ your recorded baseline)        |
| One file  | `npm test -- tweet-render`    | the new test file passes                   |

`npm run lint` exists (eslint) but is **advisory** — warnings are acceptable and
there is no CI lint gate; do not block completion on lint. Do **not** run
`npm run test:e2e` (slow; downloads Obsidian) unless explicitly asked.
Conventions: `strictNullChecks` + `noImplicitAny` (not full strict); `@/` alias →
`packages/core/src/`; frontmatter only via `buildFrontmatter` /
`updateNoteFrontmatter`; conventional-ish commits (`feat(sync): …`).

## Scope

**In scope** (create/modify only these):

- `packages/core/src/lib/tweet-render.ts` *(create)* — the pure renderer.
- `packages/core/src/lib/__tests__/tweet-render.test.ts` *(create)* — unit tests.
- `packages/core/src/sync/tweet-body-backfill.ts` *(create)* — backfill driver +
  `RENDERED_TWEET_ENRICHMENT` def.
- `packages/core/src/lib/enrichments.ts` — add `"tweetBody"` to `EnrichmentId`;
  import + append `RENDERED_TWEET_ENRICHMENT` to `ENRICHMENTS`.
- `packages/core/src/sync/vault-writer/vault-index.ts` — add `tweetBody` bucket +
  the first-rollout detection predicate.
- `packages/core/src/sync/vault-writer/twitter-record-writer.ts` — populate
  `bodyParts` from the renderer and stamp `enrichment_v_tweetBody` at write time.
- `packages/core/src/sync/vault-writer/note-file-writer.ts` — source the twitter
  body from the renderer in `rewriteNoteBody`.
- `packages/core/src/sync/__tests__/write-paths-characterization.test.ts` —
  extend the existing standalone-tweet test (it is at lines 267-300 and asserts
  `cover → …/card.png` via `.toContain`).
- `plans/README.md` — status row.

**Out of scope** (do NOT touch): `card-renderer.ts` (copy its regex; don't
import/modify); the `cover` frontmatter + all media-download logic; any
`views/` / `ui/` gallery code (Obsidian renders the markdown natively); TikTok
and "Other" paths in `rewriteNoteBody`; **article tweets** (must stay identical).

## Git workflow

- Branch already created in Base setup: `advisor/031-tweet-rendered-body` off
  `origin/main`.
- Commit per logical unit (renderer+tests; registry+detection; write-path wiring;
  backfill driver). Conventional commits, e.g.
  `feat(sync): render X tweets as formatted markdown bodies`.
- Do **not** push or open a PR unless the operator asks.

## Steps

### Step 1: Create `lib/tweet-render.ts` with the article-safe dispatch

Create `packages/core/src/lib/tweet-render.ts` exporting
`export function renderTweetBody(record: BookmarkRecord): string`. Import
`BookmarkRecord` from the same module `extract.ts` imports it from (open
`extract.ts`'s import block and copy the `BookmarkRecord` import path; it is the
type used by `extractBookmarkText`). Dispatch:

1. **Direct article only** → `return extractBookmarkText(record)` (unchanged
   article markdown). Detect a **direct** article as: the raw resolves to
   `…article?.article_results?.result` **at the top level** (NOT the
   `quoted_status_result…` path). The robust check: unwrap the tweet
   (`roostUnwrapTweet` is exported from `@/lib/normalize` — confirm the import
   path the same way other files import it) and test
   `unwrapped?.article?.article_results?.result` truthy, OR the raw's own
   `article?.article_results?.result`. Do **not** include the quoted path.
2. **Thread** (`record.rawData._thread` or `_quoted_thread` non-empty) → Step 3.
3. **Plain tweet** (everything else, including a quote-of-article) → Step 2.

Keep this file free of vault/disk I/O so it unit-tests with a plain object.
Return `""` as a temporary stub body for the non-article branches for now.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Plain-tweet rendering — text, line breaks, escaped/linkified entities, quote/reply

Implement the plain branch. **Order matters: escape first, then linkify**, so
entity link syntax you emit isn't itself escaped.

- **Text source**: `const text = extractBookmarkText(record);` — for a non-article
  tweet this is the expanded plain text (t.co already replaced with full URLs).
  Do not re-expand.
- **Line breaks / paragraphs**: split into paragraphs on blank lines (mirror
  `splitParagraphs`: normalize `\r\n?`→`\n`, collapse `\n{3,}`→`\n\n`, split on
  `/\n\s*\n/`). Within a paragraph, keep single `\n` soft breaks as a markdown
  hard break by appending **two trailing spaces** before each `\n`. Join
  paragraphs with `\n\n`. (Mandated: two-trailing-spaces, not bare `\n` — assert
  it in tests. This is deterministic, so re-renders stay idempotent.)
- **Escaping** (per line, on non-entity text only): backslash-escape the
  markdown-significant characters `\ ` `*` `_` `` ` `` `[` `]` `<` `>` and a
  leading `#` / `-` / `>` / digit-`.` at the start of a line (so a tweet line
  like `> hi` or `1. x` doesn't become a blockquote/list). Keep it minimal but
  cover those. Do **not** escape inside the URLs/hrefs you emit.
- **Entity linkification**: copy `ENTITY_RE` + the `tokenizeRuns` loop (pasted
  above) into this file. Walk each line's matches; for non-entity spans, emit the
  **escaped** text; for entities emit markdown:
  - `@user` → `[@user](https://x.com/user)` (strip leading `@` for the URL).
  - `#tag` → `[#tag](https://x.com/hashtag/tag)` (strip leading `#`).
  - URL → before emitting, **trim trailing punctuation** `. , ! ? ; : )` from the
    match (but keep a `)` if there's a matching unbalanced `(` in the URL), then
    emit `[<display>](<href>)`; if the match has no scheme, prefix `https://` in
    the href only. Display = the trimmed match text.
- **Reply context**: if `extractTwitterMedia(record).replyTo` is set, prepend
  `> Replying to [@<replyTo>](https://x.com/<replyTo>)` + a blank line.
- **Quoted tweet** (incl. quote-of-article): if
  `extractTwitterMedia(record).quotedTweet` is set, append a blank line then a
  blockquote — `> [@<author>](https://x.com/<author>)` then each linkified+escaped
  quoted-text line prefixed with `> `.

**Verify**: `npm run typecheck` → exit 0; Step 7's plain/quote/reply/escaping
tests pass.

### Step 3: Thread rendering (read `_thread` DIRECTLY)

⚠️ **Hard constraint**: read `record.rawData._thread` and
`record.rawData._quoted_thread` **straight off `rawData`**. These are top-level
injected keys; `roostUnwrapTweet` strips them, so if you unwrap first you get an
empty thread and every thread silently renders as a single tweet.

Each segment is `{ rest_id, raw }`. For each main segment build
`{ platform: "twitter", itemId: seg.rest_id, rawData: seg.raw }` and render it
with the **plain-tweet helper from Step 2**. Join main segments with
`\n\n---\n\n` (matches today's separator, `twitter-record-writer.ts:345`). If
quoted-thread segments exist, append `\n\n**Quoted thread:**\n\n` then those
segments rendered + joined the same way (mirror lines 346-347).

**Verify**: `npm run typecheck` → exit 0; the thread test passes.

### Step 4: Register `tweetBody` + first-rollout detection (create the def first)

Do these in order so the build is never broken by a missing import:

1. **Create `tweet-body-backfill.ts` with at least the exported def first**
   (full driver in Step 6), so the Step 4.2 import resolves immediately. Minimum:
   ```ts
   export const RENDERED_TWEET_ENRICHMENT: EnrichmentDef = {
     id: "tweetBody",
     displayName: "Tweet body",
     schemaVersion: 1,
     commandId: "backfill-tweet-bodies",
     commandName: "Render X tweet bodies",
     runBackfill: runTweetBodyBackfill,
     panelDetail: "X tweets whose note body is still image-only. Backfill renders the tweet text as formatted markdown (links, quotes, thread structure) into the note body.",
   };
   ```
   (No `categoryMatches`, `chips`, or `fieldsWritten` — it writes only the auto
   `enrichment_v_tweetBody` stamp.)
2. `enrichments.ts:24-27` — add `"tweetBody"` to the data-backfill group of the
   `EnrichmentId` union.
3. `enrichments.ts` — `import { RENDERED_TWEET_ENRICHMENT } from "@/sync/tweet-body-backfill";`
   (near line 78) and append it to `ENRICHMENTS` (after `THREAD_ENRICHMENT`).
4. `vault-index.ts:13-29` — add to `IncompleteByCategory`:
   `/** Twitter only. Tweet note whose body has not been rendered to markdown yet. */ tweetBody: Set<string>;`
5. `vault-index.ts:123-128` — add `tweetBody: new Set<string>(),` to the
   `byCategory` init. **Mandatory** — the version-stale `?.add` at line 247 no-ops
   silently without it.
6. `vault-index.ts` — add `enrichmentVersionField` to the existing
   `@/lib/enrichments` import (line 6). Then **inside the `if (fm) {…}` block**
   (which closes at line 262, after the playback block), add:
   ```ts
   if (fm.platform === "twitter" && fm.is_article !== true
       && fm[enrichmentVersionField("tweetBody")] === undefined) {
     byCategory.tweetBody.add(id);
   }
   ```
   The `is_article !== true` exclusion keeps X Articles out of this bucket
   (Decision 4). Notes with no parseable frontmatter never reach `if (fm)` and are
   silently skipped — acceptable; new tweets always have `platform: "twitter"`.

**Verify**: `npm run typecheck` → exit 0.

### Step 5: Wire the renderer into both body paths

**Initial sync** (`twitter-record-writer.ts`):
- `bodyParts` is `let` (line 111) — reassign it. Immediately **after the
  `if (isThreaded) {…} else {…}` block closes** (the `}` at line 161, before the
  `const hashtags` line 163) add:
  `bodyParts = [renderTweetBody(record)].filter(Boolean);`
  This funnels both threaded and non-threaded tweets through the renderer
  (`renderTweetBody` handles thread dispatch from `rawData._thread`). The
  threaded branch's `result.bodyParts` becomes dead — you may delete the
  `bodyParts` assembly in `renderThreadPages` (lines 342-348) or leave it; do not
  change its cover/carousel logic.
- Keep `coverFile` / `card.png` / `title` exactly as-is.
- Stamp at write time so fresh tweets aren't re-flagged: in the `fmFields` object
  (opens line 180), add
  `[enrichmentVersionField("tweetBody")]: RENDERED_TWEET_ENRICHMENT.schemaVersion,`
  (a plain number — do **not** use an optional-chained lookup that could yield
  `undefined`). Import `enrichmentVersionField` from `@/lib/enrichments` and
  `RENDERED_TWEET_ENRICHMENT` from `@/sync/tweet-body-backfill`, and
  `renderTweetBody` from `@/lib/tweet-render`.

**Reimport / backfill** (`note-file-writer.ts:180`): `platform` is already in
scope (line 126). Dispatch the body source:
```ts
const newBody = platform === "twitter" ? renderTweetBody(record) : extractBookmarkText(record);
```
For articles, `renderTweetBody` delegates to `extractBookmarkText`, so article
notes are byte-identical. Import `renderTweetBody` from `@/lib/tweet-render`.

**Verify**: `npm run typecheck` → exit 0; `npm test -- write-paths` → the
extended characterization test passes.

### Step 6: Backfill driver (mirror `media-backfill.ts`)

Flesh out `tweet-body-backfill.ts`. Copy `media-backfill.ts`'s imports
(`fs`, `path`, `walkDir`, `vaultBasePath`, `cacheDir`, `VaultWriter`,
`NormalizedRecord`, `Notice`, `IRoostPlugin`, `EnrichmentDef`) and its overall
shape, with these differences:

- `export async function runTweetBodyBackfill(plugin: IRoostPlugin): Promise<void>`
  with the same `backfillRunning` guard + `log` helper.
- Walk **`"X"` only** (see the pasted walk above): collect `{ attachFolder,
  outerItemId, raw }` for every `raw.json`. **Skip direct-article items** (apply
  the same direct-article check as Step 1) so Articles stay untouched. Optionally
  skip items already marked `ok` in a resumable cache (mirror
  `media-backfill.ts:51-54,85` with cache file `tweet-body-cache.json`) — or omit
  the cache entirely; `rewriteNoteBody` is idempotent (`newContent === existing`
  → no write), so re-processing is cheap and safe.
- Acquire the writer exactly as pasted (lines 125-132) and
  `await writer.scanIncompleteIds().catch(() => {})` first (populates
  `notePathMap`, which `rewriteNoteBody`/`stampEnrichmentVersion` need).
- Per item: build the `NormalizedRecord` (pasted shape), then
  `await writer.rewriteNoteBody(record);` (NOT `resyncRecord` — we only re-render
  the body, no media re-download) and
  `await writer.stampEnrichmentVersion(record.id, "tweetBody", RENDERED_TWEET_ENRICHMENT.schemaVersion);`
  inside a `try/catch` that logs and continues.
- Periodic progress `log()` + a final `new Notice(summary)` (mirror
  `media-backfill.ts:171-182`).
- Keep the `RENDERED_TWEET_ENRICHMENT` def from Step 4.1 in this file.

The command auto-registers via `register-roost-commands.ts:68-79`; the hub
backlog row renders from the registry. No edits there.

**(Optional, deferrable) inline media embeds**: full fidelity wants media inline.
Because the renderer is pure, append embeds at the **call sites** that know the
attach folder: in `writeTwitterRecord`, after `coverFile` is set, append the
downloaded media as `![[…]]` lines to `bodyParts`; in this driver, enumerate the
attach folder's `*.jpg`/`video-poster.jpg` and append `![[…]]`. **If this is
fiddly, ship Steps 1-5 (text fidelity) without it and note the deferral in the
status row** — the searchable formatted text is the core value and media already
shows as the `cover`.

**Verify**: `npm run typecheck` → exit 0.

### Step 7: Tests

Create `packages/core/src/lib/__tests__/tweet-render.test.ts`. Clone the
`rawData` fixture shapes from an existing test in
`packages/core/src/lib/__tests__/` (`extract.test.ts` and `article-extract.test.ts`
have real tweet/article `rawData` objects — copy their shapes so your fixtures
match what `extractBookmarkText`/`extractTwitterMedia` actually parse). `obsidian`
is auto-mocked (`vitest.config.ts`). One `it` per case:
- plain tweet with `\n` soft breaks + a blank-line paragraph → two-trailing-space
  hard breaks + `\n\n` paragraph split (assert exact markdown).
- `@alice` → `[@alice](https://x.com/alice)`; `#cooking` →
  `[#cooking](https://x.com/hashtag/cooking)`; an expanded URL → markdown link.
- **escaping**: a tweet containing `*bold*`, `_x_`, a leading `> ` line, and a
  `https://en.wikipedia.org/wiki/Foo_(bar)` URL → asterisks/underscores escaped,
  leading `>` escaped, the parenthesized URL link not broken.
- reply tweet (`legacy.in_reply_to_screen_name`) → leading
  `> Replying to [@user](…)`.
- quoted tweet (`quoted_status_result.result`) → trailing blockquote.
- **quote-of-article regression**: host tweet with
  `quoted_status_result.result.article` set but **no** top-level `article` →
  body contains the **host tweet text** (NOT the quoted article markdown).
- thread (`rawData._thread` = 2 segments) → both rendered, joined `\n\n---\n\n`.
- **direct-article regression**: a direct-article record → output **equals**
  `extractBookmarkText(record)`.

Extend `packages/core/src/sync/__tests__/write-paths-characterization.test.ts`:
the existing standalone-text-tweet test (lines 267-300) asserts the `card.png`
cover via `.toContain` — add assertions that the note **body is non-empty and
contains the linkified text** and that `title` is the plain single-line text.

If the scan is cheaply testable, add: a fake note with `platform: "twitter"`,
`is_article` unset, no `enrichment_v_tweetBody` lands in `byCategory.tweetBody`;
the same note with the stamp, or with `is_article: true`, does **not**.

**Verify**: `npm test` → exit 0; `npm test -- tweet-render` → passes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0 with **≥ the baseline** count you recorded at Step 0.
- [ ] `tweet-render.test.ts` exists and **all** its named cases pass — including
      the **quote-of-article regression**, the **direct-article regression**, and
      the **escaping** case (not merely "the file runs").
- [ ] The extended `write-paths-characterization.test.ts` asserts a non-empty
      linkified body + unchanged `card.png` cover + plain `title`, and passes.
- [ ] `grep -n '"tweetBody"' packages/core/src/lib/enrichments.ts` → in the union.
- [ ] `grep -n 'RENDERED_TWEET_ENRICHMENT' packages/core/src/lib/enrichments.ts`
      → imported + in `ENRICHMENTS`.
- [ ] `grep -n 'tweetBody' packages/core/src/sync/vault-writer/vault-index.ts` →
      bucket **and** predicate present.
- [ ] `grep -n 'renderTweetBody' packages/core/src/sync/vault-writer/twitter-record-writer.ts packages/core/src/sync/vault-writer/note-file-writer.ts`
      → wired into both paths.
- [ ] `card-renderer.ts` is unchanged; no files outside the in-scope list are
      modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `packages/core/src/sync/vault-writer/` does not exist, or cited methods aren't
  where the excerpts say (wrong base / drift).
- The **direct-article regression** test does not produce output equal to
  `extractBookmarkText(record)`, or the **quote-of-article** test still emits the
  quoted article's markdown instead of the host text.
- Changing `note-file-writer.ts`'s `newBody` source breaks any existing
  note-file-writer / article-backfill / resync characterization test.
- You cannot determine the VaultWriter construction or the `raw.json` walk/load
  from `media-backfill.ts` — STOP rather than guess the boilerplate.
- The optional media-embed sub-step would require touching `card-renderer.ts` or
  a `views/` file — defer the embeds instead.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **`rewriteNoteBody` now rewrites tweet bodies**, so re-running the `tweetBody`
  backfill (or a future `schemaVersion` bump) **overwrites manual edits** to a
  tweet note's body — same as article-backfill already does for articles. Note
  this in any user-facing changelog.
- **Behavior change for quote-of-article tweets**: previously their body was
  empty (PNG only) and `extractBookmarkText` would have rendered the *quoted
  article*; now the host tweet's own text is rendered with the quoted article as
  a blockquote. This is the intended fix, but it is a visible content change for
  that subset — call it out.
- **Entity linkification is regex-based + escaped heuristically**. X's GraphQL
  bookmark responses lack mention/hashtag entity ranges (only URL entities), so a
  regex (mirroring `card-renderer.ts`) is the pragmatic approach; rare false
  positives are possible (e.g. an `@` in an email). The markdown-escaping is a
  minimal set — widen it if users report rendering glitches.
- **Thread richness depends on the `thread` enrichment** having populated
  `_thread` in `raw.json`; otherwise a thread renders as its single focal tweet.
  Order-independent, just a quality dependency.
- **`card.png` still ships** as the cover. A future plan could drop image
  generation and render a native text card in the gallery (the declined "Replace
  it" option) — that needs `views/` work, out of scope here.
- **Future formatting upgrades**: bump `RENDERED_TWEET_ENRICHMENT.schemaVersion`
  and every stamped tweet auto-re-flows via `isVersionStale` (`vault-index.ts:246`).
- Reviewer focus in the PR: the `note-file-writer.ts` platform dispatch (no
  tiktok/article regression), the `vault-index.ts` predicate (`is_article`
  exclusion; only unstamped twitter notes), the direct-vs-quoted article split in
  the renderer, and that `card.png`/`cover`/`title` are untouched.
