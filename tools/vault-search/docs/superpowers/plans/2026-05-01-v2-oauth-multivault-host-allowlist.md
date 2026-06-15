# v2 Implementation Plan — OAuth, Multi-Vault, Host Allowlist

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vault-search reachable from Claude.ai (web + mobile) via OAuth + DCR, support multi-vault parent-dir mounts, and add a `Host:` header allowlist.

**Architecture:** Use the MCP SDK's `mcpAuthRouter()` to install discovery / DCR / authorize / token endpoints. Implement `OAuthServerProvider` with an in-memory store; gate the `/authorize` consent page with the existing `MCP_AUTH_TOKEN` (bearer-as-master-credential, OAuth tokens are derived). Multi-vault is a one-line scanner fix (match `.obsidian` etc. at any depth). Host allowlist is a small Express middleware before the OAuth router.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk`'s `server/auth/*` exports (`mcpAuthRouter`, `OAuthServerProvider`, in-memory `OAuthRegisteredClientsStore`), Vitest + supertest.

**Spec:** `docs/superpowers/specs/2026-04-30-remote-mobile-vault-search-design.md` (v2, dated 2026-05-01).

---

## State of the codebase entering this plan

The v1 work landed on `master` at `de9d221` (spec) / `6eee251` (Dockerfile) / `92c664b` (regression doc). Phases 0/1/5 are complete and tested. v2 builds additively on top:

- `mcp/auth.ts` — bearer middleware. Will become unused for `/mcp` (OAuth's verifyAccessToken takes over) but is kept around for the `MCP_DIRECT_BEARER=1` escape hatch (curl smoke testing without OAuth).
- `mcp/health.ts`, `mcp/logging.ts`, `mcp/limits.ts`, `mcp/recent.ts` — unchanged by v2.
- `mcp/server.ts` — gets new mounts (host allowlist, mcpAuthRouter) and swaps the `/mcp` bearer middleware.
- `src/scanner.ts`, `src/watcher.ts` — `isExcluded()` becomes recursive.
- `docker-compose.yml`, `.env.example`, `Dockerfile` — env-var additions; vault mount becomes parent-dir.
- Runbooks (`nas-deployment.md`, `claude-connector.md`) — revised flows.

A new worktree should be created for v2 work (separate from any v1 worktree, which has been cleaned up).

---

## File Structure

| Path | Responsibility | Status |
|---|---|---|
| `src/scanner.ts` | Walk vault, change detection | Modified (recursive exclude) |
| `src/watcher.ts` | fs.watch + debounce | Modified (recursive exclude) |
| `src/scanner.test.ts` | Test recursive exclusion behavior | New |
| `mcp/hosts.ts` | `hostAllowlist(allowed)` middleware, parsing helper | New |
| `mcp/hosts.test.ts` | Allowlist matrix tests | New |
| `mcp/oauth/store.ts` | In-memory clients store + token store | New |
| `mcp/oauth/store.test.ts` | Store unit tests | New |
| `mcp/oauth/consent-page.ts` | Render the `/authorize` HTML form | New |
| `mcp/oauth/consent-page.test.ts` | Render correctness | New |
| `mcp/oauth/provider.ts` | `OAuthServerProvider` implementation (consent + tokens) | New |
| `mcp/oauth/provider.test.ts` | Authorize + token + verify lifecycle | New |
| `mcp/oauth/index.ts` | Public exports + factory | New |
| `mcp/server.ts` | Wire host allowlist + mcpAuthRouter; swap `/mcp` middleware | Modified |
| `.env.example` | Add `MCP_ALLOWED_HOSTS`, `MCP_OAUTH_ISSUER` | Modified |
| `docker-compose.yml` | Parent-dir vault mount; env interpolation for new vars | Modified |
| `docs/superpowers/runbooks/nas-deployment.md` | Parent-dir mount, OAuth env, rsync sync, bearer rotation | Modified |
| `docs/superpowers/runbooks/claude-connector.md` | OAuth-discovery flow, consent page UX | Rewritten |

---

## Phase A — Multi-vault scanner

### Task A.1: Recursive `EXCLUDE_DIRS` matching

**Files:**
- Modify: `src/scanner.ts` (find `isExcluded` or equivalent)
- Modify: `src/watcher.ts` (same logic at lines 36-39)
- Create: `src/scanner.test.ts`

- [ ] **Step 1: Read both files first.** `src/scanner.ts` defines an `isExcluded(relPath)` (or similar) that splits on `path.sep` and only checks `relPath.split(path.sep)[0]`. `src/watcher.ts` lines 36-39 has the same pattern in its own `isExcluded`. We want both to match `EXCLUDE_DIRS` against ANY path segment.

- [ ] **Step 2: Write the failing test.** Create `src/scanner.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { isExcluded } from "./scanner";

describe("isExcluded (recursive)", () => {
  it("excludes a top-level Archive directory", () => {
    expect(isExcluded(path.join("Archive", "old.md"))).toBe(true);
  });

  it("excludes a nested .obsidian directory", () => {
    expect(isExcluded(path.join("ObsidianVault", ".obsidian", "config.json"))).toBe(true);
  });

  it("excludes a deeply nested templates directory", () => {
    expect(isExcluded(path.join("Vaults", "VaultA", "templates", "daily.md"))).toBe(true);
  });

  it("does NOT exclude a regular nested file", () => {
    expect(isExcluded(path.join("ObsidianVault", "Dashboard", "note.md"))).toBe(false);
  });

  it("excludes any segment starting with a dot", () => {
    expect(isExcluded(path.join("ObsidianBookmarks", ".trash", "x.md"))).toBe(true);
  });

  it("does NOT exclude files where '.' appears mid-name (e.g. note.archive.md)", () => {
    expect(isExcluded(path.join("ObsidianVault", "note.archive.md"))).toBe(false);
  });
});
```

- [ ] **Step 3: Verify test fails.** `npx vitest run src/scanner.test.ts` — expect FAIL with `Cannot find module './scanner'` if `isExcluded` is not exported, OR (more likely) tests for nested cases fail because current logic only checks segment[0].

If `isExcluded` isn't currently exported from `src/scanner.ts`, export it (without changing behavior yet) and re-run — tests for nested cases should still fail.

- [ ] **Step 4: Implement the recursive check** in `src/scanner.ts`. Replace the old `isExcluded` (find via grep `EXCLUDE_DIRS\|isExcluded` in `src/scanner.ts`) with:

```ts
import path from "node:path";
import { EXCLUDE_DIRS } from "./config";

export function isExcluded(relPath: string): boolean {
  const segments = relPath.split(path.sep);
  for (const segment of segments) {
    if (!segment) continue;
    if (EXCLUDE_DIRS.has(segment)) return true;
    if (segment.startsWith(".")) return true;
  }
  return false;
}
```

Make sure it's `export`ed.

- [ ] **Step 5: Apply the same fix in `src/watcher.ts`.** Replace its inline `isExcluded` (lines ~36-39) with an import from `./scanner`:

```ts
import { isExcluded } from "./scanner";
```

Remove the local `isExcluded` function definition. Use the imported one in the existing `if (isExcluded(filename)) return;` call.

- [ ] **Step 6: Verify tests pass.** `npx vitest run src/scanner.test.ts` — 6 tests pass. Then `npm test` — full suite still 18 passing + 6 new = 24.

- [ ] **Step 7: Verify `npm run build`.** Exit 0.

- [ ] **Step 8: Commit.**

```bash
git add src/scanner.ts src/scanner.test.ts src/watcher.ts
git commit -m "feat(scanner): exclude EXCLUDE_DIRS at any path depth"
```

3 files. Use explicit `git add`.

---

### Task A.2: Update `.env.example` and `docker-compose.yml` for parent-dir mount

**Files:**
- Modify: `.env.example`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Edit `.env.example`.** Replace the single-vault path block with a parent-dir example. Final contents:

```env
# Bearer token Claude must send as `Authorization: Bearer <token>`.
# Generate a fresh one with:  openssl rand -hex 32
# After populating, restrict the file:  chmod 600 .env
MCP_AUTH_TOKEN=

# Path on the host to the PARENT directory containing one or more Obsidian vault subdirs.
# Each vault subdir (e.g. ObsidianVault/, ObsidianBookmarks/) becomes the first path
# segment in search results. Synology DSM example:  /var/services/homes/<user>/Obsidian
VAULT_HOST_PATH=/path/to/your/obsidian-parent

# Path on the host where the search index volume lives (read-write).
DATA_HOST_PATH=/path/to/vault-search-data

# Public port on the host.
MCP_HOST_PORT=3099

# Comma-separated list of allowed Host: header values for /mcp and OAuth endpoints.
# Include the Tailscale Funnel hostname plus localhost variants for in-network smoke tests.
# Leave empty to disable the Host-header check (NOT recommended for public deployments).
MCP_ALLOWED_HOSTS=

# Public OAuth issuer URL — must match the Tailscale Funnel HTTPS URL (no trailing slash).
# Used by /.well-known/oauth-authorization-server discovery.
MCP_OAUTH_ISSUER=
```

- [ ] **Step 2: Edit `docker-compose.yml`.** Replace the existing `vault-search` service block with:

```yaml
  vault-search:
    build: .
    container_name: vault-search-mcp
    restart: unless-stopped
    ports:
      - "${MCP_HOST_PORT:-3099}:3000"
    volumes:
      - ${VAULT_HOST_PATH}:/vault:ro
      - ${DATA_HOST_PATH}:/data
    environment:
      - MCP_TRANSPORT=http
      - MCP_PORT=3000
      - VAULT_PATH=/vault
      - DB_PATH=/data/search.db
      - OLLAMA_URL=http://ollama:11434
      - EMBED_MODEL=nomic-embed-text
      - MCP_AUTH_TOKEN=${MCP_AUTH_TOKEN}
      - MCP_ALLOWED_HOSTS=${MCP_ALLOWED_HOSTS:-}
      - MCP_OAUTH_ISSUER=${MCP_OAUTH_ISSUER:-}
    depends_on:
      - ollama
```

Note: keep the `ollama` service block and `volumes:` block at the bottom unchanged.

- [ ] **Step 3: Verify `docker compose config` parses.** Run from the project root:

```bash
docker compose config | grep -E 'VAULT_PATH|MCP_ALLOWED_HOSTS|MCP_OAUTH_ISSUER' | head
```

If you see `${...}` in the output instead of resolved values, the `.env` file isn't being read (or the new vars aren't in it yet). That's fine for now — we'll set them at deploy time.

