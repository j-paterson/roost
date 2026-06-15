# Remote Mobile Vault Search — Design

**Date:** 2026-04-30 (v1), revised 2026-05-01 (v2), revised 2026-05-11 (v2.1)
**Status:** v1 + v2 + v2.1 implemented, merged, and deployed. End-to-end search from Claude mobile app confirmed working.
**Scope:** Enable searching the user's Obsidian vault from the Claude mobile app, end-to-end.

## Revision history

- **v1 — 2026-04-30**: Bearer-token-over-Tailscale-Funnel, single ObsidianVault. Implemented and merged. Discovered during deployment that Claude.ai's Custom Connector UI does **not** accept user-pasted bearer tokens — it requires an OAuth 2.0 flow with Dynamic Client Registration ([Issue #112](https://github.com/anthropics/claude-ai-mcp/issues/112)). Mobile additionally cannot store user-pasted secrets, making OAuth + DCR the only viable client onboarding path.
- **v2 — 2026-05-01**: Pivot to OAuth-shaped auth backed by the same bearer secret (single-user "approval" UX). Add multi-vault support (parent-dir mount), and a `Host:` header allowlist for defense in depth. Phase 1.5 inserted before Phase 4 (Claude connector setup).
- **v2.1 — 2026-05-11**: Token store persisted to disk (`/data/oauth-store.json`). Original v2 design kept tokens in memory only, assuming the 90-day refresh-token TTL would absorb the rare container restart. In practice, Synology DSM auto-updates and Docker daemon restarts forced re-consent every few days, with Claude silently 401-ing rather than re-authorizing. Persistence fixed this without introducing encryption-at-rest (single-user threat model: the same compromise that leaks `MCP_AUTH_TOKEN` from `.env` would leak the token store anyway). Confirmed: same access token works across `docker compose restart`. End-to-end search from Claude mobile app over cellular confirmed.

## Goal

The user can open Claude on their phone, ask a natural-language question about their vault, and get answers grounded in their notes — with the index staying current as they edit.

## Non-Goals

- Mobile web app frontend (option B). Deferred; may be revisited after this ships.
- Custom Obsidian mobile plugin (option C). Deferred indefinitely.
- Multi-user support. Single-user only — but the auth surface is now OAuth-shaped, so adding more users later means swapping the provider, not redesigning.
- Cloud-hosted vault or embeddings. Vault and embeddings stay on the NAS.
- High-availability search. Search is down when the NAS is down; acceptable trade for local-only data.
- Real third-party identity (Google, GitHub) login. Could be added later by swapping the SDK's `OAuthServerProvider` for `ProxyOAuthServerProvider`. Not needed for one user.

## Architecture

