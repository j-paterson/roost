# Plan 001: Create CLAUDE.md so coding agents can work in this repo without reverse-engineering it

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 719d54a..HEAD -- CLAUDE.md package.json`
> If `CLAUDE.md` already exists or `package.json` scripts changed since this
> plan was written, compare the facts below against the live repo before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `719d54a`, 2026-06-10
- **Execution status**: **DONE (2026-06-10)** — resolved via option 1: a
  local-only, untracked `CLAUDE.md` was placed in the working tree (gitignored
  at `.gitignore:12`, so it stays local and is never committed). Content
  verified byte-identical to the block below. The "Blocker" section is kept for
  the record.

## Blocker — `CLAUDE.md` is gitignored by repo policy (needs a user decision)

The original plan told the executor to **commit** `CLAUDE.md`. That conflicts
with this repo's explicit policy: `.gitignore` lists `CLAUDE.md` (alongside
`AGENTS.md`, `REVIEW.md`, `docs/`) under the comment *"Internal docs — NOT
shipped… kept locally (planning, agent instructions) but never tracked."* So
`git add CLAUDE.md` fails without `-f`, and the executor correctly STOPPED.

This is a genuine scope decision the maintainer must make — pick one:

1. **Local-only, untracked (recommended, honors current policy).** Place the
   `CLAUDE.md` content (below) in the working tree as an untracked file. Claude
   Code auto-loads `CLAUDE.md` from the working dir whether tracked or not, so
   agents in the main tree get it; it simply never gets committed/shipped. No
   plan re-execution needed — it's a one-file drop-in. (Note: it will NOT
   appear in fresh `execute` worktrees, which contain only committed files.)
2. **Track it.** Remove `CLAUDE.md` from `.gitignore` and commit it. This
   reverses a deliberate policy ("never tracked") — only do this if you've
   changed your mind about shipping agent docs.
3. **Skip.** Decide the existing `ARCHITECTURE.md` is enough and drop this plan
   (mark REJECTED).

The advisor will not force-add against policy or edit `.gitignore` without your
say-so. The full, verified content is preserved verbatim below so whichever
option you pick is a copy-paste.

## Ready-to-use content (verified accurate against the repo at `719d54a`)

```markdown
# Roost — agent / contributor quick-start

> See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for design depth and
> [`README.md`](./README.md) for user-facing install docs.

## What this is

Roost is an **Obsidian desktop-only** plugin (TypeScript + React 19, built with
Vite) that syncs TikTok/X bookmarks into the vault via in-app webview
automation, then categorises them with local AI (Ollama).

Single workspace package: `packages/core` (~333 TS files).

## Commands

| Purpose | Command | Expected |
|---|---|---|
| Install | `npm ci` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0, no output |
| Unit tests | `npm test` | 929+ tests pass, ~6 s |
| Build | `npm run build` | `dist/main.js` + `dist/styles.css` |
| Deploy to vault | `ROOST_DEV_VAULT=/path/to/vault npm run install:vault` | build + copy into vault |
| E2E tests | `npm run test:e2e` | **SLOW** — downloads Obsidian; only run when a plan explicitly says to |

`npm run typecheck` runs `tsc --noEmit -p tsconfig.json`.

## Layout

