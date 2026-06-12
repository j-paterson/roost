# Plan 002: Harden YAML frontmatter encoding against scraped-content injection and corruption

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 719d54a..HEAD -- packages/core/src/lib/vault-helpers.ts packages/core/src/lib/__tests__/vault-helpers.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security / bug
- **Planned at**: commit `719d54a`, 2026-06-10

## Why this matters

Roost writes YAML frontmatter built from **scraped third-party content**:
TikTok hashtags, article titles, sound names, author handles. The encoder in
`packages/core/src/lib/vault-helpers.ts` has two holes:

1. `yamlStr()` detects strings containing `\n` as needing quotes, but then
   only escapes `\` and `"` — a literal newline survives into the quoted
   value. A value containing `\n---\n` truncates the frontmatter block (both
   Obsidian's parser and this repo's own `updateNoteFrontmatter`, which finds
   the end of frontmatter via `content.indexOf("\n---\n", 4)`, will misparse),
   corrupting the note and leaking attacker-/platform-controlled text into
   what the rest of the system treats as frontmatter.
2. Array items (`tags`, hashtags) are emitted **completely unescaped** as
   `  - ${item}`. A hashtag containing `: `, a leading `- `, a `#`, or a
   newline breaks or repoints fields. TikTok hashtags come straight from the
   raw API (`challenges[].title`) with no validation.

A malicious or merely weird post title/hashtag should never be able to break
a vault note's frontmatter. The fix is local to one file and fully unit-testable.

## Current state

- `packages/core/src/lib/vault-helpers.ts` — the only frontmatter encoder.
  All writers go through `buildFrontmatter()` / `updateNoteFrontmatter()`.
- `packages/core/src/lib/__tests__/vault-helpers.test.ts` — existing test file
  (covers `writeNoteSafe` only). Extend it; use its style as the pattern.

Excerpts as of `719d54a`:

```ts
// vault-helpers.ts:13-27
export function buildFrontmatter(fields: Record<string, FrontmatterValue>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length > 0) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);   // <-- unescaped
    } else if (typeof v === "number") {
      lines.push(`${k}: ${v}`);
    } else if (typeof v === "string") {
      lines.push(`${k}: ${yamlStr(v)}`);
    }
  }
  return lines.join("\n");
}
```

```ts
// vault-helpers.ts:64-78
/** Does this string value need YAML quoting? */
function needsQuoting(s: string): boolean {
  return s.includes('"') || s.includes(":") || s.includes("#") || s.includes("\n")
    || s.startsWith("[") || s.startsWith("{") || s.startsWith("@");
}

/** YAML-escape a string value for frontmatter. Only quotes when necessary. */
function yamlStr(val: string | number | null | undefined): string {
  if (val == null) return '""';
  const s = String(val);
  if (needsQuoting(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;   // <-- \n not escaped
  }
  return s;
}
```

```ts
// vault-helpers.ts:111-115 (inside updateNoteFrontmatter)
    const formatted = typeof value === "number"
      ? `${key}: ${value}`
      : Array.isArray(value)
        ? `${key}:\n${value.map(v => `  - ${v}`).join("\n")}`   // <-- unescaped
        : `${key}: ${yamlStr(value)}`;
```

Where hostile values come from (context only — files NOT in scope):

- `packages/core/src/lib/extract.ts:345` — `const hashtags = (raw?.challenges || []).map((c: RawApiData) => c.title).filter(Boolean);` (raw TikTok API, unvalidated)
- `packages/core/src/sync/vault-writer.ts:684-704` — tiktok note frontmatter:
  `tags` array containing those hashtags, `sound: "${title} — ${author}"`, etc.
- `packages/core/src/sync/vault-writer.ts:468-469` — raw article title becomes
  `fmFields.title`.

Repo conventions: TypeScript with `strictNullChecks`; tests are vitest in the
colocated `__tests__/` dir; no ESLint — match surrounding style.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Install   | `npm ci`                 | exit 0              |
| Typecheck | `npm run typecheck`      | exit 0, no output   |
| All tests | `npm test`               | 929+ tests pass (baseline: 102 files / 929 passed at `719d54a`) |
| This file's tests | `npx vitest run packages/core/src/lib/__tests__/vault-helpers.test.ts` | all pass |

## Scope

**In scope** (the only files you should modify):
- `packages/core/src/lib/vault-helpers.ts`
- `packages/core/src/lib/__tests__/vault-helpers.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- `packages/core/src/lib/extract.ts` — do not "sanitize at the source";
  encoding belongs in the encoder so every caller is covered.
- `packages/core/src/sync/vault-writer.ts` — callers need no change; the fix
  is transparent to them.
- `parseFrontmatterEntries` / `writeNoteSafe` in vault-helpers.ts — unrelated.
- Any switch to a YAML library dependency — out of scope; keep the hand-rolled
  encoder, just make it correct.

## Git workflow

- Branch: `advisor/002-yaml-frontmatter-hardening`
- Commit style: `fix(lib): escape newlines and array items in YAML frontmatter encoding`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Escape control characters in `yamlStr` and broaden `needsQuoting`

In `vault-helpers.ts`:

1. In `yamlStr`'s quoting branch, escape (in this order): backslash, double
   quote, then newline → `\\n`, carriage return → `\\r`, tab → `\\t`. These
   are all valid YAML double-quoted escapes, and they guarantee the emitted
   value occupies exactly one line.
2. Extend `needsQuoting` so it also returns true when the string:
   - starts with any of: `-` `?` `>` `|` `&` `*` `!` `%` `'` `` ` `` or a
     space, or ends with a space (YAML indicators / trim hazards), or
   - contains `\r` or `\t`, or
   - is empty.

