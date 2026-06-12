# Plan 014: Remove confirmed-dead exports flagged by knip + add a knip script

> **Retroactive record.** Dispatched as an inline executor charter during the
> 2026-06-10 orchestration session; already **MERGED into `main`**. This file
> documents it for the archive.

## Status

- **Priority**: P2
- **Effort**: S
- **Category**: tech-debt / dx
- **Status**: **DONE — MERGED** (executor commit `dc83d06`, reviewed APPROVE, merged `--no-ff`)
- **Finding**: DX-04 (audit backlog)

## Why this mattered

`knip` flagged ~35–50 unused exports (later 51 confirmed) cluttering the API
surface. Each is a maintenance burden and a false signal about what is public
contract.

## What was done

- Ran `npx knip --include exports`. **Excluded** `packages/core/src/sync/` and
  `packages/core/src/ui/lib/smart-assign/` from this pass (concurrent VaultWriter
  decomposition + the just-merged smart-assign refactor owned those areas).
- For each remaining flagged export, verified it was genuinely dead (grepped the
  whole repo incl. tests/scripts/dynamic refs) before removing. Guarded against
  knip false-positives (test-only/dynamic/re-exported symbols).
- Removed **51 symbols across 31 files**: fully-deleted dead functions
  (e.g. `computeBookmarkFilterIndices`, `setLLMRequestHook`), dropped superfluous
  `export` keywords on internally-used symbols (view registrations, pipeline
  `write*ToBookmark` helpers, feed renderers), and removed dead re-exports
  (`PIPELINE_ENRICHMENT_IDS`, `bookmarksViewOptions`, etc. — real exports remain
  in their canonical modules).
- Added `"knip": "knip"` to `package.json` scripts.
- Verified: `npm run typecheck` exit 0; `npm test` 955 passed/8 skipped;
  `npx knip --include exports` clean (only the excluded `sync/` items remain).

## Review outcome

Assigned reviewer APPROVE with a targeted false-positive audit: spot-checked the
riskiest removals (Obsidian view registrations + re-exports — the dynamic/string
registration risk that static typecheck won't catch) and confirmed each
de-exported symbol still resolves via its canonical module or self-contained
registration, and the fully-deleted functions have zero consumers. No false
positives.

## Follow-up (not done)

- Wire `npm run knip` into CI to prevent new dead exports (deliberately left out
  to keep scope tight — `ci.yml` untouched).
- A future pass can revisit the `sync/` dead exports once the VaultWriter
  decomposition (Phases 3–5) settles.