```
┌─────────────────────────┐
│  Claude (web / mobile)  │
│  Custom Connector via   │
│  OAuth 2.0 + DCR        │
└───────────┬─────────────┘
            │
            │  1. GET  /.well-known/oauth-authorization-server  (discovery)
            │  2. POST /register   (DCR — Claude auto-registers, gets client_id)
            │  3. GET  /authorize  (user grants consent — pastes bearer once)
            │  4. POST /token      (exchange code → access_token)
            │  5. POST /mcp        (Authorization: Bearer <access_token>)
            │
            ▼
┌─────────────────────────┐
│  Tailscale Funnel edge  │  *.ts.net hostname
└───────────┬─────────────┘
            │  outbound-only tunnel from NAS
            ▼
┌──────────────────────────────────────────────────────┐
│  NAS (always on)                                     │
│  ┌────────────────────────────────────────────────┐  │
│  │  docker compose stack                          │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  vault-search MCP server                 │  │  │
│  │  │  ┌──────────────────────────────────┐    │  │  │
│  │  │  │ Express app                      │    │  │  │
│  │  │  │  • hostAllowlist  (Host: gate)   │    │  │  │
│  │  │  │  • mcpAuthRouter (SDK OAuth)     │    │  │  │
│  │  │  │      ├─ /.well-known/...         │    │  │  │
│  │  │  │      ├─ /register (DCR)          │    │  │  │
│  │  │  │      ├─ /authorize (consent)     │    │  │  │
│  │  │  │      ├─ /token, /revoke          │    │  │  │
│  │  │  │  • requestLogger, requestTimeout │    │  │  │
│  │  │  │  • bearerAuth (verifyAccessToken)│    │  │  │
│  │  │  │  • /mcp Streamable HTTP transport│    │  │  │
│  │  │  │  • /healthz, /debug/recent       │    │  │  │
│  │  │  └──────────────────────────────────┘    │  │  │
│  │  │  + watcher  ──▶  /vault  (RO mount,      │  │  │
│  │  │                  parent of one or more   │  │  │
│  │  │                  vault subdirectories)   │  │  │
│  │  │  + sqlite-vec ──▶ /data  (RW volume)     │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  │  ┌──────────────────────────────────────────┐  │  │
│  │  │  ollama (sidecar, internal-only)         │  │  │
│  │  └──────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────┐  │
│  │  tailscaled  (Funnel enabled for one port)     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### Key properties

- **Vault is read-only inside the container.** Search can never corrupt notes.
- **Index lives in a separate Docker volume.** Container rebuilds preserve the index.
- **Embeddings stay on the NAS.** Ollama runs locally; note content never leaves the user's network even though the endpoint is publicly addressable.
- **Watcher keeps the index live.** Edits made on any device that syncs into the NAS vault propagate into the index without manual reindex.
- **OAuth-shaped auth, single-secret backed.** The MCP server is its own OAuth issuer (via the SDK's `mcpAuthRouter`). Consent on `/authorize` is gated by a single long-lived bearer token (`MCP_AUTH_TOKEN`) that the user pastes one time per Claude installation. After consent, Claude holds an access token (and refresh token) issued by our server. The bearer is the master credential; OAuth tokens are derived from it.
- **Host-header allowlist.** `MCP_ALLOWED_HOSTS` env var configures which `Host:` header values are permitted. Defense against DNS rebinding and accidental cross-origin embedding.

### Network model

- **Tailscale Funnel** chosen over Cloudflare Tunnel: no domain required; user already prefers Tailscale.
- Funnel exposes a single port over a `*.ts.net` hostname. The MCP server itself does the OAuth dance.
- The NAS makes only outbound connections to the Tailscale edge. No inbound port-forwarding on the home router.
- **Tailscale identity is NOT used for authenticating Claude's calls.** Once Funnel is enabled, requests come from the public internet — Tailscale identity headers don't apply. The bearer/OAuth flow is the entire auth story.

## Components

### vault-search MCP server (existing, hardened in v1)

- HTTP transport via `StreamableHTTPServerTransport`, gated behind OAuth bearer-token verification (`mcpAuthRouter`'s `bearerAuth` middleware backed by our `verifyAccessToken`).
- Stdio transport remains available for local dev (`MCP_TRANSPORT` env switch). No OAuth in stdio mode.
- Tools: `search_vault`, `get_similar`, `get_context`, `reindex`. Result `limit` capped at 50.
- `/healthz` unauthenticated endpoint for tunnel health checks.
- `/debug/recent` (auth-gated) returns the last 200 request log entries.

### OAuth provider (new in v2)

Uses the SDK's `mcpAuthRouter()` to install standard endpoints:
- `/.well-known/oauth-authorization-server` — RFC 8414 metadata discovery
- `/register` — RFC 7591 Dynamic Client Registration
- `/authorize` — consent page (HTML form, "paste bearer to approve")
- `/token` — code → access_token exchange
- `/revoke` — token revocation

Implements `OAuthServerProvider` with:
- **`clientsStore`**: in-memory map, optionally backed by `OAUTH_STORE_PATH` (default `/data/oauth-store.json` in production). Survives container restarts.
- **`authorize`**: renders an HTML form. Form posts back to a local handler that constant-time-compares the submitted bearer to `MCP_AUTH_TOKEN`. On match, issues an authorization code with PKCE binding, redirects to the registered redirect URI.
- **`exchangeAuthorizationCode`**: validates code + PKCE verifier, issues access token (default TTL: 30 days) and refresh token (default TTL: 90 days). Tokens are random opaque strings persisted to `OAUTH_STORE_PATH` via atomic JSON snapshot (temp file + rename, mode 0600).
- **`exchangeRefreshToken`**: standard refresh flow. Lets Claude keep working without re-consent across the 90-day refresh window, including across container restarts.
- **`verifyAccessToken`**: in-memory map lookup (backed by the persisted snapshot loaded at startup). Returns `AuthInfo` or throws.
- **`revokeToken`**: removes token from memory and snapshots the change to disk.
- **Authorization codes are intentionally NOT persisted** — single-use, 5-minute TTL; a restart almost certainly invalidates the in-flight code anyway.

### Multi-vault scanner (revised in v2)

- The scanner walks `VAULT_PATH` recursively (no code change for this).
- `EXCLUDE_DIRS` semantics change: in v1 the check was on the first path segment only; in v2 it matches **any** path segment. So `.obsidian` inside a nested vault directory (e.g. `ObsidianVault/.obsidian/`) is properly excluded.
- Compose mounts both `ObsidianVault` and `ObsidianBookmarks` (or any number of vaults) under `/vault`. Result paths are returned with the vault subdirectory as their first segment, e.g. `ObsidianVault/Foo.md`, `ObsidianBookmarks/Bar.md`.
- Single SQLite index across all vaults. No per-vault filter at query time (yet). Could add `vault: string` argument to `search_vault` later if needed.

### Host allowlist middleware (new in v2)

- Env var `MCP_ALLOWED_HOSTS` is a comma-separated list of allowed `Host:` header values (e.g. `syn-1.tail356dbd.ts.net,localhost:3099,127.0.0.1:3099`).
- Middleware mounted globally (before health, OAuth, and `/mcp`).
- Returns 421 (Misdirected Request) if the `Host:` header isn't on the list.
- If the env var is unset, the middleware is a no-op (preserves current behavior).
- `/healthz` is exempt (so monitors can use any hostname).

### Watcher (existing)

- Subscribes to vault file changes, triggers incremental reindex.
- Runs in-process with the MCP server.

### Ollama (sidecar)

- Provides embeddings via local HTTP API.
- Model selection driven by `OLLAMA_URL` and existing config.

### Observability (existing)

- Per-request log line: timestamp, method, tool name, latency, status. Query content NOT logged by default.
- `/debug/recent` ring buffer (200-entry capacity, auth-gated).

## Data flow

**First connect from Claude (one-time per installation):**

1. User adds Custom Connector in Claude with the URL `https://<machine>.<tailnet>.ts.net/mcp`.
2. Claude fetches `/.well-known/oauth-authorization-server`, learns about `/register`, `/authorize`, `/token`.
3. Claude POSTs to `/register` with metadata, receives a `client_id`.
4. Claude opens `/authorize?client_id=...&code_challenge=...` in a browser.
5. Server renders an HTML page: "Approve Claude to access vault-search? Paste bearer token to confirm."
6. User pastes the value of `MCP_AUTH_TOKEN`. Server constant-time-compares.
7. On match, server issues authorization code, redirects back to Claude's redirect URI with `?code=...`.
8. Claude POSTs to `/token` with code + PKCE verifier, receives access_token and refresh_token.