- [ ] **Step 4: Commit.**

```bash
git add .env.example docker-compose.yml
git commit -m "feat: parent-dir vault mount and v2 env vars in compose"
```

---

## Phase B — Host allowlist middleware

### Task B.1: `hostAllowlist` middleware (TDD)

**Files:**
- Create: `mcp/hosts.ts`
- Create: `mcp/hosts.test.ts`

- [ ] **Step 1: Write failing tests.** Create `mcp/hosts.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { hostAllowlist, parseAllowedHosts } from "./hosts";

function mockReq(host: string | undefined, path = "/mcp"): Request {
  return { headers: { host }, path } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("parseAllowedHosts", () => {
  it("returns [] for empty / undefined input", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts("   ")).toEqual([]);
  });
  it("trims and lowercases", () => {
    expect(parseAllowedHosts("Foo.com, BAR:80 ")).toEqual(["foo.com", "bar:80"]);
  });
  it("ignores empty entries from extra commas", () => {
    expect(parseAllowedHosts("a,,b,")).toEqual(["a", "b"]);
  });
});

describe("hostAllowlist middleware", () => {
  it("is a no-op when allowed list is empty", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist([])(mockReq("any.host"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows requests with an allowlisted Host", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com", "bar:80"])(mockReq("foo.com"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("matches case-insensitively", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("FOO.COM"), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 421 on disallowed Host", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("evil.example"), res, next);
    expect(res.status).toHaveBeenCalledWith(421);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 421 when Host header is missing", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq(undefined), res, next);
    expect(res.status).toHaveBeenCalledWith(421);
    expect(next).not.toHaveBeenCalled();
  });

  it("exempts /healthz from the check", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("anything", "/healthz"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Verify fail.** `npx vitest run mcp/hosts.test.ts` — module not found.

- [ ] **Step 3: Implement `mcp/hosts.ts`.**

```ts
import type { Request, Response, NextFunction } from "express";

/** Parse a comma-separated list into a normalized lowercase array. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Reject requests whose Host header is not in the allowed list.
 * Empty allowed list = no-op (preserves backwards compatibility).
 * /healthz is always exempt.
 */
export function hostAllowlist(allowed: string[]) {
  const set = new Set(allowed.map((h) => h.toLowerCase()));
  const enabled = set.size > 0;

  return function (req: Request, res: Response, next: NextFunction): void {
    if (!enabled) {
      next();
      return;
    }
    if (req.path === "/healthz") {
      next();
      return;
    }
    const host = (req.headers.host || "").toLowerCase();
    if (!host || !set.has(host)) {
      res.status(421).send();
      return;
    }
    next();
  };
}
```

- [ ] **Step 4: Verify pass.** `npx vitest run mcp/hosts.test.ts` — 9 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add mcp/hosts.ts mcp/hosts.test.ts
git commit -m "feat: Host-header allowlist middleware (mcp/hosts.ts)"
```

---

### Task B.2: Wire host allowlist into the server

**Files:**
- Modify: `mcp/server.ts`

- [ ] **Step 1: Read `mcp/server.ts`** to see the current mount order in `startHttp()`. As of v1, it's:

```ts
const app = createMcpExpressApp();
app.use(healthRouter);
app.use("/mcp", requestLogger({ ring: recentRing }));
app.use("/mcp", requestTimeout(REQUEST_TIMEOUT_MS));
if (authToken) { app.use("/mcp", bearerAuth(authToken)); ... }
```

The host allowlist should be the FIRST middleware after `createMcpExpressApp()` — before `healthRouter` (the middleware itself exempts `/healthz`, so this is safe).

- [ ] **Step 2: Add the import** near the top of `mcp/server.ts`:

```ts
import { hostAllowlist, parseAllowedHosts } from "./hosts";
```

- [ ] **Step 3: Read env + mount** at the start of `startHttp()`, immediately after `const app = createMcpExpressApp();`:

```ts
const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
if (allowedHosts.length === 0) {
  console.error("WARNING: MCP_ALLOWED_HOSTS not set — Host header is not validated");
} else {
  console.error(`Host allowlist enabled (${allowedHosts.length} entries)`);
}
app.use(hostAllowlist(allowedHosts));
```

