# Plan 016: Clear the 6 dev-only npm-audit highs (wdio-obsidian-service + overrides)

> **Retroactive record.** Dispatched as an inline executor charter during the
> 2026-06-10 orchestration session; already **MERGED into `main`**. This file
> documents it for the archive. Supersedes the REJECTED plan 007.

## Status

- **Priority**: P1
- **Effort**: S
- **Category**: dependencies / security (dev-only)
- **Status**: **DONE — MERGED** (executor commit `727d79c`, reviewed APPROVE, merged `--no-ff`)
- **Finding**: DEV-AUDIT (replaces rejected SEC-06/07 → plan 007)

## Why this mattered

Committed `main` showed **6 high-severity npm-audit advisories**, all dev-only
(WebdriverIO e2e tooling, not shipped to users): `wdio-obsidian-service@^3.0.2`
→ `obsidian-launcher` → `lodash` (code injection / prototype pollution),
`basic-ftp` (DoS), `fast-xml-builder`; plus `serialize-javascript` (RCE). Plan
007's "bump @wdio/mocha-framework to v9" was rejected because `main` was already
on v9 and that chain is unrelated.

## Investigation (read-only, isolated sandbox)

A prior investigation agent determined the clean fix in a throwaway scratch dir
(copied `main`'s manifests, experimented with `npm install` / `npm audit` /
`npm view`): bumping `wdio-obsidian-service` alone clears only 2 of 6 (newer
`obsidian-launcher@3.1.1` still pulls `lodash`); clearing all 6 needs the bump
**plus** an `overrides` block. Peer deps are identical across `3.0.2`→`3.1.1`
(no major crossing) — low risk.

## What was done

- `package.json` devDependency: `wdio-obsidian-service` `^3.0.2` → `^3.1.1`.
- Added a top-level `overrides` block (the `serialize-javascript` override is
  nested under `mocha` because a flat global override conflicts with mocha's
  own range):
  ```json
  "overrides": {
    "lodash": "4.18.1",
    "basic-ftp": "6.0.1",
    "fast-xml-builder": "1.2.0",
    "mocha": { "serialize-javascript": "7.0.5" }
  }
  ```
- `npm install` to regenerate the lockfile (no `--legacy-peer-deps` needed; the
  lockfile shrank as vulnerable transitive deps were resolved away).
- Verified: `npm audit` **6 high → 0 high / 0 critical** (5 moderate, 2 low
  remain — no safe non-breaking fix); `npm run typecheck` exit 0; `npm test`
  969 passed/8 skipped. Only `package.json` + `package-lock.json` changed.

## Review outcome

Assigned reviewer APPROVE: scope exactly the two manifest files, `npm audit`
0 high/0 critical confirmed, overrides block matches, typecheck + suite green.

## Maintenance / follow-up

- **Manual e2e verification owed:** `npm run test:e2e:smoke` (downloads Obsidian)
  should be run on a desktop before a release to confirm the `wdio-obsidian-service`
  minor bump + transitive overrides don't disturb the e2e launcher. Not run in CI.
- The remaining 5 moderate / 2 low advisories (`brace-expansion`, `esbuild`/`vite`,
  `ip-address`, `ws`, `diff`) have no safe non-breaking fixes as of this writing.