**Steady-state tool calls:**

1. User asks Claude mobile a question that triggers a tool call.
2. Claude sends an MCP `tools/call` over HTTPS to `/mcp` with `Authorization: Bearer <access_token>`.
3. Tailscale Funnel forwards to the NAS, which forwards to the MCP server container.
4. Host-allowlist middleware verifies the `Host:` header.
5. Bearer middleware calls `verifyAccessToken`, which checks the (disk-backed) in-memory token map.
6. Request hits the tool handler.
7. `search_vault` queries sqlite-vec for vector matches and FTS5 for keyword matches, fuses results.
8. For embedding the user's query, MCP server calls Ollama on the internal docker network.
9. Result returned as JSON, Claude presents to user.

**Token expiry:**

- Access token expires after 30 days → Claude transparently uses refresh token to get a new one.
- Refresh token expires after 90 days → Claude redirects user back through `/authorize`, user pastes bearer again.
- Container restart → token store loads from `/data/oauth-store.json`; Claude's tokens continue to work without re-consent (until the 90-day refresh TTL).

## Phased roadmap

### Phase 0 — Land the in-flight work ✅ done (v1)

The HTTP transport, watcher, Dockerfile, docker-compose, and eval harness already exist as ~350 lines of uncommitted changes. Finish, test, and commit on a branch.

### Phase 1 — Auth + production hardening ✅ done (v1)

Bearer-token middleware, `/healthz`, request logging, request timeout, bounded result limits.

### Phase 1.5 — v2 pivot (NEW)

- **Multi-vault scanner fix.** Modify `EXCLUDE_DIRS` checking in `src/scanner.ts` (and `src/watcher.ts`) to match any path segment. Update tests if any reference the old single-segment behavior.
- **Host allowlist middleware.** New `mcp/hosts.ts` with `hostAllowlist(allowed: string[])`. Skips `/healthz`. Mount before everything else on the express app. Tests: missing `Host`, allowed, disallowed, comma-list parsing.
- **OAuth provider.** New `mcp/oauth/`:
  - `provider.ts` — `OAuthServerProvider` implementation (in-memory store, bearer-gated consent).
  - `consent-page.ts` — HTML form rendered by `/authorize` (minimal, no JS, accessible).
  - `clients-store.ts` — in-memory `OAuthRegisteredClientsStore`.
  - Tests: full OAuth dance with PKCE, expired tokens, refresh, revocation, bad bearer rejection.