The middleware must come BEFORE the health router so `/healthz` is the only path that bypasses it (and even then, the middleware itself exempts `/healthz`, so the order is functionally equivalent — this just makes the global stance "allowlist first").

- [ ] **Step 4: Build.** `npm run build` — 0 errors.

- [ ] **Step 5: Run all tests.** `npm test` — 18 (v1) + 6 (scanner) + 9 (hosts) = 33 passing.

- [ ] **Step 6: Smoke test.** Run the server with no allowlist, hit `/healthz`, get 200. Then:

```bash
( unset MCP_AUTH_TOKEN; MCP_TRANSPORT=http MCP_PORT=39998 MCP_ALLOW_UNAUTHENTICATED=1 MCP_ALLOWED_HOSTS=localhost:39998 timeout 3 node dist/mcp/server.js & sleep 1
  echo "--- with correct Host ---"
  curl -s -o /dev/null -w "code=%{http_code}\n" -H "Host: localhost:39998" http://localhost:39998/healthz
  echo "--- with wrong Host (still hits /healthz, exempt) ---"
  curl -s -o /dev/null -w "code=%{http_code}\n" -H "Host: evil.example" http://localhost:39998/healthz
  echo "--- with wrong Host on /mcp ---"
  curl -s -o /dev/null -w "code=%{http_code}\n" -X POST -H "Host: evil.example" http://localhost:39998/mcp -d "{}"
  wait )
```

Expected:
- `/healthz` with correct or wrong Host → both 200 (exempt)
- `/mcp` with wrong Host → 421

If the smoke test fails, STOP and report BLOCKED.

- [ ] **Step 7: Commit.**

```bash
git add mcp/server.ts
git commit -m "feat(server): mount host allowlist before all other middleware"
```

---

## Phase C — OAuth provider

### Task C.1: In-memory store for clients and tokens (TDD)

**Files:**
- Create: `mcp/oauth/store.ts`
- Create: `mcp/oauth/store.test.ts`

The store handles two related concerns: (1) registered OAuth clients (DCR), and (2) issued tokens + their bindings to authorization codes for PKCE. Keep them in one file for cohesion; split if it ever grows past ~200 LOC.

- [ ] **Step 1: Write failing tests.** Create `mcp/oauth/store.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InMemoryStore } from "./store";

let store: InMemoryStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
  store = new InMemoryStore();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("InMemoryStore — clients (DCR)", () => {
  it("registers a client and returns it by ID", async () => {
    const client = await store.registerClient({ redirect_uris: ["https://claude.ai/cb"], client_name: "Claude" });
    expect(client.client_id).toBeTruthy();
    expect(await store.getClient(client.client_id)).toEqual(client);
  });

  it("returns undefined for unknown client_id", async () => {
    expect(await store.getClient("nope")).toBeUndefined();
  });
});

describe("InMemoryStore — authorization codes", () => {
  it("stores and retrieves a code with PKCE binding", () => {
    store.putAuthCode("code-1", { clientId: "c1", redirectUri: "u", codeChallenge: "ch", expiresAt: Date.now() + 60_000 });
    const c = store.getAuthCode("code-1");
    expect(c?.codeChallenge).toBe("ch");
  });

  it("returns undefined for expired codes", () => {
    store.putAuthCode("code-2", { clientId: "c1", redirectUri: "u", codeChallenge: "ch", expiresAt: Date.now() - 1 });
    expect(store.getAuthCode("code-2")).toBeUndefined();
  });

  it("consume removes the code after retrieval (single-use)", () => {
    store.putAuthCode("code-3", { clientId: "c1", redirectUri: "u", codeChallenge: "ch", expiresAt: Date.now() + 60_000 });
    expect(store.consumeAuthCode("code-3")).toBeTruthy();
    expect(store.consumeAuthCode("code-3")).toBeUndefined();
  });
});

describe("InMemoryStore — tokens", () => {
  it("issues access + refresh tokens and verifies access", () => {
    const t = store.issueTokens({ clientId: "c1" });
    expect(t.access_token).toBeTruthy();
    expect(t.refresh_token).toBeTruthy();
    expect(t.token_type).toBe("Bearer");
    const info = store.verifyAccessToken(t.access_token);
    expect(info?.clientId).toBe("c1");
  });

  it("returns undefined when verifying expired access token", () => {
    const t = store.issueTokens({ clientId: "c1" });
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // 31 days
    expect(store.verifyAccessToken(t.access_token)).toBeUndefined();
  });

  it("refresh exchanges a refresh token for a new access token (rotates)", () => {
    const t = store.issueTokens({ clientId: "c1" });
    const r = store.refreshTokens(t.refresh_token);
    expect(r?.access_token).toBeTruthy();
    expect(r?.access_token).not.toBe(t.access_token);
    // Old refresh is invalidated
    expect(store.refreshTokens(t.refresh_token)).toBeUndefined();
  });

  it("revokeAccessToken makes verify return undefined", () => {
    const t = store.issueTokens({ clientId: "c1" });
    store.revokeToken(t.access_token);
    expect(store.verifyAccessToken(t.access_token)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify fail.** `npx vitest run mcp/oauth/store.test.ts` — module not found.

- [ ] **Step 3: Implement `mcp/oauth/store.ts`.**

```ts
import { randomBytes } from "node:crypto";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days

export interface AuthCodeRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod?: string;
  scopes?: string[];
  resource?: string;
  expiresAt: number;
}

interface AccessRecord {
  clientId: string;
  scopes?: string[];
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  scopes?: string[];
  expiresAt: number;
}

