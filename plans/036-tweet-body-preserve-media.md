# Plan 036: Make the rendered tweet-body backfill *additive* — preserve inline media, add the searchable text

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything under "STOP conditions" occurs, stop and report — do
> not improvise. When done, update the status row in `plans/README.md`.

## Base setup (do this FIRST — not optional)

You are in **/tmp/roost-merge**. Branch off the integrated **`deploy-all`** line
(it carries plans 031–035: the `tweetBody` renderer, the pipeline action rows,
and the canonical media deep-links). `node_modules` is already installed.

```bash
cd /tmp/roost-merge
git rev-parse --short deploy-all          # expect 07ee60b (035 just landed)
git checkout -b advisor/036-tweet-body-preserve-media deploy-all
git rev-parse --short HEAD                # confirm you branched off 07ee60b
ls packages/core/src/sync/vault-writer/   # must list twitter-record-writer.ts, note-file-writer.ts
```

Start every shell command with `cd /tmp/roost-merge`. Do **NOT** run git
branch/checkout/commit/push beyond the branch creation above (the operator
merges).

**Drift check**: if HEAD is past `07ee60b`, run
`git diff --stat 07ee60b..HEAD -- packages/core/src/lib/tweet-render.ts packages/core/src/sync/vault-writer/note-file-writer.ts packages/core/src/sync/vault-writer/twitter-record-writer.ts`.
If any of the three cited files changed, compare the "Current state" excerpts
below against the live code before editing; on a material mismatch, STOP and
report.

## Status

- **Priority**: P1 (unblocks a destructive-until-now backfill across 13,407 notes)
- **Effort**: S–M
- **Risk**: MED (touches the live tweet write path; gated by characterization tests)
- **Depends on**: 031 (the `tweetBody` renderer + backfill must exist — they do,
  on `deploy-all`)
- **Category**: correctness / data-safety
- **Planned at**: commit `07ee60b` (`deploy-all`, post-035), 2026-06-12

## Why this matters

Plan 031 (deployed) added a **rendered markdown body** to every X tweet note via
`renderTweetBody(record)` in `lib/tweet-render.ts`. That renderer emits **TEXT
ONLY** — inline media embeds were explicitly deferred in 031 ("inline media
embeds deferred", README row 80). The "Render X tweet bodies" backfill
(`sync/tweet-body-backfill.ts`) calls `rewriteNoteBody`, which **REPLACES the
entire note body** with that text-only render.

Measured on the live vault: **11,070 of 13,407 X notes currently have an inline
`![[…]]` media embed in their body.** So running the backfill as-is would
**STRIP the inline image from ~11K notes.** The media *file* on disk and the
gallery *cover* (`cover:` frontmatter) survive — but the note body itself loses
the inline image and becomes text-only. That is a visible, irreversible
content regression on most of the vault, and it is precisely **why the backfill
has never been run.**

This plan makes the body render **ADDITIVE**: keep whatever media the note
already showed inline, and *add* the searchable, linkified formatted text below
it. After this lands, the backfill is safe to run on all 13,407 notes — and the
initial sync path also starts embedding real downloaded media for new tweets.

The fix has three parts, each in one file:

1. **`lib/tweet-render.ts`** — let `renderTweetBody` accept embed lines and
   append them (stays a pure renderer; computes no paths, touches no disk).
2. **`note-file-writer.ts` `rewriteNoteBody`** (the backfill / reimport path) —
   extract the embed lines from the **existing** note body and pass them
   through, so the backfill **preserves** whatever media was already inline.
   *(This is the load-bearing fix for the 11K notes.)*
3. **`twitter-record-writer.ts` `writeTwitterRecord`** (the initial-sync path) —
   for brand-new tweets there is no old body to preserve from, so **generate**
   the embeds from the media just downloaded (real photos + video poster),
   **excluding `card.png`** (the generated text-card cover, not real media).

## Decisions already made (do not re-litigate)

1. **Preserve, don't recompute, on the backfill path.** `rewriteNoteBody` reads
   the embeds straight off the existing body string. This is naming-era-agnostic
   — legacy `media.jpg`, current `1.jpg`, `video-poster.jpg`, multi-image — it
   just keeps the exact `![[…]]` lines the note already had. Do **not** try to
   re-enumerate the attach folder there (no `fs` in the writer; the existing body
   is the source of truth).
2. **`card.png` is never embedded.** It is the generated text-card *cover*, not
   real media; embedding it inline would duplicate the text as a picture. The
   initial-sync path (part 3) skips it; the preserve path (part 2) never had it
   inline to begin with (card.png notes have empty bodies today).
3. **Articles stay byte-identical.** `renderTweetBody` for a direct article still
   delegates to `extractBookmarkText` and receives **no** `mediaEmbeds`. Don't
   pass embeds on the article branch.
4. **Threads aren't special-cased.** The preserve path keeps whatever embeds were
   in the thread note's body; the thread carousel media is separate (the `cover`
   + the `*.png`/`*.jpg` carousel pages), unaffected here.

