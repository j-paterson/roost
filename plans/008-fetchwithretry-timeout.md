# Plan 008: Add a request timeout to fetchWithRetry so a stalled host can't hang enrichment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 1671710..HEAD -- packages/core/src/pipeline/resolvers/resolver-utils.ts packages/core/src/pipeline/resolvers/__tests__/resolver-utils.test.ts`
> If either changed since this plan was written, compare the excerpts below
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW (adds a timeout race around an existing call; default keeps
  current behavior except a stalled request now rejects instead of hanging)
- **Depends on**: none
- **Category**: bug / reliability
- **Planned at**: commit `1671710`, 2026-06-10

## Why this matters

`fetchWithRetry` is the shared HTTP wrapper for every watchable-id enrichment
resolver (TMDB, AniList, OMDB, openlibrary, jikan, …). It wraps Obsidian's
`requestUrl`, which has **no timeout or abort parameter** — if a third-party
host accepts the connection but never responds, the `await` hangs forever, and
because the enrichment pipeline awaits these calls, the whole pipeline stalls
with no way for the user to recover short of restarting Obsidian. Adding a
timeout that rejects (and then flows through the existing retry/backoff logic)
bounds the worst case to `timeoutMs × (retries+1)` instead of infinity.

## Current state

- `packages/core/src/pipeline/resolvers/resolver-utils.ts` — exports
  `fetchWithRetry`, `HttpError`, `canonicalizeTitle`. Uses Obsidian `requestUrl`.

```ts
// resolver-utils.ts:77-88
export interface FetchRetryOpts {
  retries?: number;          // default 2 (up to 3 total attempts)
  baseDelayMs?: number;      // default 250
  sleep?: (ms: number) => Promise<void>;   // injectable for tests
}
const DEFAULT_RETRIES = 2;
const DEFAULT_BASE_DELAY_MS = 250;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
```

```ts
// resolver-utils.ts:95-150 (the loop — abridged; the requestUrl call is line 109)
export async function fetchWithRetry(params: RequestUrlParam, opts: FetchRetryOpts = {}): Promise<RequestUrlResponse> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const sleep = opts.sleep ?? realSleep;
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await requestUrl({ ...params, throw: false });   // <-- line 109: can hang forever
      if (res.status >= 200 && res.status < 300) return res;
      // ... 429 / 5xx backoff, else throw HttpError ...
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // network-style errors retry if budget remains; HttpError does not
      if (attempt < retries && !(lastError instanceof HttpError)) {
        await sleep(baseDelay * Math.pow(4, attempt));
        continue;
      }
      throw lastError;
    }
  }
  throw lastError ?? new Error("fetchWithRetry: unknown error");
}
```

- The retry `catch` treats any non-`HttpError` as a retriable network error.
  A timeout rejection is therefore retried automatically and, after the budget
  is exhausted, thrown — exactly the desired behavior, no extra branching.
- Tests: `packages/core/src/pipeline/resolvers/__tests__/resolver-utils.test.ts`
  already drives `fetchWithRetry` using the obsidian-mock hooks
  `__setRequestUrlImpl` / `__resetRequestUrlImpl` (imported from `"obsidian"`).
  Model the new tests on that.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `npm install` | exit 0 |
| Typecheck | `npm run typecheck` | exit 0 |
| This file's tests | `npx vitest run packages/core/src/pipeline/resolvers/__tests__/resolver-utils.test.ts` | all pass |
| All tests | `npm test` | 953+ pass (baseline at `1671710`) |

## Scope

**In scope** (the only files you should modify):
- `packages/core/src/pipeline/resolvers/resolver-utils.ts`
- `packages/core/src/pipeline/resolvers/__tests__/resolver-utils.test.ts`

**Out of scope** (do NOT touch):
- `packages/core/src/lib/llm-provider.ts` — its `OllamaProvider.generate`
  already supports an abort `signal` (see its `Promise.race` at lines 89–97);
  adding a default timeout there is a deliberate follow-up, not this plan.