function rand(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export class InMemoryStore {
  private clients = new Map<string, OAuthClientInformationFull>();
  private codes = new Map<string, AuthCodeRecord>();
  private access = new Map<string, AccessRecord>();
  private refresh = new Map<string, RefreshRecord>();

  // ---- DCR ----
  async registerClient(meta: Partial<OAuthClientInformationFull>): Promise<OAuthClientInformationFull> {
    const client_id = rand(16);
    const client: OAuthClientInformationFull = {
      client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...meta,
    } as OAuthClientInformationFull;
    this.clients.set(client_id, client);
    return client;
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.clients.get(clientId);
  }

  // ---- Authorization codes ----
  putAuthCode(code: string, rec: AuthCodeRecord): void {
    this.codes.set(code, rec);
  }

  getAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.codes.get(code);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.codes.delete(code);
      return undefined;
    }
    return rec;
  }

  consumeAuthCode(code: string): AuthCodeRecord | undefined {
    const rec = this.getAuthCode(code);
    if (rec) this.codes.delete(code);
    return rec;
  }

  // ---- Tokens ----
  issueTokens(opts: { clientId: string; scopes?: string[] }): OAuthTokens {
    const access_token = rand();
    const refresh_token = rand();
    const now = Date.now();
    this.access.set(access_token, {
      clientId: opts.clientId,
      scopes: opts.scopes,
      expiresAt: now + ACCESS_TTL_MS,
    });
    this.refresh.set(refresh_token, {
      clientId: opts.clientId,
      scopes: opts.scopes,
      expiresAt: now + REFRESH_TTL_MS,
    });
    return {
      access_token,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token,
      scope: opts.scopes?.join(" "),
    };
  }

  verifyAccessToken(token: string): { clientId: string; scopes?: string[] } | undefined {
    const rec = this.access.get(token);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.access.delete(token);
      return undefined;
    }
    return { clientId: rec.clientId, scopes: rec.scopes };
  }

  refreshTokens(refreshToken: string): OAuthTokens | undefined {
    const rec = this.refresh.get(refreshToken);
    if (!rec) return undefined;
    if (Date.now() > rec.expiresAt) {
      this.refresh.delete(refreshToken);
      return undefined;
    }
    // Rotate: invalidate old refresh, issue new pair
    this.refresh.delete(refreshToken);
    return this.issueTokens({ clientId: rec.clientId, scopes: rec.scopes });
  }

  revokeToken(token: string): void {
    this.access.delete(token);
    this.refresh.delete(token);
  }
}
```

- [ ] **Step 4: Verify pass.** `npx vitest run mcp/oauth/store.test.ts` — 10 tests pass.

- [ ] **Step 5: Commit.**

```bash
mkdir -p mcp/oauth
git add mcp/oauth/store.ts mcp/oauth/store.test.ts
git commit -m "feat(oauth): in-memory store for clients, codes, and tokens"
```

---

### Task C.2: Consent-page renderer (TDD)

**Files:**
- Create: `mcp/oauth/consent-page.ts`
- Create: `mcp/oauth/consent-page.test.ts`

The consent page is the HTML the user sees on `/authorize`. It MUST:
- Display the client name (from the registered DCR record)
- Have a single password field for the bearer token
- POST back to `/authorize` (same path) with `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, `scope`, `resource`, plus the submitted bearer
- Be clean enough for mobile (no JS required)
- HTML-escape all dynamic values

- [ ] **Step 1: Write failing tests.** Create `mcp/oauth/consent-page.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderConsentPage, escapeHtml } from "./consent-page";

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("renderConsentPage", () => {
  it("contains the client name escaped", () => {
    const html = renderConsentPage({
      clientName: '<script>alert(1)</script>',
      hiddenParams: { client_id: "abc" },
      errorMessage: undefined,
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("includes a hidden input for each param", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: { client_id: "c1", state: "s", code_challenge: "ch" },
      errorMessage: undefined,
    });
    expect(html).toContain('name="client_id" value="c1"');
    expect(html).toContain('name="state" value="s"');
    expect(html).toContain('name="code_challenge" value="ch"');
  });

  it("renders an error message when provided", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: "Invalid token",
    });
    expect(html).toContain("Invalid token");
  });

  it("does not render the error <p> block when errorMessage is undefined", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).not.toMatch(/<p[^>]*class="error"/);
    expect(html).not.toContain("Invalid token");
  });

  it("posts to /authorize", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).toContain('action="/authorize"');
    expect(html).toContain('method="post"');
  });

  it("has a password input named 'bearer_token'", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).toContain('name="bearer_token"');
    expect(html).toContain('type="password"');
  });
});
```

- [ ] **Step 2: Verify fail.** `npx vitest run mcp/oauth/consent-page.test.ts` — module not found.

- [ ] **Step 3: Implement `mcp/oauth/consent-page.ts`.**