\`\`\`
packages/core/src/
  sync/          TikTok/X webview automation + vault writing
                 (vault-writer.ts is the 1300-line core write path)
  pipeline/      Per-content-type enrichment (media, places, recipe, …)
                 + memory/ (agent-memory knowledge graph)
  ui/            React hub + Smart Assign (ui/lib/smart-assign/)
  views/         Obsidian views: gallery, feed, map, cards
  lib/           Shared utils: frontmatter, extraction, geonames
  plugin/        Command registration, settings glue
  integrations/  Ollama / sidecar / ffmpeg detection
\`\`\`

## Testing conventions

- **Unit tests** are colocated in `__tests__/` dirs; run by Vitest with
  `happy-dom`.
- The `obsidian` package is aliased to the stub at
  `packages/core/src/__mocks__/obsidian.ts` (see `vitest.config.ts:31-36`).
  The stub exposes test hooks like `__setRequestUrlImpl()`.
- `tests/` (plural, repo root) = real test infra: `tests/e2e/` WebdriverIO
  specs, `tests/fixtures/` fixture-vault builder.
- `test/` (singular, repo root) = **one-off experiment scratchpad** (cluster
  analysis scripts, benchmark JSON). NOT the test suite. Never add to it.

## Conventions

- TypeScript with `strictNullChecks` + `noImplicitAny` (NOT full `strict`).
  No ESLint config — match surrounding style by hand.
- Commit style: conventional-commit-ish, e.g. `feat(hub): …`, `build: …`,
  `fix(sync): …`.
- Imports use the `@/` alias → `packages/core/src/` (tsconfig `paths`).
- Frontmatter writing goes through `buildFrontmatter` / `updateNoteFrontmatter`
  in `packages/core/src/lib/vault-helpers.ts` — never hand-build YAML.

## Footguns

- **Desktop-only**: Node `fs`/`child_process` are used directly. Never add
  mobile-compat shims.
- **`.probe` files** are raw-text imports handled by a custom Vite plugin
  (`vite.config.ts` `rawProbePlugin`); the mirror entry lives in
  `vitest.config.ts`. Match that pattern for any new `.probe` file.
- **`dist/` staging**: `npm run e2e:stage` copies `dist/main.js` to the repo
  root for WebdriverIO. Do not commit `main.js` / `styles.css` at the root.
- **Auth sensitivity**: the webview sync automates the user's own logged-in
  TikTok/X session. Treat anything touching cookies or auth headers as
  security-sensitive.
```

## Why this matters

This repo's improvement plans (this `plans/` directory) are executed by coding
agents with zero prior context. There is no `CLAUDE.md` or `AGENTS.md`; the
README is user-facing install docs and `ARCHITECTURE.md` is a 45KB deep
reference. Every agent currently has to rediscover the build commands, the
two-different-test-directories trap, and the Obsidian-mock conventions from
scratch. A one-page `CLAUDE.md` is the cheapest way to raise the success rate
of every subsequent plan.

## Current state

- No `CLAUDE.md` or `AGENTS.md` exists at the repo root (verified 2026-06-10).
- `README.md` — user-facing: what Roost does, network use, install.
- `ARCHITECTURE.md` — 651-line design reference (3-layer architecture, sync
  internals, Smart Assign pipeline, settings).
- All facts below were verified by running the commands during the audit; do
  not re-derive them, but spot-check any that look stale.

Verified facts to encode (the content of the file you will write):

1. **What this is**: Roost, an Obsidian **desktop-only** plugin (TypeScript +
   React 19, built with Vite 8) that syncs TikTok/X bookmarks into the vault
   via in-app webview automation, then categorizes them with local AI (Ollama).
   Single workspace package: `packages/core` (~333 TS files).
2. **Commands** (all verified green at commit `719d54a`):
   - `npm ci` — install (lockfile committed)
   - `npm run typecheck` — `tsc --noEmit -p tsconfig.json`, exits 0
   - `npm test` — `vitest run`, 102 files / 929 tests, ~6s
   - `npm run build` — `vite build` → `dist/main.js` + `dist/styles.css`
   - `ROOST_DEV_VAULT=/path/to/vault npm run install:vault` — build + deploy
     into a real vault for manual testing
   - `npm run test:e2e` — WebdriverIO against a real Obsidian instance;
     SLOW, downloads Obsidian; do not run unless a plan explicitly says to
3. **Layout** (one line each):
   - `packages/core/src/sync/` — TikTok/X webview automation + vault writing
     (`vault-writer.ts` is the 1300-line core write path)
   - `packages/core/src/pipeline/` — per-content-type enrichment pipelines
     (media, places, recipe, …) + `memory/` (agent-memory knowledge graph)
   - `packages/core/src/ui/` — React hub + Smart Assign (`ui/lib/smart-assign/`)
   - `packages/core/src/views/` — Obsidian views (gallery, feed, map, cards)
   - `packages/core/src/lib/` — shared utils (frontmatter, extraction, geonames)
   - `packages/core/src/plugin/` — command registration, settings glue
   - `packages/core/src/integrations/` — Ollama / sidecar / ffmpeg detection
