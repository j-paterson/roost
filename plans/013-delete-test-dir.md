# Plan 013: Delete the root `test/` experiment junk drawer

> **Retroactive record.** This work was dispatched as an inline executor charter
> (not a pre-written plan file) during the 2026-06-10 orchestration session and is
> already **MERGED into `main`**. This file documents it for the archive.

## Status

- **Priority**: P2
- **Effort**: S
- **Category**: dx / repo hygiene
- **Status**: **DONE — MERGED** (executor commit `7b9ab18`, reviewed APPROVE, merged `--no-ff`)
- **Finding**: DX-03 (audit backlog)

## Why this mattered

The repo root had a `test/` directory (singular) holding 1.8MB of one-off
experiment scripts, benchmark JSON, and cluster-visualization HTML — easily
confused with `tests/` (plural, the real WebdriverIO + vitest suite). It was not
referenced by any build/test config.

## What was done

- Verified nothing depends on root `test/` as an INPUT: the only references were
  output-dir writes and comments in `scripts/benchmark.mjs` and
  `scripts/visualize-clusters.mjs` — harmless.
- `git rm -r test/` — deleted 17 files (~11,600 lines).
- Verified: `npm run typecheck` exit 0; `npm test` 955 passed/8 skipped
  (unchanged — `test/` was never in the vitest include).

## Review outcome

Assigned reviewer APPROVE: scope clean (only `test/` deletions, `tests/`
untouched), no real dependency on `test/`, build/suite unchanged. One cosmetic
note: two dev-script *comments* now reference the deleted paths (pre-existing,
non-blocking).

## Follow-up (not done)

- The two stale comments in `scripts/benchmark.mjs` / `scripts/visualize-clusters.mjs`
  could be cleaned up; cosmetic only.