```ts
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ConsentPageOptions {
  clientName: string;
  hiddenParams: Record<string, string>;
  errorMessage: string | undefined;
}

export function renderConsentPage(opts: ConsentPageOptions): string {
  const hidden = Object.entries(opts.hiddenParams)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n        ");

  const errorBlock = opts.errorMessage
    ? `<p class="error">${escapeHtml(opts.errorMessage)}</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Authorize — vault-search</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .client { font-weight: 600; }
    label { display: block; margin-top: 1.5rem; font-weight: 600; }
    input[type=password] { width: 100%; padding: 0.6rem; font-size: 1rem; border: 1px solid #999; border-radius: 6px; box-sizing: border-box; }
    button { margin-top: 1rem; padding: 0.6rem 1rem; font-size: 1rem; background: #111; color: #fff; border: 0; border-radius: 6px; cursor: pointer; }
    .error { color: #b00; margin-top: 1rem; }
    .help { color: #666; font-size: 0.9rem; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Authorize <span class="client">${escapeHtml(opts.clientName)}</span></h1>
  <p>This client is requesting access to your Obsidian vault search. Approve by entering your <code>MCP_AUTH_TOKEN</code> below.</p>
  ${errorBlock}
  <form action="/authorize" method="post">
        ${hidden}
    <label for="bearer_token">Bearer token</label>
    <input id="bearer_token" name="bearer_token" type="password" autocomplete="off" required>
    <p class="help">Paste the value of <code>MCP_AUTH_TOKEN</code> from your server's <code>.env</code>.</p>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}
```

- [ ] **Step 4: Verify pass.** `npx vitest run mcp/oauth/consent-page.test.ts` — 7 tests pass.

- [ ] **Step 5: Commit.**

```bash
git add mcp/oauth/consent-page.ts mcp/oauth/consent-page.test.ts
git commit -m "feat(oauth): consent-page renderer with HTML escaping"
```

---

### Task C.3: `OAuthServerProvider` implementation (TDD)

**Files:**
- Create: `mcp/oauth/provider.ts`
- Create: `mcp/oauth/provider.test.ts`
- Create: `mcp/oauth/index.ts` (barrel export)

This is the largest task in the plan. The provider implements the SDK's `OAuthServerProvider` interface using the in-memory store.

The flow it must implement:
1. **`authorize`** — Called when a client hits `/authorize`. The SDK has already validated the client, parsed the params, and called us with a `Response` object. Our job: render the consent page and let the user POST back. We attach a body-parser at the `mcpAuthRouter` level (the SDK does this), and after the user submits, the SDK calls `authorize` AGAIN with the form-merged params. To distinguish first-render from form-submit, we look at the request body's `bearer_token` field. If present, validate; if valid, issue a code and redirect; if invalid, re-render with error. If absent, render the form.
2. **`exchangeAuthorizationCode`** — Validate code+PKCE, issue tokens.
3. **`exchangeRefreshToken`** — Rotate refresh token, issue new access.
4. **`verifyAccessToken`** — Look up in store.
5. **`revokeToken`** — Remove from store.

Note on PKCE: we use the SDK's local validation by NOT setting `skipLocalPkceValidation`, so the SDK calls `challengeForAuthorizationCode` and compares for us. We just need to store the challenge alongside the code.

- [ ] **Step 1: Write failing tests.** Create `mcp/oauth/provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { createOAuthProvider } from "./provider";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let sent = "";
  let redirectedTo: string | undefined;
  const res = {
    statusCode,
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    set: vi.fn((k: string, v: string) => { headers[k] = v; }),
    status: vi.fn((c: number) => { statusCode = c; (res as any).statusCode = c; return res; }),
    send: vi.fn((s: string) => { sent = s; return res; }),
    redirect: vi.fn((url: string) => { redirectedTo = url; return res; }),
    headers,
    sent: () => sent,
    redirectedTo: () => redirectedTo,
    getStatus: () => statusCode,
  } as unknown as Response & { sent: () => string; redirectedTo: () => string | undefined; getStatus: () => number };
  return res;
}

const FAKE_CLIENT: OAuthClientInformationFull = {
  client_id: "test-client",
  client_id_issued_at: Math.floor(Date.now() / 1000),
  client_name: "Claude",
  redirect_uris: ["https://claude.ai/cb"],
} as OAuthClientInformationFull;

const PKCE_VERIFIER = "x".repeat(43); // valid PKCE verifier length
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

describe("OAuthProvider — authorize", () => {
  it("renders consent page on first visit (no bearer in body)", async () => {
    const provider = createOAuthProvider({ expectedBearer: TOKEN });
    await provider.clientsStore.registerClient!(FAKE_CLIENT);
    const res = makeRes();
    const req = { body: {}, query: {} } as unknown as Request;
    await provider.authorize(FAKE_CLIENT, {
      codeChallenge: PKCE_CHALLENGE,
      redirectUri: "https://claude.ai/cb",
      state: "s1",
    }, res, req);
    expect(res.getStatus()).toBe(200);
    expect(res.sent()).toContain("name=\"bearer_token\"");
    expect(res.sent()).toContain("Claude");
  });

  it("rejects bad bearer with 401 and re-renders with error", async () => {
    const provider = createOAuthProvider({ expectedBearer: TOKEN });
    await provider.clientsStore.registerClient!(FAKE_CLIENT);
    const res = makeRes();
    const req = { body: { bearer_token: "wrong" }, query: {} } as unknown as Request;
    await provider.authorize(FAKE_CLIENT, {
      codeChallenge: PKCE_CHALLENGE,
      redirectUri: "https://claude.ai/cb",
      state: "s1",
    }, res, req);
    expect(res.getStatus()).toBe(401);
    expect(res.sent()).toContain("Invalid token");
  });

  it("on valid bearer, redirects to redirect_uri with code+state", async () => {
    const provider = createOAuthProvider({ expectedBearer: TOKEN });
    await provider.clientsStore.registerClient!(FAKE_CLIENT);
    const res = makeRes();
    const req = { body: { bearer_token: TOKEN }, query: {} } as unknown as Request;
    await provider.authorize(FAKE_CLIENT, {
      codeChallenge: PKCE_CHALLENGE,
      redirectUri: "https://claude.ai/cb",
      state: "s1",
    }, res, req);
    const url = res.redirectedTo();
    expect(url).toBeTruthy();
    expect(url!).toContain("https://claude.ai/cb?");
    expect(url!).toContain("state=s1");
    expect(url!).toMatch(/code=[A-Za-z0-9_-]+/);
  });
});

describe("OAuthProvider — exchange + verify", () => {
  let provider: ReturnType<typeof createOAuthProvider>;
  let issuedCode: string;

  beforeEach(async () => {
    provider = createOAuthProvider({ expectedBearer: TOKEN });
    await provider.clientsStore.registerClient!(FAKE_CLIENT);
    const res = makeRes();
    const req = { body: { bearer_token: TOKEN }, query: {} } as unknown as Request;
    await provider.authorize(FAKE_CLIENT, {
      codeChallenge: PKCE_CHALLENGE,
      redirectUri: "https://claude.ai/cb",
      state: "s1",
    }, res, req);
    const url = new URL(res.redirectedTo()!);
    issuedCode = url.searchParams.get("code")!;
  });

  it("challengeForAuthorizationCode returns the stored challenge", async () => {
    const ch = await provider.challengeForAuthorizationCode(FAKE_CLIENT, issuedCode);
    expect(ch).toBe(PKCE_CHALLENGE);
  });

  it("exchangeAuthorizationCode returns access + refresh", async () => {
    const tokens = await provider.exchangeAuthorizationCode(FAKE_CLIENT, issuedCode, PKCE_VERIFIER, "https://claude.ai/cb");
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info.clientId).toBe(FAKE_CLIENT.client_id);
  });

  it("exchanging the same code twice fails", async () => {
    await provider.exchangeAuthorizationCode(FAKE_CLIENT, issuedCode, PKCE_VERIFIER, "https://claude.ai/cb");
    await expect(
      provider.exchangeAuthorizationCode(FAKE_CLIENT, issuedCode, PKCE_VERIFIER, "https://claude.ai/cb")
    ).rejects.toThrow();
  });

  it("verifyAccessToken throws on unknown token", async () => {
    await expect(provider.verifyAccessToken("nope")).rejects.toThrow();
  });

  it("revokeToken removes the token", async () => {
    const tokens = await provider.exchangeAuthorizationCode(FAKE_CLIENT, issuedCode, PKCE_VERIFIER, "https://claude.ai/cb");
    await provider.revokeToken!(FAKE_CLIENT, { token: tokens.access_token });
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
  });

  it("exchangeRefreshToken rotates", async () => {
    const tokens = await provider.exchangeAuthorizationCode(FAKE_CLIENT, issuedCode, PKCE_VERIFIER, "https://claude.ai/cb");
    const refreshed = await provider.exchangeRefreshToken(FAKE_CLIENT, tokens.refresh_token);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });
});
```

- [ ] **Step 2: Verify fail.** `npx vitest run mcp/oauth/provider.test.ts` — module not found.

- [ ] **Step 3: Implement `mcp/oauth/provider.ts`.**

```ts
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InMemoryStore } from "./store";
import { renderConsentPage } from "./consent-page";

const CODE_TTL_MS = 5 * 60 * 1000; // 5 min — RFC recommended

interface CreateProviderOptions {
  expectedBearer: string;
  store?: InMemoryStore; // injectable for tests
}

export interface OAuthProvider extends OAuthServerProvider {
  // narrow: clientsStore on InMemoryStore is awaitable
  clientsStore: OAuthRegisteredClientsStore;
  authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response, req?: Request): Promise<void>;
}

function constantTimeMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function rand(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function createOAuthProvider(opts: CreateProviderOptions): OAuthProvider {
  if (!opts.expectedBearer) {
    throw new Error("createOAuthProvider: expectedBearer required");
  }
  const store = opts.store ?? new InMemoryStore();

  const clientsStore: OAuthRegisteredClientsStore = {
    getClient: (id) => store.getClient(id),
    registerClient: (info) => store.registerClient(info),
  };

  const provider: OAuthProvider = {
    clientsStore,

    async authorize(client, params, res, req) {
      const submitted = (req?.body as Record<string, unknown> | undefined)?.bearer_token;
      const isFormSubmit = typeof submitted === "string" && submitted.length > 0;

      if (!isFormSubmit) {
        // First visit — render consent page.
        const html = renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          hiddenParams: hiddenParamsFrom(params),
          errorMessage: undefined,
        });
        res.set("Content-Type", "text/html; charset=utf-8");
        res.status(200).send(html);
        return;
      }

      // Form submit — validate.
      if (!constantTimeMatch(submitted as string, opts.expectedBearer)) {
        const html = renderConsentPage({
          clientName: client.client_name ?? client.client_id,
          hiddenParams: hiddenParamsFrom(params),
          errorMessage: "Invalid token",
        });
        res.set("Content-Type", "text/html; charset=utf-8");
        res.status(401).send(html);
        return;
      }

      // Issue authorization code, redirect to client.
      const code = rand();
      store.putAuthCode(code, {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes,
        resource: params.resource?.toString(),
        expiresAt: Date.now() + CODE_TTL_MS,
      });

      const url = new URL(params.redirectUri);
      url.searchParams.set("code", code);
      if (params.state) url.searchParams.set("state", params.state);
      res.redirect(url.toString());
    },

    async challengeForAuthorizationCode(_client, authorizationCode) {
      const rec = store.getAuthCode(authorizationCode);
      if (!rec) throw new Error("invalid_grant: code not found or expired");
      return rec.codeChallenge;
    },

    async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, _resource) {
      const rec = store.consumeAuthCode(authorizationCode);
      if (!rec) throw new Error("invalid_grant: code not found, expired, or already used");
      if (rec.clientId !== client.client_id) throw new Error("invalid_grant: client mismatch");
      if (redirectUri && rec.redirectUri !== redirectUri) {
        throw new Error("invalid_grant: redirect_uri mismatch");
      }
      return store.issueTokens({ clientId: client.client_id, scopes: rec.scopes });
    },

    async exchangeRefreshToken(client, refreshToken, scopes, _resource) {
      const tokens = store.refreshTokens(refreshToken);
      if (!tokens) throw new Error("invalid_grant: refresh token invalid or expired");
      // Optional scope narrowing — ignored if scopes is undefined
      void scopes;
      void client;
      return tokens;
    },

    async verifyAccessToken(token) {
      const rec = store.verifyAccessToken(token);
      if (!rec) throw new Error("invalid_token");
      const info: AuthInfo = {
        token,
        clientId: rec.clientId,
        scopes: rec.scopes ?? [],
      };
      return info;
    },

    async revokeToken(_client, request: OAuthTokenRevocationRequest) {
      store.revokeToken(request.token);
    },
  };

  return provider;
}