## Current state (verbatim at `07ee60b`)

### Part 1 — `lib/tweet-render.ts` (the pure renderer)

`renderPlainTweet` builds a `parts: string[]` array and `join("\n\n")`s it
(lines 226-253). The public entry has **one** parameter today:

```ts
function renderPlainTweet(record: BookmarkRecord): string {
  const text = getHostTweetText(record);
  const media = extractTwitterMedia(record);

  const parts: string[] = [];

  // Reply context — prepended.
  if (media.replyTo) {
    parts.push(`> Replying to [@${media.replyTo}](https://x.com/${media.replyTo})`);
  }

  const body = renderText(text);
  if (body) parts.push(body);

  // Quoted tweet (incl. quote-of-article) — appended as a blockquote.
  if (media.quotedTweet) {
    const qAuthor = media.quotedTweet.author;
    const quoteLines: string[] = [];
    quoteLines.push(`[@${qAuthor}](https://x.com/${qAuthor})`);
    const renderedQuote = renderText(media.quotedTweet.text);
    if (renderedQuote) {
      for (const line of renderedQuote.split("\n")) quoteLines.push(line);
    }
    parts.push(quoteLines.map((l) => `> ${l}`).join("\n"));
  }

  return parts.join("\n\n");
}
```

```ts
function renderThread(record: BookmarkRecord): string {
  // ...builds parts[] from main + quoted segments, then:
  return parts.join("\n\n");
}
```

```ts
export function renderTweetBody(record: BookmarkRecord): string {
  if (isDirectArticle(record)) return extractBookmarkText(record);

  const rawData = record.rawData as RawApiData | undefined;
  const mainThread = (rawData?._thread as unknown[] | undefined) || [];
  const quotedThread = (rawData?._quoted_thread as unknown[] | undefined) || [];
  if (mainThread.length > 0 || quotedThread.length > 0) return renderThread(record);

  return renderPlainTweet(record);
}
```

`isDirectArticle(record)` (exported, line 183) is the article gate.

### Part 2 — `note-file-writer.ts` `rewriteNoteBody` (the backfill / reimport path)

`findFrontmatterEnd(content)` (lines 21-26) returns the index of the first char
**after** the closing `\n---\n` — i.e. the start of the body. The twitter
branch is a **single line** (line 184):

```ts
async rewriteNoteBody(record: NormalizedRecord): Promise<void> {
  const platform = getBookmarkPlatform(record);
  // ...locate noteFile, read `existing`, compute articleFields + `base`...
  const newFmEnd = findFrontmatterEnd(base);
  if (newFmEnd < 0) return;

  // Twitter notes get the rendered markdown body (links, quotes, thread
  // structure); for articles renderTweetBody delegates to extractBookmarkText,
  // so article notes stay byte-identical. TikTok/Other keep the plain text.
  const newBody = platform === "twitter" ? renderTweetBody(record) : extractBookmarkText(record);
  // writeNote emits "---\n{fm}\n---\n\n{body}\n" — match that blank-line
  // separator so re-renders are idempotent (no spurious mtime updates).
  const newContent = base.slice(0, newFmEnd) + "\n" + newBody + "\n";
  if (newContent === existing) return; // no-op
  await this.vault.modify(noteFile, newContent);
}
```

Note `existing` (the full old file) and `findFrontmatterEnd` are both in scope —
`findFrontmatterEnd(existing)` (call it `oldFmEnd`) gives the start of the
**old** body, from which you extract the embeds to preserve.

### Part 3 — `twitter-record-writer.ts` `writeTwitterRecord` (the initial-sync path)

The non-threaded branch sets `coverFile` from the **downloaded** media (lines
124-164). The real-media file names it produces:

- **Photos**: `` `${attachFolder}/${photo.index + 1}.jpg` `` for each
  `media.photos[]` entry whose download succeeded (line 131 downloads
  `` `${photo.index + 1}.jpg` ``; `results[i]` is truthy on success).
- **Video poster**: `` `${attachFolder}/video-poster.jpg` `` when
  `media.videoPosterUrl` downloaded (line 142).
- **card-thumb**: `` `${attachFolder}/card-thumb.jpg` `` (a real thumbnail — a
  link-card image; treat it as embeddable like a photo).
- **card.png**: the generated text card (lines 159-161) — **DO NOT embed.**

`extractTwitterMedia(record)` returns
`{ photos: { url, index }[], videoUrl, videoPosterUrl, cardMeta, … }`
(`extract.ts:223-225`). `attachFolder` = `` `${folderPath}/twitter-${itemId}` ``
is in scope (line 103). The body is built **once**, right before frontmatter:

```ts
    // Body is the rendered markdown for BOTH threaded and non-threaded tweets;
    // renderTweetBody dispatches threads from rawData._thread itself. The PNG
    // cover (card.png / carousel) is set above and left untouched — the note
    // merely gains a real, searchable, formatted body here.
    bodyParts = [renderTweetBody(record)].filter(Boolean);