- **Wire into server.** In `mcp/server.ts`, mount `mcpAuthRouter()` with our provider. Replace the existing `bearerAuth(MCP_AUTH_TOKEN)` middleware on `/mcp` with the SDK's bearer middleware that delegates to our `verifyAccessToken`. Keep the old direct-bearer path available behind an env flag (`MCP_DIRECT_BEARER=1`) for ease of curl-based smoke testing.
- **Compose / env.** `.env.example` adds `MCP_ALLOWED_HOSTS`, `MCP_OAUTH_ISSUER`. `docker-compose.yml` mounts vault parent dir, env-interpolates these.

### Phase 2 — Deploy to NAS (revised)

Same as v1 but:
- `VAULT_HOST_PATH` is now the **parent directory** containing one or more vault subdirs (matches user's existing in-flight compose).
- Sync code via rsync from this Mac (since git isn't installed on the NAS, and the existing setup uses Synology File Station).
- Set `MCP_OAUTH_ISSUER=https://<machine>.<tailnet>.ts.net` once Funnel is up (Phase 3).
- Set `MCP_ALLOWED_HOSTS` to the Funnel hostname plus localhost variants for in-NAS smoke tests.

### Phase 3 — Tailscale Funnel (unchanged)

### Phase 4 — Connect Claude mobile (revised)

- Add Custom Connector with the OAuth URL — Claude does the rest (DCR, then redirects to `/authorize`).
- User pastes `MCP_AUTH_TOKEN` once on the consent page.
- Confirm the four tools show up.
- Run a real query from the phone.

### Phase 5 — Quality + observability ✅ done (v1)

Eval harness CLI, `/debug/recent` ring buffer, regression-check workflow doc.

## Error handling (v2 additions)

- **OAuth failure modes:**
  - Bad bearer on `/authorize` → render same form with error message; don't redirect back to client.
  - Expired authorization code → 400 + `error=invalid_grant`. Standard.
  - Expired access token → 401 + `WWW-Authenticate: Bearer error="invalid_token"`. Claude's MCP client handles refresh.
  - Expired refresh token → 401 + `WWW-Authenticate: ...resource_metadata=...` to trigger re-consent.
- **Host-header rejection:** 421 Misdirected Request. No body — don't leak which hostnames are valid.
- **Token store loads from disk on startup:** Claude's existing tokens continue to work across container restart. If `OAUTH_STORE_PATH` is unset (dev) or the snapshot file is missing/corrupt, the store starts empty and Claude will need to re-authorize.

## Testing (v2 additions)

- OAuth provider unit tests (in-memory store correctness, code/token lifecycle, PKCE validation).
- Host-allowlist middleware unit tests (matrix of `Host:` values).
- End-to-end OAuth integration test (supertest, simulating Claude's flow: discovery → register → authorize-with-bearer → exchange code → call /mcp with token).
- Manual: complete the flow from Claude mobile against a local docker compose run before deploying to NAS.

## Security considerations (v2 additions)

- **Tokens persisted unencrypted at rest** in `/data/oauth-store.json` (mode 0600). The single-user threat model treats this as equivalent in sensitivity to `.env` — anyone with read access to either can impersonate the user. The original v2 design kept tokens in memory only to avoid this exposure, but in practice Synology / Docker restarts were frequent enough (every few days) that the in-memory model forced silent re-consents Claude never recovered from. Persistence is the correct trade for this deployment scale.
- **`MCP_AUTH_TOKEN` is now a master credential.** Compromise = attacker can grant themselves access to all future tokens. Treat it as you would a password: chmod 600 the `.env`, never paste in chat, never commit. Rotate by updating the env var and restarting the server.
- **PKCE is mandatory.** The SDK's `mcpAuthRouter` enforces it for the authorize/token flow. Mobile clients are the primary beneficiary.
- **Rate limiting** on `/register`, `/authorize`, `/token`. The SDK applies sane defaults; we don't disable them.
- **Host allowlist** prevents DNS rebinding and accidental cross-origin embedding. With Tailscale Funnel, the canonical hostname is `<machine>.<tailnet>.ts.net` and that's what gets allowlisted. Direct-IP requests (`100.99.236.86`) are rejected unless explicitly allowlisted.

## Open questions for implementation (v2)

- **Refresh token lifetime.** 90 days is a reasonable default. Should it be configurable? (Probably yes, env var with a default.)
- **Consent page styling.** Plain HTML is fine. Worth ~30 min on a tiny CSS file so the form isn't jarring on mobile, but not blocking.
- **Multi-vault tool argument.** Defer adding a `vault` filter to search tools unless cross-vault noise becomes a real problem.
- **Bearer rotation procedure.** Currently: edit `.env`, restart container. Document explicitly in the runbook so a future-you doesn't forget. (Add to `nas-deployment.md`.)

These don't block the design but should be answered at the start of the v2 implementation plan.