function hiddenParamsFrom(params: AuthorizationParams): Record<string, string> {
  const out: Record<string, string> = {
    code_challenge: params.codeChallenge,
    redirect_uri: params.redirectUri,
  };
  if (params.state) out.state = params.state;
  if (params.scopes) out.scope = params.scopes.join(" ");
  if (params.resource) out.resource = params.resource.toString();
  return out;
}
```

Note on the `req` parameter: the SDK's `OAuthServerProvider.authorize` signature does NOT include `req`. We extend it via the local `OAuthProvider` interface. To make the SDK pass us the request, we'll need to wrap the `mcpAuthRouter` mount in Task C.4 — see that task for details.

- [ ] **Step 4: Implement `mcp/oauth/index.ts`** (barrel for cleaner imports):

```ts
export { createOAuthProvider } from "./provider";
export type { OAuthProvider } from "./provider";
export { InMemoryStore } from "./store";
```

- [ ] **Step 5: Verify pass.** `npx vitest run mcp/oauth/provider.test.ts` — 9 tests pass.

- [ ] **Step 6: Run full suite.** `npm test` — 33 (Phases A+B) + 10 (store) + 7 (consent-page) + 9 (provider) = 59 passing.

- [ ] **Step 7: Build.** `npm run build` — 0 errors.

- [ ] **Step 8: Commit.**

```bash
git add mcp/oauth/provider.ts mcp/oauth/provider.test.ts mcp/oauth/index.ts
git commit -m "feat(oauth): OAuthServerProvider with bearer-gated consent and PKCE"
```

---

### Task C.4: Wire `mcpAuthRouter` into the server

**Files:**
- Modify: `mcp/server.ts`

This wires the SDK's auth router into the express app. The SDK's `mcpAuthRouter` mounts the `/authorize`, `/token`, `/register`, `/revoke`, and `/.well-known/oauth-authorization-server` routes. The SDK's `bearerAuth` middleware (from `@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js`) replaces our custom one on `/mcp`.

There's one wrinkle: the SDK's `authorize` signature on `OAuthServerProvider` does NOT pass the `Request`. We need the request body to read the `bearer_token` field. The simplest workaround is a small per-request middleware that stashes `req` in an `AsyncLocalStorage`-style holder OR — simpler — wraps the SDK's authorize handler so we can pass `req` through.

The cleanest approach for our scope: write a tiny custom middleware mounted at `/authorize` BEFORE `mcpAuthRouter` that captures `req` into a per-request closure, and have our provider read from that closure. We use a `WeakMap<Response, Request>` keyed by `res` (which the SDK passes through to `authorize`):

- [ ] **Step 1: Add a request-stash file** — `mcp/oauth/request-stash.ts`:

```ts
import type { Request, Response } from "express";

const stash = new WeakMap<Response, Request>();

export function stashRequest(req: Request, res: Response): void {
  stash.set(res, req);
}

export function getStashedRequest(res: Response): Request | undefined {
  return stash.get(res);
}
```

- [ ] **Step 2: Add the stash middleware test** — `mcp/oauth/request-stash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { stashRequest, getStashedRequest } from "./request-stash";