4. **Testing conventions**:
   - Unit tests are colocated in `__tests__/` dirs, run by vitest with
     `happy-dom`. The `obsidian` package is aliased to the stub at
     `packages/core/src/__mocks__/obsidian.ts` (see `vitest.config.ts:31-36`);
     it exposes test hooks like `__setRequestUrlImpl()`.
   - `tests/` (plural, repo root) = real test infra: `tests/e2e/` WebdriverIO
     specs, `tests/fixtures/` fixture-vault builder.
   - `test/` (singular, repo root) = **one-off experiment scratchpad** (cluster
     analysis scripts, benchmark JSON). NOT the test suite. Never add to it.
5. **Conventions**:
   - TypeScript with `strictNullChecks` + `noImplicitAny` (NOT full strict).
     No ESLint config exists — match surrounding style by hand.
   - Commit style: conventional-commit-ish, e.g. `feat(hub): …`, `build: …`,
     `fix(sync): …` (see `git log --oneline`).
   - Imports use the `@/` alias → `packages/core/src/` (tsconfig `paths`).
   - Frontmatter writing goes through `buildFrontmatter`/`updateNoteFrontmatter`
     in `packages/core/src/lib/vault-helpers.ts` — never hand-build YAML.
6. **Footguns**:
   - Desktop-only: Node `fs`/`child_process` are used directly; never add
     mobile-compat shims.
   - `.probe` files are raw-text imports handled by a custom Vite plugin
     (`vite.config.ts` `rawProbePlugin`); mirror exists in `vitest.config.ts`.
   - `dist/` is committed-adjacent staging for e2e (`npm run e2e:stage` copies
     `dist/main.js` to repo root); don't commit `main.js`/`styles.css` at root.
   - The webview sync automates the user's own logged-in TikTok/X session;
     treat anything touching cookies/auth headers as security-sensitive.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npm run typecheck`      | exit 0, no output   |
| Tests     | `npm test`               | 929+ tests pass     |

## Scope

**In scope** (the only files you should create/modify):
- `CLAUDE.md` (create, repo root)
- `plans/README.md` (status row update only)

**Out of scope** (do NOT touch):
- `README.md`, `ARCHITECTURE.md` — do not restructure or duplicate them;
  CLAUDE.md links to them.
- Any source file.

## Git workflow

- Branch: `advisor/001-claude-md`
- One commit, message: `docs: add CLAUDE.md for agent/contributor onboarding`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write CLAUDE.md

Create `CLAUDE.md` at the repo root containing the facts from "Current state"
above, organized as: **What this is** → **Commands** → **Layout** →
**Testing** → **Conventions** → **Footguns**. Target length: 60–100 lines.
Link to `ARCHITECTURE.md` for design depth and `README.md` for user-facing
docs. Do not invent facts not listed above; if you add anything, it must be
verifiable from the repo.

**Verify**: `test -f CLAUDE.md && wc -l CLAUDE.md` → file exists, 50–120 lines

### Step 2: Confirm the commands you documented actually work

Run each of `npm run typecheck` and `npm test`.

**Verify**: both exit 0 (typecheck silent; tests report ~929 passed)

## Test plan

No code changes — the verification is that every command written into
CLAUDE.md was executed and exited 0 during Step 2.

## Done criteria

- [ ] `CLAUDE.md` exists at repo root and contains the sections listed in Step 1
- [ ] Every command in CLAUDE.md was run and exited 0 (except `test:e2e`,
      which must carry the SLOW warning instead)
- [ ] `npm run typecheck` and `npm test` still exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `CLAUDE.md` already exists (someone created one since this plan was written).
- Any command listed in "Current state" fails or behaves differently than
  documented — report the discrepancy rather than documenting a guess.

## Maintenance notes

- When scripts in `package.json` change, CLAUDE.md's command table must be
  updated in the same PR — reviewers should check for this.
- Plans 002–006 assume the conventions documented here; if CLAUDE.md drifts
  from reality, fix reality's documentation first.
