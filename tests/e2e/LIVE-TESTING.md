# Live E2E Testing Against Real x.com

## What are live tests?

Live tests (files matching `*.live.spec.ts`) run the full article backfill
pipeline against **real x.com** using your actual X session. They differ from
the regular e2e suite in three ways:

1. They require real X session cookies (injected into the Electron webview)
2. They make real network requests to x.com's GraphQL API
3. They **modify real notes** in your vault — there is no cleanup

Live tests are excluded from the default `npx wdio run` invocation. You must
run them explicitly with `--spec`.

---

## One-time setup: export your X cookies

The Roost plugin includes a command that reads the live X session cookies from
the authenticated webview and copies them to your clipboard.

### Steps

1. Open your **production Obsidian** (the one logged in to x.com).
2. Make sure the X webview is active: open it via the sidebar or
   `Cmd+P → Sync X/Twitter` and wait for x.com to fully load.
3. Open the command palette (`Cmd+P`) and run:
   **"Export X session cookies (for live e2e tests)"**
4. The command copies a JSON array to your clipboard and shows a notice.
5. In the Roost project repo, create the file:
   ```
   tests/e2e/.x-cookies.json
   ```
   and paste the clipboard contents into it.

The file will look like:

```json
[
  { "url": "https://x.com", "name": "auth_token", "value": "...", "domain": ".x.com", ... },
  { "url": "https://x.com", "name": "ct0", "value": "...", "domain": ".x.com", ... },
  ...
]
```

> **Tip:** If the command reports it cannot load `@electron/remote`, open
> DevTools (`Ctrl+Shift+I` / `Cmd+Option+I`) → Application → Cookies →
> `https://x.com`, and manually copy `auth_token` and `ct0` values. Then
> construct the JSON manually using the schema above.

---

## Running the live spec

```bash
# Set vault path to whatever you want the test to operate on.
# Using your real bookmarks vault lets the test find real articles.
export E2E_LIVE_VAULT=/Users/you/Library/CloudStorage/.../ObsidianBookmarks

npx wdio run tests/e2e/wdio.conf.mts \
  --spec tests/e2e/86-x-article-real-backfill.live.spec.ts
```

The spec will:

1. Skip gracefully if `.x-cookies.json` is missing (with instructions)
2. Skip gracefully if `E2E_LIVE_VAULT` is not set
3. Reload Obsidian pointing at the live vault
4. Inject the cookies into the X webview's Electron session
5. Navigate to `x.com/i/bookmarks` and verify the session is authenticated
6. Trigger a Twitter sync to capture the Bookmarks API replay headers
7. Run the `backfill-x-articles` command
8. Assert that at least one article body was fetched and written into a note

---

## Security warning

**The `.x-cookies.json` file contains your X session credentials.**

- It is listed in `.gitignore` and must **never be committed** to the repo
- Anyone with this file can act as you on x.com until the session expires
- Sessions typically expire after several months to one year
- Delete or rotate the file after each testing session if you are concerned
- Re-export cookies whenever the session expires or the test starts returning
  "login prompt" failures

---

## Refreshing cookies

If the live test fails with an auth error (body contains "sign in to X"), your
cookies have expired. Repeat the export steps above to get fresh ones.

---

## Available live specs

| File | What it tests |
|------|--------------|
| `86-x-article-real-backfill.live.spec.ts` | Full article backfill pipeline against real x.com, cookie injection, note body write |
