# Roost E2E (WebdriverIO + wdio-obsidian-service)

One `wdio run` = **one** Obsidian launch for all specs in that invocation. Prefer tiered scripts over `test:e2e` during development.

## Scripts

| Command | What runs |
|---------|-----------|
| `npm test` | Vitest unit tests (fast — use for refactor loops) |
| `npm run test:e2e:smoke` | Boot + gallery pipeline cards (~2 specs) |
| `npm run test:e2e:gallery` | Smoke + places map + media list + feed mode (~5 specs) |
| `npm run capture:promo` | Marketing PNGs → `docs/promo/screenshots/` (not part of default E2E) |
| `npm run capture:promo:slow` | Same, with long pauses for screen recording |
| `npm run capture:promo:burst` | Burst PNG sequences for ffmpeg clips (experiment C) |
| `npm run promo:experiments` | Run promo experiments A–D + verify (see `docs/promo/experiments/`) |
| `npm run test:e2e` | Full non-live suite (all `*.spec.ts` except `*.live.spec.ts`) |
| `npm run test:e2e:no-build` | Full suite without `vite build` (after you already built) |

## Single spec

```bash
npm run build && npm run e2e:stage
npx wdio run tests/e2e/wdio.conf.mts --spec tests/e2e/21-places-feed-mode.spec.ts
```

## Fixture vault

E2E uses `tests/fixtures/vault/` (synthetic bookmarks). Regenerate after changing sample data:

```bash
npm run fixture:vault
```

Each categorized bookmark gets full `recipe_*`, `place_*`, `media_*`, etc. frontmatter so gallery/promo captures do not show nulls. Quality checks: `npm test -- tests/fixtures/fixture-vault-quality.test.ts`.

## Environment

| Variable | Effect |
|----------|--------|
| `OBSIDIAN_E2E_VERSION` | Obsidian app version (default `latest` stable; use `1.10.0` only if pre-downloaded or Insiders creds set) |
| `E2E_BAIL=1` | Mocha `bail` — stop after first failure |
| `E2E_RUN_LIVE=1` | Include `*.live.spec.ts` (real network + credentials) |

## Live tests

See [LIVE-TESTING.md](./LIVE-TESTING.md). Live specs are excluded unless `E2E_RUN_LIVE=1`.