describe("request-stash", () => {
  it("stores and retrieves the request keyed by response", () => {
    const req = {} as Request;
    const res = {} as Response;
    stashRequest(req, res);
    expect(getStashedRequest(res)).toBe(req);
  });

  it("returns undefined for unknown response", () => {
    expect(getStashedRequest({} as Response)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Verify stash tests pass.** `npx vitest run mcp/oauth/request-stash.test.ts` — 2 tests pass.

- [ ] **Step 4: Update `provider.ts` to read from the stash.** Modify the `authorize` method in `mcp/oauth/provider.ts` so the `req` parameter becomes optional and falls back to the stash:

```ts
import { getStashedRequest } from "./request-stash";

// Inside createOAuthProvider, replace authorize signature:
async authorize(client, params, res, req) {
  const actualReq = req ?? getStashedRequest(res);
  const submitted = (actualReq?.body as Record<string, unknown> | undefined)?.bearer_token;
  // ... rest unchanged
}
```

Update `provider.test.ts` if needed — the existing tests pass `req` directly, so they continue to work. Add one more test that uses the stash:

```ts
import { stashRequest } from "./request-stash";

it("uses stashed request when req argument is absent", async () => {
  const provider = createOAuthProvider({ expectedBearer: TOKEN });
  await provider.clientsStore.registerClient!(FAKE_CLIENT);
  const res = makeRes();
  const req = { body: { bearer_token: TOKEN }, query: {} } as unknown as Request;
  stashRequest(req, res);
  await provider.authorize(FAKE_CLIENT, {
    codeChallenge: PKCE_CHALLENGE,
    redirectUri: "https://claude.ai/cb",
    state: "s1",
  }, res /* no req arg */);
  expect(res.redirectedTo()).toContain("code=");
});
```

Verify all provider tests still pass: `npx vitest run mcp/oauth/provider.test.ts mcp/oauth/request-stash.test.ts` — 12 tests pass total (10 provider + 2 stash).

- [ ] **Step 5: Add the env reader + wire into `mcp/server.ts`.** At the top, alongside other imports:

```ts
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthProvider } from "./oauth";
import { stashRequest } from "./oauth/request-stash";
```

Inside `startHttp()`, after host allowlist mount and BEFORE the existing `if (authToken)` block:

```ts
const oauthIssuer = process.env.MCP_OAUTH_ISSUER;
const directBearer = process.env.MCP_DIRECT_BEARER === "1";

if (oauthIssuer && authToken && !directBearer) {
  const provider = createOAuthProvider({ expectedBearer: authToken });

  // Stash req → res so provider.authorize can read req.body without modifying SDK signatures.
  app.use("/authorize", (req, res, next) => {
    stashRequest(req, res);
    next();
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(oauthIssuer),
    resourceName: "vault-search",
  }));

  // /mcp uses the SDK's bearer auth, delegating to provider.verifyAccessToken
  app.use("/mcp", requireBearerAuth({ verifier: provider, requiredScopes: [] }));

  console.error(`OAuth issuer enabled at ${oauthIssuer}`);
} else if (authToken && directBearer) {
  // Escape hatch: simple bearer (for curl-based smoke tests)
  app.use("/mcp", bearerAuth(authToken));
  console.error("MCP_DIRECT_BEARER=1 — using simple bearer middleware on /mcp (no OAuth)");
} else if (authToken) {
  // Bearer present but no MCP_OAUTH_ISSUER: error out — production deployments must have an issuer.
  throw new Error(
    "MCP_AUTH_TOKEN is set but MCP_OAUTH_ISSUER is not. " +
    "Set MCP_OAUTH_ISSUER to your public HTTPS URL, " +
    "or set MCP_DIRECT_BEARER=1 to disable OAuth and use bearer-only (curl smoke testing)."
  );
} else if (process.env.MCP_ALLOW_UNAUTHENTICATED === "1") {
  console.error("WARNING: running HTTP transport without auth (MCP_ALLOW_UNAUTHENTICATED=1)");
} else {
  throw new Error(
    "MCP_AUTH_TOKEN is required for HTTP transport. " +
    "Set MCP_AUTH_TOKEN, or set MCP_ALLOW_UNAUTHENTICATED=1 to opt in to running unauthenticated."
  );
}
```

Remove the old standalone `if (authToken) { app.use("/mcp", bearerAuth(authToken)); ...` block (the new conditional supersedes it) — but make sure any code AFTER it (the `/debug/recent` registration) still runs. Move the `/debug/recent` registration outside the auth conditional, but only register it when `authToken` is truthy:

```ts
if (authToken) {
  app.get("/debug/recent", bearerAuth(authToken), (_req, res) => {
    res.json(recentRing.snapshot());
  });
}
```

Note: `/debug/recent` continues to use the SIMPLE bearer (`bearerAuth(authToken)`) directly — not the OAuth bearer — because it's an admin/debugging endpoint and should be protected by the master credential, not by client-issued OAuth tokens.

- [ ] **Step 6: Build.** `npm run build` — 0 errors. If `requireBearerAuth` import path is different in your installed SDK version, find it via:

```bash
grep -rE "export.*requireBearerAuth|export default.*BearerAuth" node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/middleware/ | head
```

and adjust the import.

- [ ] **Step 7: Smoke test the OAuth flow.** Start the server with OAuth enabled:

```bash
TOKEN=$(grep ^MCP_AUTH_TOKEN= .env | cut -d= -f2)
( MCP_TRANSPORT=http MCP_PORT=39998 \
  MCP_OAUTH_ISSUER=http://localhost:39998 \
  MCP_AUTH_TOKEN=$TOKEN \
  MCP_ALLOWED_HOSTS=localhost:39998 \
  timeout 5 node dist/mcp/server.js & sleep 1
  echo "--- discovery ---"
  curl -s -H "Host: localhost:39998" http://localhost:39998/.well-known/oauth-authorization-server | head -c 500 ; echo
  echo "--- DCR ---"
  CLIENT=$(curl -s -X POST -H "Host: localhost:39998" -H "Content-Type: application/json" \
    -d '{"client_name":"smoke","redirect_uris":["http://localhost:9999/cb"],"token_endpoint_auth_method":"none"}' \
    http://localhost:39998/register)
  echo "$CLIENT" | head -c 500 ; echo
  CLIENT_ID=$(echo "$CLIENT" | grep -oE '"client_id":"[^"]+"' | sed 's/.*"\([^"]*\)"$/\1/')
  echo "client_id=$CLIENT_ID"
  echo "--- /authorize first hit (expect HTML) ---"
  curl -s -H "Host: localhost:39998" "http://localhost:39998/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A9999%2Fcb&code_challenge=challenge&code_challenge_method=plain&state=s" | head -c 400 ; echo
  wait )
```

Expected:
- discovery returns JSON with `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`
- DCR returns JSON with `client_id`
- /authorize first hit returns HTML containing `name="bearer_token"`

If any of these fail, STOP and report BLOCKED with curl output. Do not commit.

- [ ] **Step 8: Run all unit tests.** `npm test` — 59 (Phases A/B/C.1-3) + 2 (request-stash) + 1 (provider stash test) = 62 passing.

- [ ] **Step 9: Commit.**

```bash
git add mcp/server.ts mcp/oauth/provider.ts mcp/oauth/provider.test.ts mcp/oauth/request-stash.ts mcp/oauth/request-stash.test.ts
git commit -m "feat(server): wire mcpAuthRouter for OAuth+DCR; bearer becomes consent gate"
```

---

## Phase D — Sync to NAS, install Tailscale, redeploy

### Task D.1: Update runbooks

**Files:**
- Modify: `docs/superpowers/runbooks/nas-deployment.md`
- Modify: `docs/superpowers/runbooks/claude-connector.md`

- [ ] **Step 1: Update `nas-deployment.md`.** Append after the existing "Regression check" section:

````markdown
## v2 deployment notes (OAuth, multi-vault, host allowlist)

### Sync code from your Mac to the NAS

The NAS doesn't have `git` installed. Sync via rsync over SSH:

```bash
# from your Mac, in the project root
rsync -avz --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.env' \
  --exclude='.worktrees' \
  ./ jpaters0n@192.168.1.65:vault-search/
```

After sync, on the NAS run `npm install --omit=dev=false` (yes, dev included — Vitest is a devDep but the build step uses tsc; include dev for now to keep things simple) and `npm run build`. Or rely on `docker compose up --build` to rebuild the container, which runs `npm install` + `npm run build` inside.

### `.env` for the NAS — additions

Generate / preserve:

```env
MCP_AUTH_TOKEN=<32-byte hex from openssl rand -hex 32>
VAULT_HOST_PATH=/var/services/homes/jpaters0n/Obsidian
DATA_HOST_PATH=/var/services/homes/jpaters0n/vault-search-data
MCP_HOST_PORT=3099
MCP_ALLOWED_HOSTS=syn-1.<tailnet>.ts.net,localhost:3099,127.0.0.1:3099
MCP_OAUTH_ISSUER=https://syn-1.<tailnet>.ts.net
```

Replace `<tailnet>` with your actual tailnet name (e.g. `tail356dbd`). Set these AFTER Tailscale Funnel is up (Phase 3) so the values are accurate.

### Multi-vault layout

`VAULT_HOST_PATH` should point to the parent directory containing one or more vault subdirectories. Example layout on the NAS:

```
/var/services/homes/jpaters0n/Obsidian/
├── ObsidianVault/
│   ├── Dashboard/
│   ├── .obsidian/      ← excluded automatically (any-depth match)
│   └── ...
└── ObsidianBookmarks/
    └── ...
```

Search results return paths prefixed with the vault subdir, e.g. `ObsidianVault/Dashboard/Note.md`.

### Bearer rotation

To rotate `MCP_AUTH_TOKEN`:

1. `openssl rand -hex 32` → new token
2. Edit `.env` on the NAS, save
3. `docker compose restart vault-search-mcp`
4. Re-paste the new token in Claude's `/authorize` consent page on next call (Claude transparently re-authorizes)

Existing OAuth access/refresh tokens persist across restart? No — the in-memory store is wiped on container restart. After rotation, every connected Claude device redoes the authorize flow once.
````

- [ ] **Step 2: Rewrite `claude-connector.md`** to use the OAuth flow. Replace the existing content with:

````markdown
# Claude Custom Connector — vault-search (OAuth)

> Goal: register the deployed MCP server as a Custom Connector in Claude.ai. Connect once on desktop; the connector auto-syncs to mobile.

## Steps

1. Open https://claude.ai on a desktop browser.

2. Settings → Connectors → "Add custom connector".

3. Fill in:
   - **Name:** `vault-search`
   - **MCP Server URL:** `https://<machine>.<tailnet>.ts.net/mcp`
   - **Authentication:** OAuth (Claude does Dynamic Client Registration automatically — no client_id/secret to paste).

4. Click Save / Connect. Claude will:
   - Fetch `/.well-known/oauth-authorization-server` for discovery.
   - POST to `/register` with its metadata (DCR).
   - Open a popup or new tab to `/authorize?...`.

5. The `/authorize` page asks for your **bearer token** (the value of `MCP_AUTH_TOKEN` from your NAS `.env`). Paste it. Click Approve.

6. Claude exchanges the authorization code for an access token. The connector becomes Active.

7. Confirm the four tools show up. In a new chat, ask: "What tools do you have for searching my vault?"

8. **From the mobile app:** open Claude on the phone, start a new chat, ensure the connector is enabled (it auto-syncs from the web settings). Ask:
   > "Search my vault for notes about science fiction novels. Show me the top 3."
   Expected: Claude calls `search_vault` and returns results.

## Re-authorization

You'll re-authorize whenever:
- The container restarts (in-memory token store is wiped).
- The refresh token expires (90 days).
- You revoke the token via the upcoming `/revoke` endpoint.

Re-authorization is a single click + paste: Claude prompts, you go to `/authorize`, paste the bearer, done.

## Troubleshooting

- **"OAuth error" on connect:** check `docker compose logs vault-search-mcp` for the request. Common causes:
  - `MCP_OAUTH_ISSUER` doesn't match your Funnel HTTPS URL exactly (must include `https://`, no trailing slash).
  - `MCP_ALLOWED_HOSTS` doesn't include the Funnel hostname.
- **"Invalid token" on /authorize:** the bearer you pasted doesn't match `MCP_AUTH_TOKEN`. Check for whitespace, copy-paste truncation.
- **Connector connects but tools fail:** check container logs for the actual `/mcp` request. Often a 421 (host mismatch).

## Tool description tuning

If Claude doesn't reliably pick the right tool, edit the `description` strings in `mcp/server.ts` (the second argument to `server.tool(...)` calls), redeploy with rsync + rebuild.

## Curl-based smoke testing without OAuth

For local development or scripted testing, set `MCP_DIRECT_BEARER=1` in the env. The OAuth flow is bypassed and `/mcp` accepts the simple `Authorization: Bearer <MCP_AUTH_TOKEN>` directly. **Never set this in production** — Claude.ai's connector won't work without OAuth.
````

- [ ] **Step 3: Commit.**

```bash
git add docs/superpowers/runbooks/nas-deployment.md docs/superpowers/runbooks/claude-connector.md
git commit -m "docs(runbooks): v2 — rsync sync, OAuth env, OAuth-flow connector setup"
```

---

### Task D.2: User-driven NAS deployment

**Files:** none. Operational task.

- [ ] **Step 1:** Walk the v2 section of `nas-deployment.md`. Specifically:
  - rsync new code to the NAS
  - Update `.env` with the new vars (still leaving `MCP_OAUTH_ISSUER` blank if Funnel isn't up yet)
  - `docker compose down && docker compose up -d --build` to redeploy with new code

- [ ] **Step 2: Local sanity check** — set `MCP_DIRECT_BEARER=1` temporarily on the NAS, verify `/mcp` still works with curl. Then unset and proceed.

- [ ] **Step 3:** Confirm `docker compose logs vault-search-mcp` shows the OAuth-required error (because `MCP_OAUTH_ISSUER` isn't set yet). That's expected — you can't enable OAuth without a public URL, and you can't get a public URL without Funnel. Continue to Task D.3.

---

### Task D.3: User-driven Tailscale Funnel setup

**Files:** none. Operational task.

- [ ] **Step 1:** Install Tailscale on the NAS:
  - DSM → Package Center → search "Tailscale" → install. Sign in with the same account that has the existing `tail356dbd` tailnet.

- [ ] **Step 2:** Walk `docs/superpowers/runbooks/tailscale-funnel.md` (committed in v1; still applies).

- [ ] **Step 3:** Verify from cellular: `https://<machine>.<tailnet>.ts.net/healthz` returns 200.

- [ ] **Step 4:** SSH back to the NAS, edit `.env`:
  ```
  MCP_OAUTH_ISSUER=https://<machine>.<tailnet>.ts.net
  MCP_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net,localhost:3099,127.0.0.1:3099
  ```
  Then `docker compose restart vault-search-mcp`. The startup logs should now say `OAuth issuer enabled at https://...`.

- [ ] **Step 5:** Verify discovery from cellular:
  ```
  curl -s https://<machine>.<tailnet>.ts.net/.well-known/oauth-authorization-server | jq .
  ```
  Expected: JSON with `issuer`, `authorization_endpoint`, `token_endpoint`, `registration_endpoint`.

---

### Task D.4: User-driven Claude Custom Connector setup

**Files:** none. Operational task.

- [ ] **Step 1:** Walk `docs/superpowers/runbooks/claude-connector.md` (rewritten in Task D.1).

- [ ] **Step 2:** From the phone over cellular, run at least 5 different real queries.

- [ ] **Step 3:** If any tool selection failures observed, edit tool descriptions in `mcp/server.ts`, rsync, rebuild.

---

## Self-review checklist

- [ ] `npm test` passes (62+ tests).
- [ ] `git status` clean except `.env`, `dist/*` (build artifacts), `node_modules/*` (already-tracked churn).
- [ ] `MCP_AUTH_TOKEN` value is NOT present in any committed file (`git grep MCP_AUTH_TOKEN -- ':!.env.example'` should only show env var references).
- [ ] OAuth discovery endpoint returns valid metadata over Funnel.
- [ ] Authorize page renders on cellular and accepts bearer.
- [ ] Claude mobile completes a real query end-to-end.
- [ ] `/healthz` is 200 from cellular regardless of `MCP_ALLOWED_HOSTS`.
- [ ] `/mcp` is 421 from cellular when sending a non-allowed Host header.
- [ ] `/debug/recent` requires the master bearer (not the OAuth access token).

---

## Out of scope (intentionally)

- Persisting OAuth state across container restart. Re-consent on restart is acceptable for one user.
- Per-vault search filter (`vault: string` argument). Defer.
- Real third-party IdP login (Google, GitHub) via `ProxyOAuthServerProvider`. Defer.
- Token introspection endpoint (RFC 7662). Defer; not needed for first-party use.
- Refresh-token reuse detection (rotate-and-revoke-on-replay). The current refresh rotation invalidates the old token but doesn't trip-wire on replay. Defer.
- Custom CSS theming on the consent page. The minimal CSS is enough.