- The resolver call sites (tmdb-resolver.ts, anilist-resolver.ts) — they get
  the timeout for free via the default; no changes needed.

## Git workflow

- Branch: `advisor/008-fetchwithretry-timeout`
- Commit style: `fix(resolvers): time out hung requestUrl calls in fetchWithRetry`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a timeout option and a timeout race

In `resolver-utils.ts`:

1. Add to `FetchRetryOpts`: `timeoutMs?: number;` with a doc comment
   ("Per-attempt timeout in ms. Default 15000. A timed-out attempt rejects and
   is retried like any network error.").
2. Add a constant `const DEFAULT_TIMEOUT_MS = 15000;`.
3. Add an exported `TimeoutError` (mirrors the existing `HttpError` shape) and a
   small `withTimeout` helper:

```ts
export class TimeoutError extends Error {
  constructor(public timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
```

4. In `fetchWithRetry`, read `const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;`
   and wrap the request call:
   `const res = await withTimeout(requestUrl({ ...params, throw: false }), timeoutMs);`

`TimeoutError` is not an `HttpError`, so the existing `catch` retries it and
then throws after the budget — no other change to the loop is needed.

**Verify**: `npm run typecheck` → exit 0

### Step 2: Tests

Add a `describe("fetchWithRetry timeout")` block to `resolver-utils.test.ts`
(it already imports `__setRequestUrlImpl`/`__resetRequestUrlImpl`; add
`fetchWithRetry` and `TimeoutError` to the imports from `../resolver-utils`):

- **Times out a hung request and retries the budget**: set the requestUrl impl
  to a never-resolving promise that increments a call counter
  (`let calls = 0; __setRequestUrlImpl(() => { calls++; return new Promise(() => {}); })`).
  Call `await expect(fetchWithRetry({ url: "https://x" }, { timeoutMs: 10, retries: 1, sleep: async () => {} })).rejects.toThrow(/timed out/)`.
  Then assert `calls === 2` (initial + 1 retry).
- **Fast success is unaffected**: impl resolves immediately with
  `{ status: 200, headers: {}, json: {}, text: "" }`; `fetchWithRetry({url:"x"}, { timeoutMs: 1000 })` resolves to that response (regression guard that the timeout race doesn't break the happy path).
- Use `afterEach(__resetRequestUrlImpl)` (follow the file's existing teardown).

**Verify**: `npx vitest run packages/core/src/pipeline/resolvers/__tests__/resolver-utils.test.ts` → all pass (existing + 2 new)

### Step 3: Full suite

**Verify**: `npm test` → all pass (953+)

## Test plan

Covered by Step 2. Pattern: the existing `__setRequestUrlImpl`-based tests in
the same file. Real elapsed time is a few ms per attempt (tiny `timeoutMs`),
so no slow tests.

## Done criteria

ALL must hold:

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0; the 2 new timeout tests exist and pass
- [ ] `grep -n "withTimeout(requestUrl" packages/core/src/pipeline/resolvers/resolver-utils.ts` → 1 match
- [ ] `grep -n "timeoutMs" packages/core/src/pipeline/resolvers/resolver-utils.ts` → ≥ 3 matches (option, constant, usage)
- [ ] Only the 2 in-scope files changed (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts above don't match the live code (drift).
- A timed-out request does NOT flow through the existing retry/throw path as
  expected (e.g. the loop swallows it) — report the observed control flow.
- More than the 2 in-scope files would need to change.

## Maintenance notes

- Follow-up (deliberately deferred): give `OllamaProvider.generate` in
  `llm-provider.ts` a default timeout too, reusing this `withTimeout` helper —
  it already has the `Promise.race` scaffold for its abort signal.
- If a resolver legitimately needs a longer ceiling (large payloads), it can
  pass `{ timeoutMs }` per call — the default should stay conservative.
- Reviewer focus: confirm `clearTimeout` runs on both resolve and reject (no
  dangling timers), and that `TimeoutError` is genuinely treated as retriable.
