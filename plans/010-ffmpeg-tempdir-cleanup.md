# Plan 010: Always clean up the ffmpeg frame temp directory

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1671710..HEAD -- packages/core/src/pipeline/describe-items.ts`
> If it changed since this plan was written, compare the excerpts below against
> the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (changes a single internal helper's return shape and its one
  caller; pure cleanup, no behavior change to embeddings)
- **Depends on**: none
- **Category**: security / resource hygiene
- **Planned at**: commit `1671710`, 2026-06-10

## Why this matters

Video-frame vision extraction creates a fresh temp directory per video via
`fs.mkdtempSync(... "roost-frames-")` but **never removes the directory**. The
caller deletes the individual frame files only on the success path; if the
Ollama vision call throws first, even the frames leak — and the `roost-frames-*`
directory itself always leaks. Over a large media backfill this accumulates many
orphaned temp dirs in `os.tmpdir()`. The fix is to return the temp dir to the
caller and remove it in a `finally`, guaranteeing cleanup on both success and
failure.

## Current state

```ts
// packages/core/src/pipeline/describe-items.ts:294-312 (the helper)
function extractKeyframes(ffmpeg: string, mp4Path: string, duration: number): string[] {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-frames-"));   // <-- never removed
  const framePaths: string[] = [];
  for (const [i, pos] of [0.25, 0.5, 0.75].entries()) {
    const time = (duration * pos).toFixed(2);
    const framePath = path.join(tmpDir, `frame_${i}.jpg`);
    try {
      execFileSync(ffmpeg, ["-ss", time, "-i", mp4Path, "-frames:v", "1", "-q:v", "2", "-y", "-loglevel", "error", framePath], { timeout: 15000 });
      if (fs.existsSync(framePath) && fs.statSync(framePath).size > 100) framePaths.push(framePath);
    } catch {}
  }
  return framePaths;
}
```

```ts
// describe-items.ts:174-204 (the ONLY caller, inside embedItem)
    if (item.mp4Path && ff.ffmpeg && ff.ffprobe) {
      try {
        const duration = getVideoDuration(ff.ffprobe, item.mp4Path);
        if (duration && duration >= 1) {
          const framePaths = extractKeyframes(ff.ffmpeg, item.mp4Path, duration);
          if (framePaths.length > 0) {
            const images = framePaths.map(fp => { const data = fs.readFileSync(fp); return data.toString("base64"); });
            const res = await requestUrl({ /* ...ollama vision call... */ });
            entry.vision = (res.json?.response || "").trim().slice(0, 800) || null;
            // Clean up temp frames
            for (const fp of framePaths) try { fs.unlinkSync(fp); } catch {}   // <-- only frames, only on success
          }
        }
      } catch {
        // Multi-frame failed — fall through to cover image
      }
    }
```

Facts:
- `extractKeyframes` is called from exactly one place (line 179). Verify before
  editing: `grep -n "extractKeyframes" packages/core/src/pipeline/describe-items.ts`
  should show the definition (~294) and a single call (~179).
- `fs`, `path`, `os` are already imported at the top of the file.
- The helper's loop already swallows per-frame errors, so once `tmpDir` is
  created the function returns normally — the only place that can throw after
  `tmpDir` exists is the caller (the Ollama call / readFileSync).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| All tests | `npm test` | 953+ pass (baseline at `1671710`) |

## Scope

**In scope** (the only file you should modify):
- `packages/core/src/pipeline/describe-items.ts`

**Out of scope** (do NOT touch):
- The single-cover-image fallback path below the multi-frame block — unrelated.
- `getVideoDuration`, the Ollama request body, the embedding logic — unchanged.
- Any other file.

## Git workflow

- Branch: `advisor/010-ffmpeg-tempdir-cleanup`
- Commit style: `fix(pipeline): remove ffmpeg frame temp dir after vision extraction`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Return the temp dir from extractKeyframes

Change the helper's signature and return so the caller can clean up the
directory (not just the frames):

```ts
function extractKeyframes(ffmpeg: string, mp4Path: string, duration: number): { tmpDir: string; framePaths: string[] } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roost-frames-"));
  const framePaths: string[] = [];
  // ... loop unchanged ...
  return { tmpDir, framePaths };
}
```

**Verify**: `npm run typecheck` → will fail at the call site until Step 2; that's expected

### Step 2: Use try/finally at the call site to guarantee removal

Rewrite the caller block (lines ~179–199) so the temp dir is removed in a
`finally`, and drop the now-redundant per-frame `unlinkSync`:

```ts
          const { tmpDir, framePaths } = extractKeyframes(ff.ffmpeg, item.mp4Path, duration);
          try {
            if (framePaths.length > 0) {
              const images = framePaths.map(fp => { const data = fs.readFileSync(fp); return data.toString("base64"); });
              const res = await requestUrl({ /* ...unchanged ollama vision call... */ });
              entry.vision = (res.json?.response || "").trim().slice(0, 800) || null;
            }
          } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
```

Keep the OUTER `try { ... } catch { /* fall through to cover image */ }` exactly
as it is — the new `try/finally` nests inside it. Do not change the Ollama
request body, the `entry.vision` assignment, or the surrounding `if (duration ...)`.

**Verify**:
- `npm run typecheck` → exit 0
- `grep -n "fs.rmSync(tmpDir" packages/core/src/pipeline/describe-items.ts` → 1 match
- `grep -n "fs.unlinkSync(fp)" packages/core/src/pipeline/describe-items.ts` → no matches (the per-frame unlink is gone; rmSync covers it)

### Step 3: Full suite

**Verify**: `npm test` → all pass (953+)

## Test plan

`extractKeyframes` / this code path shell out to a real `ffmpeg`/`ffprobe`
binary and call Ollama, neither of which is available in the unit environment,
so there is **no cheap, non-brittle unit test** for the cleanup. Do not build
one. Verification is: typecheck passes, the full suite stays green, and the grep
checks confirm the `rmSync(tmpDir, ...)` is present in a `finally` and the old
per-frame unlink is removed. The real cleanup behavior is exercised manually
(see Maintenance notes).

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 (953+ pass)
- [ ] `extractKeyframes` returns `{ tmpDir, framePaths }` and its single caller destructures it
- [ ] `grep -n "fs.rmSync(tmpDir" packages/core/src/pipeline/describe-items.ts` → 1 match, inside a `finally`
- [ ] `grep -n "fs.unlinkSync(fp)" packages/core/src/pipeline/describe-items.ts` → no matches
- [ ] Only `packages/core/src/pipeline/describe-items.ts` changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `grep` shows `extractKeyframes` is called from MORE than one place (the plan
  assumes a single caller; a second caller needs the same try/finally).
- The excerpts don't match the live code (drift).
- Restructuring the caller would force changes outside the multi-frame block.

## Maintenance notes

- **Manual verification (after merge, on a machine with ffmpeg):** run the
  Media pipeline / embeddings over a video item with `ffmpeg`+`ffprobe` on PATH,
  then confirm no `roost-frames-*` directories remain in the system temp dir
  (`ls "$TMPDIR"` on macOS, `/tmp` on Linux) once processing completes.
- Reviewer focus: confirm the `finally` runs on the Ollama-call-throws path
  (it must — that was the original leak), and that the outer
  `catch { /* fall through */ }` still swallows failures so a bad video falls
  back to the cover image.
- Follow-up (not this plan): `getVideoDuration` and the cover-image fallback
  don't create temp dirs, so they need no cleanup.