Target shape:

```ts
function needsQuoting(s: string): boolean {
  return s.length === 0
    || s.includes('"') || s.includes(":") || s.includes("#")
    || s.includes("\n") || s.includes("\r") || s.includes("\t")
    || /^[-?>|&*!%'`@\[{ ]/.test(s) || s.endsWith(" ");
}

function yamlStr(val: string | number | null | undefined): string {
  if (val == null) return '""';
  const s = String(val);
  if (needsQuoting(s)) {
    return `"${s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")}"`;
  }
  return s;
}
```

(Note: `startsWith("[")`, `startsWith("{")`, `startsWith("@")` from the old
code are folded into the regex character class.)

**Verify**: `npm run typecheck` → exit 0

### Step 2: Route array items through `yamlStr`

- `buildFrontmatter` line ~19: `for (const item of v) lines.push(`  - ${yamlStr(String(item))}`);`
- `updateNoteFrontmatter` array branch line ~114: `${key}:\n${value.map(v => `  - ${yamlStr(String(v))}`).join("\n")}`

**Verify**: `npm run typecheck` → exit 0

### Step 3: Add tests

Extend `packages/core/src/lib/__tests__/vault-helpers.test.ts` with new
`describe("buildFrontmatter")` and `describe("updateNoteFrontmatter")` blocks
(import both from `@/lib/vault-helpers`; they are already exported). Cases —
for every case, assert the structural invariant **plus** the specific output:

- Structural invariant (write a small local helper): every line of the
  returned block matches `/^[\w-]+:/` (a key line) or `/^  - /` (an array
  item) — i.e. no value ever produces a stray line.
- Title containing a literal newline + `---`:
  `buildFrontmatter({ title: "a\n---\nb" })` → single line
  `title: "a\\n---\\nb"` (the literal two-char sequences `\n` in the output,
  not real newlines).
- Hashtag with a colon: `{ tags: ["foo: bar"] }` → `  - "foo: bar"`.
- Hashtag starting with `- `: `{ tags: ["- item"] }` → `  - "- item"`.
- Hashtag with `#`: `{ tags: ["#fyp"] }` → `  - "#fyp"`.
- Plain values stay unquoted: `{ title: "hello world", tags: ["cooking"] }`
  → `title: hello world` and `  - cooking` (regression guard against
  over-quoting).
- Quote/backslash round-trip: `{ title: 'say "hi" \\ bye' }` → quoted with
  `\"` and `\\\\` escapes.
- `updateNoteFrontmatter`: start from a content string
  `---\ntitle: old\n---\nbody`, update with
  `{ tags: ["a: b"], title: "x\ny" }`, assert the result still has exactly
  one `\n---\n` separator and the body is unchanged.

**Verify**: `npx vitest run packages/core/src/lib/__tests__/vault-helpers.test.ts` → all pass (5 existing + ~8 new)

### Step 4: Full suite

Some existing tests may assert exact frontmatter output that now gains quotes
(legitimately — e.g. a fixture hashtag containing `#`). For each failure,
inspect: if the new output is correctly-quoted YAML for a value that genuinely
needs it, update the expectation; if a value that needs no quoting became
quoted, your `needsQuoting` is too broad — fix the code, not the test.

**Verify**: `npm test` → all pass (929+; a handful of updated expectations are
acceptable, each justified in the commit message)

## Test plan

Covered by Steps 3–4. Pattern: the existing `describe("writeNoteSafe")` style
in the same file (plain vitest, no Obsidian APIs needed — these are pure
string functions).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; new tests for newline/colon/dash/hash injection exist and pass
- [ ] `grep -n 'lines.push(`  - ${item}`)' packages/core/src/lib/vault-helpers.ts` returns no matches
- [ ] `grep -c 'yamlStr' packages/core/src/lib/vault-helpers.ts` ≥ 4 (both array sites now call it)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- More than ~10 existing tests fail after Step 2 — that suggests the repo
  relies on unquoted output more broadly than the audit found; report the
  failure list instead of mass-editing expectations.
- You find a caller that *parses* the emitted frontmatter with logic that
  breaks on quoted values (search hint: `parseFrontmatterEntries` consumers) —
  report it; do not patch the parser in this plan.

## Maintenance notes

- Any future frontmatter field must go through `buildFrontmatter`/
  `updateNoteFrontmatter` — reviewers should reject hand-built `key: value`
  string concatenation elsewhere.
- Explicitly deferred: switching to a real YAML library; sanitizing hashtags
  at extraction time (cosmetic, e.g. stripping `#`); both were judged not
  worth the dependency/blast-radius right now.
- Reviewer focus: the `needsQuoting` regex — too narrow re-opens the hole,
  too broad churns every existing note's frontmatter on next resync.
