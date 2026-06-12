# Plan 029 (REVISED): Fix the dead agent-memory doc reference in Settings (D-01)

> **Revised after execution.** The original plan (create `docs/agent-memory-hermes-setup.md`)
> was BLOCKED by a repo policy the plan didn't know about: `docs/` is **deliberately
> gitignored** (`.gitignore:15`; comment at `.gitignore:10-11`: "Internal docs — NOT shipped.
> Public repo ships only README.md + ARCHITECTURE.md"). A `docs/` file can NEVER be tracked
> or reach an end user, so pointing the Settings UI at one is the actual bug. The fix is to
> **correct the Settings copy**, not add a file. The drafted doc content is preserved in the
> Appendix below for the maintainer to place locally (untracked) if a contributor reference
> is wanted.

## Status

- **Priority**: P2
- **Effort**: XS
- **Category**: correctness (broken in-product reference) / docs
- **Status**: TODO (revised)
- **Finding**: D-01
- **Written against commit**: `960199f`

## Why this matters

`packages/core/src/settings.ts:248-249` shows end users (in the plugin Settings UI):

> "…Intended for consumption by a Nous Research Hermes Agent — **see
> docs/agent-memory-hermes-setup.md**. Default off…"

End users have the installed plugin, not the repo — and `docs/` isn't even in the public
repo (it's gitignored, never shipped). The `docs/...` path resolves to nothing for anyone.
Fix: remove the dead path and describe the feature **inline** (actionable: name the files it
generates), keeping the existing Hermes framing accurate. No new files.

## Scope

**In scope (the ONLY file you modify):**
- `packages/core/src/settings.ts` — the one `.setDesc(...)` string at lines 245-251.

**OUT of scope — do NOT touch:** `.gitignore` (do NOT un-ignore `docs/`), any other source,
any doc file, README, ARCHITECTURE.md.

## Environment

Worktree based at `960199f`, `node_modules` symlinked (no dep change — do NOT `npm install`).
Prefix every command with `cd "<worktree>" && `.

## Step 1 — Edit the Settings description

In `packages/core/src/settings.ts`, find the "Enable agent memory" setting's `.setDesc(...)`
(around lines 245-251). It currently reads EXACTLY:

```ts
      .setDesc(
        "When enabled, the weekly digest pipeline writes a domain-interest " +
        "knowledge graph to Memory/ in the vault (topic files + routing " +
        "index + aliases). Intended for consumption by a Nous Research " +
        "Hermes Agent — see docs/agent-memory-hermes-setup.md. Default " +
        "off: existing digest behavior is unchanged when disabled."
      )
```

Replace it with EXACTLY:

```ts
      .setDesc(
        "When enabled, the weekly digest pipeline writes a domain-interest " +
        "knowledge graph to Memory/ in the vault: Memory/MEMORY.md (a routing " +
        "index sized for an agent system prompt), MEMORY-archive.md, and " +
        "per-topic files under Memory/topics/. Intended for consumption by an " +
        "external agentic LLM — e.g. a Nous Research Hermes agent that reads " +
        "Memory/MEMORY.md. Default off: existing digest behavior is unchanged " +
        "when disabled."
      )
```

This drops the dead `docs/agent-memory-hermes-setup.md` path, names the actual generated
files (verified against `pipeline/memory/index-writer.ts`), and keeps the Hermes framing.
Do NOT change the setting name, the toggle, the `memoryEnabled` binding, or anything else.

> If the `.setDesc` text does not match the block above byte-for-byte (drift since `960199f`),
> STOP and report the actual text — do not guess at a replacement.

## Step 2 — Verify

```
grep -n "docs/agent-memory-hermes-setup" packages/core/src/settings.ts   # expect: NO matches (dead ref gone)
git diff --name-only 960199f..HEAD                                        # expect EXACTLY: packages/core/src/settings.ts
npm run typecheck                                                          # exit 0
npm test                                                                   # 1066 passed / 8 skipped
git status --short                                                         # only settings.ts; nothing else staged
```

## Done criteria

- `grep "docs/agent-memory-hermes-setup" packages/core/src/settings.ts` → no matches.
- `git diff --name-only 960199f..HEAD` = exactly `packages/core/src/settings.ts`.
- `npm run typecheck` exit 0; `npm test` = 1066 passed / 8 skipped.

## Commit

`fix(settings): drop dead docs/ reference from agent-memory description`
Use `git add packages/core/src/settings.ts` only (never `git add -A`).
End with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Maintenance / follow-up

- `index-writer.ts:5` and `settings.ts:71` reference a design spec at
  `docs/superpowers/specs/2026-05-18-agent-memory-design.md` — also under gitignored `docs/`.
  Those are CODE COMMENTS (not user-facing), so they're lower priority, but a future tidy
  could relativize or remove them too.

---

## Appendix — drafted reference doc (OPTIONAL, local-only)

The following was drafted as `docs/agent-memory-hermes-setup.md` before we learned `docs/`
is never tracked. It is accurate (grounded in `index-writer.ts`, `settings.ts`,
`plugin/memory-commands.ts`) and the maintainer may drop it into their **local** `docs/`
(untracked) as a contributor reference. It is NOT part of this plan's tracked change and an
executor should NOT create it.

````markdown
# Agent memory (Hermes) — setup & reference

Roost's **agent memory** feature turns your weekly digest into a persistent,
machine-readable **domain-interest knowledge graph** inside your vault, designed so an
external agentic LLM (e.g. a Nous Research Hermes agent you run locally) can read your
long-term interests as routing context.

> **Status.** Roost ships the **writer** side (it generates/maintains the files below).
> The automated Roost↔Hermes **reader** bridge has not shipped; today, feeding an agent
> `Memory/MEMORY.md` is a manual step. The files are plain Markdown/JSON — any agent, or a
> human, can consume them now.

## Enabling it
1. Settings → Roost → Agent memory → **Enable agent memory** (default off).
2. Run a weekly digest (the memory writer runs as its final stage), or rebuild from a past
   week via the commands below.

## What gets written (all under `Memory/`)
- `Memory/MEMORY.md` — Tier-1 index, sized for a ~2,200-char agent system prompt.
  Frontmatter (`roost_memory_index: true`, `generated`, `schema_version`, `concept_count`,
  `active_claim_count`) + a `| Slug | Topic | Updated | Active | Summary |` table.
- `Memory/MEMORY-archive.md` — Tier-2 (older / less-active concepts).
- `Memory/topics/<slug>.md` — one per concept (summary, claims, relations, sources).
- `Memory/aliases.json` — alternative names → concept slugs.
- `Memory/.roost-memory-cache.json` — internal idempotency cache.

A concept is Tier-1 when it has ≥ 3 active claims AND was updated within
`memoryIndexTier1MaxAgeDays` (default 90), capped at `memoryIndexTier1MaxConcepts` (default 20).

## Settings
| Setting | Default | Meaning |
|---|---|---|
| Enable agent memory (`memoryEnabled`) | false | Master on/off. |
| Memory judge model (`memoryJudgeModel`) | "default" | Ollama model for the router + novelty judges; "default" reuses the digest eval model. |
| `memoryConceptMatchThreshold` | 0.75 | At/above → attach to existing concept, no LLM. |
| `memoryConceptCreateThreshold` | 0.55 | At/below → create new concept, no LLM. |
| `memoryClaimRedundantThreshold` | 0.92 | At/above → skip claim as redundant. |
| `memoryClaimRefineThreshold` | 0.75 | At/below → add claim outright. |
| `memoryIndexTier1MaxConcepts` | 20 | Max concepts in `MEMORY.md`. |
| `memoryIndexTier1MaxAgeDays` | 90 | Max age for tier-1. |

## Commands
- **Memory: rebuild MEMORY.md index from concept files** — regenerate the index, no LLM.
- **Memory: rebuild from a specific weekly digest** — re-run the writer for a past week.
- **Memory: print similarity-threshold calibration** — histogram for tuning thresholds.

## Wiring to an agent
Put `Memory/MEMORY.md` into the agent's system prompt; give it read access to
`Memory/topics/` so it can follow a slug for full claims; set the judge model to the
agent's model family for consistency.
````
