# Plan 003: Stop logging X session cookies to the DevTools console

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 719d54a..HEAD -- packages/core/src/plugin/export-x-cookies.ts`
> If the file changed since this plan was written, compare the "Current
> state" excerpt against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `719d54a`, 2026-06-10

## Why this matters

The "Export X cookies" command (a developer helper for live e2e tests) copies
the user's X/Twitter session cookies — including `auth_token` and `ct0`, which
are full account credentials — to the clipboard. When the clipboard write
fails, the fallback at `export-x-cookies.ts:78` dumps the complete cookie JSON
to `console.log`. Console output persists in the DevTools console history and
shows up in screenshots, screen shares, and any captured logs. Session cookies
in the console are credentials at rest in the wrong place. The file itself
already warns "Cookies are session credentials — do NOT commit that file";
the same standard should apply to the console.

## Current state

- `packages/core/src/plugin/export-x-cookies.ts` — 89-line command handler.
  Reads cookies from the X webview's Electron session, maps them to an export
  shape, writes JSON to the clipboard.
- The file already contains a precedent for a manual fallback path: when
  `@electron/remote` is unavailable it shows a Notice directing the user to
  DevTools → Application → Cookies (lines 23-25).

Excerpt as of `719d54a`:

```ts
// export-x-cookies.ts:73-88
  const json = JSON.stringify(exportCookies, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch (e) {
    new Notice(`Clipboard write failed (${String(e)}). Cookie JSON logged to console — copy from there.`);
    console.log("[roost export-x-cookies]", json);   // <-- credentials to console
    return;
  }

  new Notice(
    `X cookies copied to clipboard (${exportCookies.length} cookies).\n\n` +
      `Paste into  tests/e2e/.x-cookies.json  in the project repo to enable live tests.\n\n` +
      `SECURITY: Cookies are session credentials — do NOT commit that file. It is in .gitignore.`,
    12000,
  );
```

There is exactly one `console.log` of the payload; verify with:
`grep -rn "export-x-cookies" packages/core/src --include='*.ts'`

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npm run typecheck`      | exit 0, no output   |
| All tests | `npm test`               | 929+ tests pass     |

## Scope

**In scope** (the only files you should modify):
- `packages/core/src/plugin/export-x-cookies.ts`

**Out of scope** (do NOT touch):
- The clipboard happy path and its Notice text — unchanged.
- `webview-manager.ts`, command registration, e2e test files.
- Building a modal UI for the fallback — explicitly deferred (see
  Maintenance notes).

## Git workflow

- Branch: `advisor/003-no-cookie-console-logging`
- Commit style: `fix(security): never log X session cookies to the console`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the console fallback with manual-export instructions

In the `catch` block at lines 76-80, delete the `console.log` of `json` and
replace the Notice so the user gets the same manual path the file already
uses for the missing-`@electron/remote` case. Target shape:

```ts
  } catch (e) {
    new Notice(
      `Clipboard write failed (${String(e)}).\n\n` +
        `Cookies were NOT logged anywhere. Manual export: open DevTools ` +
        `(Ctrl+Shift+I) → Application → Cookies → x.com and copy auth_token ` +
        `and ct0 into tests/e2e/.x-cookies.json yourself.`,
      12000,
    );
    return;
  }
```

It is acceptable to log a count (`console.log("[roost export-x-cookies] clipboard write failed; N cookies not exported")`) — never names or
values.

**Verify**: `grep -n "console.log" packages/core/src/plugin/export-x-cookies.ts` → no line prints `json`, cookie names, or cookie values

### Step 2: Typecheck and test

**Verify**: `npm run typecheck` → exit 0; `npm test` → all pass (this file has
no unit tests; the suite guards against accidental import breakage)

## Test plan

No new unit tests: the function is a thin Electron-glue command with no
existing test file, and the change is a deletion of a logging statement plus
Notice text. The done criteria below are grep-based and sufficient.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0
- [ ] `grep -n 'console.log("\[roost export-x-cookies\]", json)' packages/core/src/plugin/export-x-cookies.ts` returns no matches
- [ ] No occurrence of `json`, `exportCookies`, or any cookie field inside a
      `console.*` call in that file (manual read of the diff)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpt doesn't match the live code (drift).
- You find OTHER sites that log cookie/auth material
  (`grep -rni "auth_token\|cookies" packages/core/src --include='*.ts' | grep -i "console\|log("`)
  — report them; do not expand scope.

## Maintenance notes

- Deferred alternative: a Modal with a selectable textarea (pattern:
  `packages/core/src/ui/components/debug-bootstrap-modal.ts:92-133`) would
  preserve one-click export when the clipboard fails. Not done now because it
  requires threading an `App` reference into `exportXCookies()` and the
  clipboard failure path is rare for a dev-only command.
- Reviewer focus: confirm the Notice text doesn't itself interpolate cookie
  values (only the error `e` and static instructions).
- Anything new touching `webContents.session.cookies` should get the same
  "never log values" review standard.