```

`cover` frontmatter is `` `[[${coverFile}]]` `` (line 192) — note that's a
**non-`!` wikilink** for the cover. Inline body embeds use the `!`-prefixed
form `![[…]]` (an *embed*, which Obsidian renders as the image; a bare `[[…]]`
is just a link). The vault-relative path convention is the full path from the
vault root, e.g. `![[Bookmarks/X/twitter-111/1.jpg]]` — exactly the `coverFile`
string with a `!` prefix and `![[…]]` wrapping.

### The existing characterization tests you will extend

`packages/core/src/sync/__tests__/write-paths-characterization.test.ts`:
- **Photo record** (`makeTwitterPhotoRecord`, id `twitter:111`, lines 213-264):
  one photo at index 0 → `cover: "[[Bookmarks/X/twitter-111/1.jpg]]"`, file
  `Bookmarks/X/twitter-111/1.jpg` written. **After this plan its body must also
  contain `![[Bookmarks/X/twitter-111/1.jpg]]`.**
- **Text/card record** (`makeTwitterTextRecord`, id `twitter:222`, lines
  266-320): no media → `card.png` cover; body already asserts the linkified text
  (`[@alice](…)`, `[#pasta](…)`) and `enrichment_v_tweetBody: 1`. **After this
  plan its body must still contain that text and must NOT contain
  `![[…]/card.png]]`** (card.png is never embedded).

`packages/core/src/lib/__tests__/tweet-render.test.ts` (222 lines): the
`tweet(rawData)` fixture helper + per-case `it(...)` style. Extend it for the
new `mediaEmbeds` option.

## Commands

| Purpose   | Command                                  | Expected                                |
|-----------|------------------------------------------|-----------------------------------------|
| Baseline  | `cd /tmp/roost-merge && npm test 2>&1 \| tail -3` | record the passing count BEFORE you start |
| Typecheck | `npm run typecheck`                      | exit 0, no output                       |
| Tests     | `npm test`                               | all pass (≥ your recorded baseline)     |
| Renderer  | `npm test -- tweet-render`               | passes                                  |
| Write path| `npm test -- write-paths`                | passes                                  |

Conventions: `strictNullChecks` + `noImplicitAny` (not full strict); `@/` alias
→ `packages/core/src/`; frontmatter only via `buildFrontmatter` /
`updateNoteFrontmatter`. `npm run lint` is advisory (no CI gate); do not block
on it. Do **not** run `npm run test:e2e` (slow) unless asked.

## Scope

**In scope** (modify only these):

- `packages/core/src/lib/tweet-render.ts` — add the optional `opts.mediaEmbeds`
  param to `renderTweetBody` and append the embeds.
- `packages/core/src/sync/vault-writer/note-file-writer.ts` — extract existing
  embeds in `rewriteNoteBody` and pass them through (+ a small helper).
- `packages/core/src/sync/vault-writer/twitter-record-writer.ts` — generate
  embeds from downloaded media in `writeTwitterRecord` (excluding `card.png`).
- `packages/core/src/lib/__tests__/tweet-render.test.ts` — new `mediaEmbeds` cases.
- `packages/core/src/sync/__tests__/write-paths-characterization.test.ts` —
  extend the photo + text/card tests.
- `plans/README.md` — status row.

**Out of scope** (do NOT touch):

- `sync/tweet-body-backfill.ts` — the backfill **driver's** walk/`raw.json`
  enumeration logic is unchanged; it already calls `rewriteNoteBody`, which is
  where the preserve fix lives. (The driver gets the fix for free.)
- Any `views/` / gallery code — Obsidian renders the markdown embed natively; the
  cover is untouched.
- Article tweets — must stay byte-identical (Decision 3).
- `card-renderer.ts`, the `cover` frontmatter, media-download logic.
- TikTok / "Other" branches of `rewriteNoteBody`.

## Steps

### Step 1: `renderTweetBody` accepts and appends `mediaEmbeds`

In `packages/core/src/lib/tweet-render.ts`, change the public signature to take
an optional second arg and append the embeds **after** the rendered text (and
after the quote/reply/thread blocks). Keep the renderer pure — it appends
exactly what it's handed; it computes no paths and touches no disk.

1. Add a small option type near the top (after the `TextRun` interface):
   ```ts
   /** Options for renderTweetBody. `mediaEmbeds` are fully-formed embed lines
    *  (e.g. "![[Bookmarks/X/twitter-111/1.jpg]]") appended below the rendered
    *  text. The caller owns path construction; this renderer stays pure. */
   export interface RenderTweetBodyOptions {
     mediaEmbeds?: string[];
   }
   ```
2. Change the entry point:
   ```ts
   export function renderTweetBody(record: BookmarkRecord, opts?: RenderTweetBodyOptions): string {
     if (isDirectArticle(record)) return extractBookmarkText(record);

     const rawData = record.rawData as RawApiData | undefined;
     const mainThread = (rawData?._thread as unknown[] | undefined) || [];
     const quotedThread = (rawData?._quoted_thread as unknown[] | undefined) || [];
     const text = (mainThread.length > 0 || quotedThread.length > 0)
       ? renderThread(record)
       : renderPlainTweet(record);

     return appendMediaEmbeds(text, opts?.mediaEmbeds);
   }
   ```
   (Article branch returns **before** `appendMediaEmbeds`, so articles never get
   embeds — Decision 3.)
3. Add the helper (next to `renderText`):
   ```ts
   /** Append media embed lines below the rendered tweet text. A blank line
    *  separates them; the embeds join with "\n". Pure — no path logic. */
   function appendMediaEmbeds(body: string, embeds: string[] | undefined): string {
     const lines = (embeds ?? []).filter((e) => e && e.trim().length > 0);
     if (lines.length === 0) return body;
     const joined = lines.join("\n");
     return body ? `${body}\n\n${joined}` : joined;
   }
   ```
   (The `body ?` guard handles a media-only tweet whose text render is `""` — the
   embeds become the whole body, no leading blank line.)

**Verify:** `npm run typecheck` → exit 0. Existing `tweet-render` tests still
pass with no 2nd arg (it's optional): `npm test -- tweet-render`.

### Step 2: `rewriteNoteBody` preserves the existing body's embeds (the 11K fix)

In `packages/core/src/sync/vault-writer/note-file-writer.ts`:

1. Add a module-level helper (next to `findFrontmatterEnd`):
   ```ts
   /** Pull every Obsidian *embed* line ("![[ ... ]]") out of a body string, in
    *  order. The leading "!" matters — a bare "[[wikilink]]" is a link, not an
    *  embed, so we only preserve real inline media (image / video). Each returned
    *  string is the full trimmed embed line, e.g. "![[Bookmarks/X/twitter-1/1.jpg]]". */
   export function extractEmbedLines(body: string): string[] {
     const out: string[] = [];
     for (const rawLine of body.split("\n")) {
       const line = rawLine.trim();
       if (/^!\[\[[^\]]+\]\]$/.test(line)) out.push(line);
     }
     return out;
   }
   ```
   Rationale for the per-line, anchored regex: the body the renderer writes puts
   each embed on its **own** line (Step 1 joins with `\n`), and notes in the
   vault follow the same one-embed-per-line convention. Anchoring to the whole
   trimmed line avoids grabbing a `![[…]]` that appears mid-sentence inside the
   rendered prose (there are none today, but it keeps idempotency exact).
2. In `rewriteNoteBody`, **before** computing `newBody`, extract the old body's
   embeds (only for the twitter branch — TikTok/Other are unchanged):
   ```ts
   const newBody =
     platform === "twitter"
       ? renderTweetBody(record, { mediaEmbeds: extractTwitterEmbedsFrom(existing) })
       : extractBookmarkText(record);
   ```
   where `extractTwitterEmbedsFrom` is a tiny local closure (or inline it):
   ```ts
   const oldBodyStart = findFrontmatterEnd(existing);
   const oldBody = oldBodyStart >= 0 ? existing.slice(oldBodyStart) : "";
   const preservedEmbeds = extractEmbedLines(oldBody);
   const newBody =
     platform === "twitter"
       ? renderTweetBody(record, { mediaEmbeds: preservedEmbeds })
       : extractBookmarkText(record);
   ```
   Use `existing` (the original file) for the embed extraction — **not** `base`
   (the article-frontmatter-updated copy). For non-articles `base === existing`;
   for articles the body is unchanged by the frontmatter update so either works,
   but `existing` is the unambiguous source. The body slice from
   `findFrontmatterEnd(existing)` is the old body verbatim.

This makes the backfill **additive**: every note's existing inline media —
legacy `media.jpg`, current `1.jpg`, `video-poster.jpg`, a multi-image set — is
re-emitted unchanged below the freshly rendered, searchable text. A note that
had no embed (the ~2,337 card.png-cover text tweets) gets only the text, exactly
as before.

**Idempotency** still holds: on a second run, the body the first run wrote ends
with those same embed lines (one per line); `extractEmbedLines` pulls the same
set; `renderTweetBody` re-appends the same lines → identical `newBody` →
`newContent === existing` → the `return` guard makes it a no-op. (Test this in
Step 4.)

**Verify:** `npm run typecheck` → exit 0; `npm test -- note-file-writer` and
`npm test -- write-paths` (after Step 4's updates) pass.

### Step 3: `writeTwitterRecord` embeds the real downloaded media (new tweets)

In `packages/core/src/sync/vault-writer/twitter-record-writer.ts`, the
non-threaded branch already knows exactly which media it downloaded. Collect the
**real** media file paths as embeds and pass them to `renderTweetBody`.

The cleanest seam: build an `mediaEmbeds: string[]` alongside `coverFile`. In
the non-threaded `else` block (lines 124-164), push an embed each time a real
download succeeds:

- After the photo `Promise.all` (line 133), for every successful result push the
  matching photo path:
  ```ts
  results.forEach((ok, i) => {
    if (ok) mediaEmbeds.push(`![[${attachFolder}/${media.photos[i].index + 1}.jpg]]`);
  });
  ```
  (Mirror the existing `media.photos[firstOk].index + 1` cover logic — same path
  formula, one per successful photo, preserving multi-image order.)
- For the video poster (line 142), inside the `if (posterOk)`:
  `mediaEmbeds.push(\`![[${attachFolder}/video-poster.jpg]]\`);`
- For `card-thumb.jpg` (lines 145-146 and 149-150), inside each `if (embed)`:
  `mediaEmbeds.push(\`![[${attachFolder}/card-thumb.jpg]]\`);` (a real
  thumbnail — embeddable).
- **`card.png` (lines 159-161): push NOTHING.** It is the generated text card,
  not real media (Decision 2).

Declare `const mediaEmbeds: string[] = [];` next to `let coverFile` (line 112).
For the **threaded** branch leave `mediaEmbeds` empty — thread media is the
carousel (the `cover` + `*.png`/`*.jpg` pages), and the thread body's structure
is the carousel, not inline embeds (Decision 4).

Then change the single body-build line (170) to pass the embeds:

```ts
    bodyParts = [renderTweetBody(record, { mediaEmbeds })].filter(Boolean);
```

`renderTweetBody` for an article ignores `mediaEmbeds` (Step 1), so an X Article
note is unaffected. A new photo/video tweet now gets the searchable text **plus**
its real inline image — matching what the preserved legacy notes will look like
after the backfill.

**Verify:** `npm run typecheck` → exit 0; `npm test -- write-paths` (after Step
4) passes.

### Step 4: Tests

#### 4a. `tweet-render.test.ts` — the renderer appends what it's given

Add a `describe("renderTweetBody — mediaEmbeds option", …)` block. Use the
existing `tweet(rawData)` helper:

- **Appends given embeds below the text, blank-line separated**:
  ```ts
  const out = renderTweetBody(
    tweet({ rest_id: "1", legacy: { full_text: "hello world" } }),
    { mediaEmbeds: ["![[Bookmarks/X/twitter-1/1.jpg]]"] },
  );
  expect(out).toBe("hello world\n\n![[Bookmarks/X/twitter-1/1.jpg]]");
  ```
- **Multiple embeds join with `\n`**: two embeds →
  `"…\n\n![[…/1.jpg]]\n![[…/2.jpg]]"`.
- **No embeds (undefined / empty) is identical to the no-arg render**:
  `renderTweetBody(t)` deep-equals `renderTweetBody(t, { mediaEmbeds: [] })`
  and `renderTweetBody(t, {})`.
- **Media-only tweet (empty text) → embeds are the whole body** (no leading
  blank line): a record whose text render is `""` (e.g. `full_text: ""`) with one
  embed → `expect(out).toBe("![[…/1.jpg]]")`.
- **Article ignores embeds (byte-identical)**: a direct-article record (clone the
  article fixture already in this file or in `article-extract.test.ts`) →
  `renderTweetBody(rec, { mediaEmbeds: ["![[x.jpg]]"] })` equals
  `extractBookmarkText(rec)` (no embed appended). This pins Decision 3.

#### 4b. `note-file-writer` preserve + idempotency

Add a focused test for `rewriteNoteBody`'s preserve behavior. If there is an
existing `note-file-writer` test file, extend it; otherwise add one next to the
`write-paths-characterization` harness using the same fake-vault helper. The
case:

- Seed a fake X note whose body is **`![[Bookmarks/X/twitter-1/1.jpg]]`** (an
  existing inline image, no rendered text — the legacy state) with valid
  frontmatter (`platform: twitter`). Call `rewriteNoteBody(record)` with a record
  whose `rawData.legacy.full_text` has a `@mention`/`#hashtag`.
- **Assert**: the resulting body **still contains** `![[Bookmarks/X/twitter-1/1.jpg]]`
  **and** now also contains the linkified text (`[@…](…)`). This is the core
  "additive, non-destructive" assertion for the 11K notes.
- **Idempotency**: call `rewriteNoteBody(record)` a **second** time on the
  now-rendered note → the file content is **unchanged** (the `vault.modify` mock
  is not called again, or the content equals the first run's). This proves the
  re-extract → re-append → `newContent === existing` no-op holds.

If wiring a full `rewriteNoteBody` fake-vault case is heavy, the equivalent
unit-level proof is acceptable and preferred for speed:
- Test `extractEmbedLines` directly: a body with `![[a/1.jpg]]`, a plain
  paragraph, and a bare `[[wikilink]]` → returns **only** `["![[a/1.jpg]]"]`
  (the `!` gate excludes the bare link).
- Then prove the round-trip is stable:
  `renderTweetBody(rec, { mediaEmbeds: extractEmbedLines(renderTweetBody(rec, { mediaEmbeds: ["![[a/1.jpg]]"] })) })`
  equals the first render — i.e. re-extracting from a once-rendered body and
  re-rendering is a fixed point. Export `extractEmbedLines` for this.

Do at least the `extractEmbedLines` unit test + the fixed-point assertion; do
the full fake-vault `rewriteNoteBody` case if the harness makes it cheap.

#### 4c. `write-paths-characterization.test.ts` — sync embeds real photos, not card.png

- **Photo record** (`twitter:111`): extend the existing test (lines 213-264) to
  assert the **body** contains `![[Bookmarks/X/twitter-111/1.jpg]]`:
  ```ts
  const bodyStart = note.indexOf("\n---\n");
  const body = note.slice(bodyStart + 5);
  expect(body).toContain("![[Bookmarks/X/twitter-111/1.jpg]]");
  ```
  (Cover assertion `cover: "[[Bookmarks/X/twitter-111/1.jpg]]"` stays — note the
  cover is `[[…]]`, the body embed is `![[…]]`.)
- **Text/card record** (`twitter:222`): extend the existing test (lines 266-320)
  to assert the body does **NOT** embed card.png:
  ```ts
  expect(body).not.toContain("![[Bookmarks/X/twitter-222/card.png]]");
  expect(body).not.toContain("card.png]]");
  ```
  (The existing `[@alice](…)` / `[#pasta](…)` / `card.png` cover assertions
  stay.)

**Verify:** `npm test -- tweet-render`, `npm test -- write-paths`, then full
`npm test` → all pass (≥ baseline).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0, no output.
- [ ] `npm test` exits 0 with **≥ the baseline** count recorded at Step 0.
- [ ] `grep -n "mediaEmbeds" packages/core/src/lib/tweet-render.ts` → the option
      type + the `appendMediaEmbeds` call are present; `renderTweetBody`'s 2nd
      param exists.
- [ ] `grep -n "extractEmbedLines" packages/core/src/sync/vault-writer/note-file-writer.ts`
      → the helper exists and is called in `rewriteNoteBody`'s twitter branch.
- [ ] `grep -n "renderTweetBody(record, { mediaEmbeds" packages/core/src/sync/vault-writer/note-file-writer.ts packages/core/src/sync/vault-writer/twitter-record-writer.ts`
      → both write paths pass `mediaEmbeds`.
- [ ] `grep -n "card.png" packages/core/src/sync/vault-writer/twitter-record-writer.ts`
      → `card.png` appears ONLY in the cover-download block (lines ~160), never in
      a `mediaEmbeds.push(...)`.
- [ ] `tweet-render.test.ts` proves: embeds appended, multiple-embed join, empty
      ≡ no-arg, media-only body, **article ignores embeds**.
- [ ] A test proves `extractEmbedLines` excludes a bare `[[wikilink]]` and that
      the render→extract→render round-trip is a **fixed point** (idempotency).
- [ ] The extended `write-paths-characterization.test.ts` asserts the photo
      note's body **contains** `![[…/1.jpg]]` and the card note's body **does
      NOT** contain `card.png]]`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- The cited excerpts don't match the live code (drift) — re-read and report.
- Adding `mediaEmbeds` to `renderTweetBody` breaks any existing `tweet-render` or
  article test (the article path must stay byte-identical — if it regresses, the
  `isDirectArticle` early-return ordering is wrong).
- The idempotency / fixed-point test fails: a second `rewriteNoteBody` run (or
  the render→extract→render round-trip) produces **different** output. This means
  `extractEmbedLines` and the renderer's embed formatting disagree (e.g. trailing
  whitespace, multi-line embeds) — reconcile them so the round-trip is exact
  before proceeding. **Do not ship a non-idempotent backfill.**
- The `write-paths` photo test can't see `![[…/1.jpg]]` in the body — verify the
  `mediaEmbeds.push` runs on a *successful* download (the fake vault's
  `downloadAndSave` must return truthy for the mocked photo) before changing the
  approach.
- A verification fails twice after a reasonable fix.

## Maintenance notes

- **The backfill is now safe to run on all 13,407 X notes.** With this change
  `rewriteNoteBody` preserves whatever media each note already showed inline and
  *adds* the searchable text — the 11,070 notes with an existing `![[…]]` keep
  their image. Re-running is idempotent (proven by the fixed-point test). The
  user can finally run **"Render X tweet bodies"** without data loss.
- **Follow-up (pipeline audit):** once this lands, a natural next step is to
  **auto-run the tweetBody render at sync time for legacy notes** (or fold it
  into the resync pass) so the body stays current without a manual backfill —
  the initial-sync path (Part 3) already renders+embeds for *new* tweets; the gap
  is only legacy notes synced before 031. Track as a separate plan.
- **Why preserve instead of re-derive on the backfill path:** the writer has no
  `fs` access and `extractTwitterMedia` would re-derive *current-era* names
  (`1.jpg`), missing the **legacy `media.jpg`** files that 11K old notes actually
  embed. Reading the existing body is the only naming-era-agnostic source. If a
  future cleanup renames legacy media on disk, re-running the backfill will carry
  whatever the note then references — still correct.
- **`card.png` exclusion is deliberate and load-bearing.** If a future change
  starts embedding it, text tweets would show their own text twice (once as
  searchable markdown, once as a picture). The grep in Done-criteria guards this.
- Reviewer focus in the PR: (1) the `renderTweetBody` article early-return is
  *before* `appendMediaEmbeds` (articles untouched); (2) `extractEmbedLines` only
  matches `!`-prefixed embeds, not bare `[[links]]`; (3) the idempotency
  fixed-point test actually runs; (4) `card.png` is never pushed to
  `mediaEmbeds`; (5) the cover frontmatter (`[[…]]`) vs body embed (`![[…]]`)
  distinction is preserved.
