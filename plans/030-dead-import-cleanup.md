# Plan 030: Remove the 70 dead imports/locals ESLint surfaced (no-unused-vars → ~0)

## Status

- **Priority**: P2
- **Effort**: M (mechanical, but ~70 sites across many files)
- **Category**: tech-debt / dx
- **Status**: TODO
- **Finding**: DX-01 follow-up (the warnings the 027 ESLint harness exposed)
- **Written against commit**: `8c64c55` (current `main`, includes the 027 ESLint config)
- **Depends on**: 027 (ESLint) — MERGED ✅

## Why this matters

The newly-added ESLint config (plan 027) reports **70 `@typescript-eslint/no-unused-vars`
warnings** — genuine dead imports and unused locals that `tsc` never flags (no
`noUnusedLocals` in tsconfig). This is the exact class of cruft that accumulated invisibly
through the recent refactors. Clearing it to ~zero is valuable on its own (less dead code)
**and** makes the linter actionable going forward: with a 70-warning baseline, a *new* dead
import is lost in the noise; at ~0, it stands out immediately.

This is a tightly-scoped mechanical cleanup: **remove dead bindings only.** No logic changes,
no config changes, no fixing of other warning classes.

## Scope

**In scope:**
- Any `.ts`/`.tsx` source file that has a `@typescript-eslint/no-unused-vars` warning —
  remove the dead import specifier or unused local.
- Removing **stale `eslint-disable` directives** (the ~22 "Unused eslint-disable directive"
  warnings) is also in scope and safe (they're already no-ops). Do these too if
  straightforward.

**Explicitly OUT of scope — do NOT touch:**
- `eslint.config.mjs`, `package.json`, `tsconfig.json`, CI config.
- Any OTHER warning class (`no-require-imports`, `react-hooks/exhaustive-deps`,
  `prefer-const`, `ban-ts-comment`, etc.) — leave every one of them alone.
- Any behavioral/logic change. You are only deleting provably-dead bindings.
- Test files' assertions/structure (you may remove a dead import in a test file, but never
  change what a test checks).

## Environment / isolation

The orchestrator hands you a worktree based at `8c64c55` with **no** `node_modules` symlink.
ESLint is now a real devDependency, so run a real `npm install` first (Step 1). Prefix every
command with `cd "<worktree>" && `.

## Steps

### Step 1 — Install & capture the dead-binding list

```
npm install                       # real install; eslint is a devDep now
npx eslint . -f json > /tmp/lint-030.json 2>/dev/null || true
node -e "const r=require('/tmp/lint-030.json');const hits=[];for(const f of r)for(const m of f.messages){if(m.ruleId==='@typescript-eslint/no-unused-vars')hits.push(f.filePath.replace(process.cwd()+'/','')+':'+m.line+':'+m.column+'  '+m.message)}console.log(hits.length+' no-unused-vars');console.log(hits.join('\n'))"
```

Record the count (expected ~70) and the list. Also capture the baseline gates:
```
npm run typecheck                 # exit 0
npm test                          # 1066 passed / 8 skipped
```

### Step 2 — Remove each dead binding

Work file by file. For each `no-unused-vars` hit:
1. Open the file at the cited line. Confirm the binding (imported name or local `const`/`let`)
   is genuinely unused: grep the **whole file** for the identifier — if it appears only at its
   import/declaration site, it's dead.
2. Remove it:
   - Dead **named import** in a `{ a, b, c }` list → drop just that specifier; if it was the
     only one, remove the whole `import` line. NEVER remove a bare side-effect import
     (`import "./x.css"`) — those are not flagged by this rule anyway.
   - Dead **default/namespace import** → remove the import line.
   - Dead **local `const`/`let`** → remove the declaration (and ONLY if its initializer has no
     side effects; if the RHS is a function call that could have side effects, leave it and
     note it instead of guessing).
3. Do NOT rename things, do NOT reorder imports, do NOT touch adjacent live code.

For the stale `eslint-disable` directive warnings: remove the now-pointless
`// eslint-disable-next-line ...` / `/* eslint-disable ... */` comment lines.

### Step 3 — Re-verify (the safety net that proves no live code was removed)

```
npx eslint . -f json > /tmp/lint-030b.json 2>/dev/null || true
node -e "const r=require('/tmp/lint-030b.json');let n=0;for(const f of r)for(const m of f.messages)if(m.ruleId==='@typescript-eslint/no-unused-vars')n++;console.log('remaining no-unused-vars:',n)"   # expect 0 (or a small, listed residue you justify)
npm run typecheck                 # MUST be exit 0 — if not, you removed something live; restore it
npm test                          # MUST be 1066 passed / 8 skipped — unchanged
npm run lint                      # exit 0; total warnings should drop by ~70 (+ any disable-directives removed)
```

If `typecheck` or the test count regresses, you removed a binding that WAS used (commonly a
type-only import used in an annotation, or a JSX component). **Restore that specific binding**,
exclude it from removal, and note it in your report. Iterate until both gates are green AND
`no-unused-vars` is 0 (or a tiny, explicitly-justified residue).

## STOP conditions

- The `no-unused-vars` count is wildly different from ~70 (e.g. <40 or >100) → report the
  actual list before mass-editing; the baseline may have shifted.
- A removal can't be made without dropping to <1066 tests or non-zero typecheck even after
  restoring → STOP and report that file; do not force it.
- You find yourself wanting to change any non-import/non-dead-local code to satisfy the rule →
  STOP; that's out of scope.

## Done criteria (machine-checkable)

- `npx eslint . -f json` → **0** `@typescript-eslint/no-unused-vars` messages (or a small
  residue you list and justify, each with why it can't be removed).
- `npm run typecheck` exit 0.
- `npm test` = 1066 passed / 8 skipped (unchanged — proves no live code removed).
- `git diff --name-only` shows only `.ts`/`.tsx` files (no config/package/test-logic changes).
- `npm run lint` total warnings dropped by ≈70 (plus any removed stale disable-directives).

## Test plan

No new tests — the existing suite + typecheck passing unchanged IS the regression proof that
only dead code was removed. (That's the whole point of doing this after the char-test net and
ESLint are in place.)

## Commit

`refactor: remove dead imports/locals flagged by eslint no-unused-vars`
Use `git add` on the specific changed source files (or `git add -u` to stage only tracked
modifications) — **never `git add -A`** (avoid staging `node_modules`). End with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Maintenance / follow-up

- Once this lands, a future plan could graduate `no-unused-vars` from `warn` to `error` in
  `eslint.config.mjs` (and/or wire `npm run lint` into CI) since the baseline is now clean.
- The remaining warning classes (`no-require-imports`, `exhaustive-deps`, etc.) are left as a
  separate, lower-priority follow-up — `exhaustive-deps` in particular needs per-hook judgment,
  not a mechanical pass.
