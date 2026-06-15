# Remote Mobile Vault Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the vault-search MCP server on the user's Synology NAS, exposed publicly via Tailscale Funnel with bearer-token auth, and connect it to the Claude mobile app.

**Architecture:** A Docker compose stack on the NAS runs the existing MCP server (HTTP transport) alongside Ollama. The vault is mounted read-only; the index lives in a separate volume. Tailscale Funnel exposes one port over a `*.ts.net` hostname. The MCP server validates a bearer token on every `/mcp` request. The Claude mobile app uses the Custom Connector feature to reach the endpoint.

**Tech Stack:** TypeScript, Node.js 22, `@modelcontextprotocol/sdk`, Express, better-sqlite3 + sqlite-vec, Ollama (`nomic-embed-text`), Docker Compose, Tailscale, Vitest (new — added in Phase 0).

**Spec:** `docs/superpowers/specs/2026-04-30-remote-mobile-vault-search-design.md`

---

## State of the codebase entering this plan

The HTTP transport, watcher, Dockerfile, docker-compose.yml, and eval harness already exist as ~350 lines of uncommitted work on `master`. **Phase 0 is mostly verifying, hardening, and committing what's already there — not writing it from scratch.** Read each step carefully; many tasks modify existing code rather than creating it.

Two real issues found during planning that the plan addresses:

1. **The auth token is committed in plaintext in `docker-compose.yml`.** It must be rotated and moved to a `.env` file (gitignored) before Phase 0 ships.
2. **The auth check uses `!==` string comparison**, which leaks information via timing. Phase 0 swaps it to a constant-time compare.

There is currently no test framework. Phase 0 introduces Vitest.

---

## File Structure

| Path | Purpose | Status |
|---|---|---|
| `mcp/server.ts` | Stdio + HTTP entrypoint, tool registration | exists, modified across phases |
| `mcp/auth.ts` | Bearer-token middleware (extracted, testable) | new in Phase 0 |
| `mcp/auth.test.ts` | Auth middleware unit tests | new in Phase 0 |
| `mcp/health.ts` | `/healthz` handler | new in Phase 1 |
| `mcp/logging.ts` | Request logging middleware | new in Phase 1 |
| `mcp/limits.ts` | Body size + timeout middleware | new in Phase 1 |
| `src/watcher.ts` | File watcher → incremental reindex | exists, untouched by plan |
| `src/eval.ts` | Eval harness library | exists, untouched by plan |
| `src/eval-cli.ts` | CLI entrypoint for eval | new in Phase 5 |
| `eval-queries.json` | Eval ground-truth set | exists, untouched |
| `Dockerfile` | Container build | exists, untouched |
| `docker-compose.yml` | NAS deploy config | exists, modified in Phase 0 (move secret) |
| `.env.example` | Template for required env vars | new in Phase 0 |
| `.gitignore` | Ignore `.env` | modified in Phase 0 |
| `vitest.config.ts` | Test runner config | new in Phase 0 |
| `package.json` | Add test + eval scripts | modified in Phase 0 + 5 |
| `docs/superpowers/runbooks/nas-deployment.md` | Synology runbook (Phase 2) | new in Phase 2 |
| `docs/superpowers/runbooks/tailscale-funnel.md` | Funnel setup (Phase 3) | new in Phase 3 |
| `docs/superpowers/runbooks/claude-connector.md` | Custom Connector setup (Phase 4) | new in Phase 4 |

---

## Phase 0 — Land the in-flight work

### Task 0.1: Add Vitest test framework

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest @vitest/coverage-v8
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    globals: false,
  },
});
```

- [ ] **Step 3: Add `test` script to `package.json`**

In the `scripts` block, add `"test": "vitest run"` and `"test:watch": "vitest"`.

- [ ] **Step 4: Verify the framework runs**

Run: `npm test`
Expected: exits 0 with "No test files found" (no tests yet).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test framework"
```

---

### Task 0.2: Rotate the auth token and move it to a `.env` file

The existing `docker-compose.yml` contains a real bearer token in plaintext. It must be rotated (because it has been committed/shared) and moved out.

**Treat the old token as compromised.** Do not reuse it locally or on the NAS. Generate fresh tokens for both environments (different ones for dev vs. production).

**Files:**
- Modify: `docker-compose.yml`
- Create: `.env.example`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.env` to `.gitignore`**

Append to `.gitignore` (create the file if it doesn't exist):

```
.env
```

- [ ] **Step 2: Create `.env.example`**

```env
# Bearer token Claude must send as `Authorization: Bearer <token>`.
# Generate a fresh one with:  openssl rand -hex 32
MCP_AUTH_TOKEN=

# Path on the host to your Obsidian vault (read-only mounted).
VAULT_HOST_PATH=/var/services/homes/jpaters0n/ObsidianVault

# Path on the host where the search index volume lives (read-write).
DATA_HOST_PATH=/var/services/homes/jpaters0n/vault-search-data

# Public port on the host.
MCP_HOST_PORT=3099
```

- [ ] **Step 3: Update `docker-compose.yml` to use env interpolation**

Replace the `vault-search` service block so it reads:

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
    depends_on:
      - ollama
```

- [ ] **Step 4: Generate a fresh local `.env`**

```bash
cp .env.example .env
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
```

(Manually edit `.env` to keep only one `MCP_AUTH_TOKEN=...` line.)

- [ ] **Step 5: Verify compose loads the env**

Run: `docker compose config | grep -E 'MCP_AUTH_TOKEN|VAULT_PATH'`
Expected: shows the values from `.env`, with `MCP_AUTH_TOKEN` set to the new token.

- [ ] **Step 6: Commit (without the secret)**

```bash
git add .gitignore .env.example docker-compose.yml
git commit -m "fix: move MCP_AUTH_TOKEN out of docker-compose into .env"
```

Note: `git status` should show `.env` as untracked and ignored (not staged).

---

### Task 0.3: Extract auth middleware into `mcp/auth.ts` with constant-time compare

The current auth check is inline in `startHttp()` and uses `!==` (timing-leak vulnerable). Extract it and harden.

**Files:**
- Create: `mcp/auth.ts`
- Modify: `mcp/server.ts:132-152` (remove inline middleware)

- [ ] **Step 1: Write the failing tests for auth middleware**

Create `mcp/auth.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { bearerAuth } from "./auth";

function mockReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("bearerAuth", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("calls next() when token matches", () => {
    const next: NextFunction = vi.fn();
    const mw = bearerAuth(TOKEN);
    mw(mockReq(`Bearer ${TOKEN}`), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when Authorization header is missing", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is wrong", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq("Bearer wrong"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when scheme is not Bearer", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(`Basic ${TOKEN}`), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when header is malformed (no space)", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq("Bearer"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token differs in length only", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(`Bearer ${TOKEN}x`), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("throws if constructed with empty token", () => {
    expect(() => bearerAuth("")).toThrow();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run mcp/auth.test.ts`
Expected: FAIL — `Cannot find module './auth'`.

- [ ] **Step 3: Implement `mcp/auth.ts`**

Create `mcp/auth.ts`:

```ts
import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Bearer-token middleware. Returns 401 unless `Authorization: Bearer <token>`
 * matches the expected token via constant-time compare.
 */
export function bearerAuth(expectedToken: string) {
  if (!expectedToken) {
    throw new Error("bearerAuth: expectedToken must be a non-empty string");
  }
  const expected = Buffer.from(expectedToken, "utf8");

  return function (req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header || typeof header !== "string") {
      reject(res);
      return;
    }
    const idx = header.indexOf(" ");
    if (idx <= 0) {
      reject(res);
      return;
    }
    const scheme = header.slice(0, idx);
    const presented = header.slice(idx + 1);
    if (scheme !== "Bearer" || presented.length === 0) {
      reject(res);
      return;
    }
    const got = Buffer.from(presented, "utf8");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      reject(res);
      return;
    }
    next();
  };
}

function reject(res: Response): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized" },
    id: null,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run mcp/auth.test.ts`
Expected: 7 tests pass.

- [ ] **Step 5: Wire the new middleware into `mcp/server.ts`**

In `mcp/server.ts`, at the top, add the import:

```ts
import { bearerAuth } from "./auth";
```

Then replace the existing inline middleware (currently lines ~137-152, the block from `if (authToken) {` through the closing `}` and `console.error("Bearer token auth enabled")`) with:

```ts
  if (authToken) {
    app.use("/mcp", bearerAuth(authToken));
    console.error("Bearer token auth enabled");
  } else {
    console.error("WARNING: MCP_AUTH_TOKEN not set — server is unauthenticated");
  }
```

The `WARNING` line is new — make it impossible to accidentally deploy without auth.

- [ ] **Step 6: Build to confirm types still resolve**

Run: `npm run build`
Expected: exits 0 with no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add mcp/auth.ts mcp/auth.test.ts mcp/server.ts
git commit -m "refactor: extract bearer auth to dedicated module with constant-time compare"
```

---

### Task 0.4: Smoke-test the HTTP transport end-to-end with curl

Manual verification that the existing HTTP transport actually responds to MCP requests.

**Files:** none modified.

- [ ] **Step 1: Start the server in HTTP mode against your real local vault**

In one terminal:

```bash
export MCP_TRANSPORT=http
export MCP_PORT=3000
export MCP_AUTH_TOKEN=$(grep '^MCP_AUTH_TOKEN=' .env | cut -d= -f2)
export VAULT_PATH=$HOME/ObsidianVault    # or wherever your local vault lives
npm run build && node dist/mcp/server.js
```

Wait for: `vault-search MCP server started (HTTP) on port 3000`.

- [ ] **Step 2: Initialize a session**

In a second terminal:

```bash
TOKEN=$(grep '^MCP_AUTH_TOKEN=' .env | cut -d= -f2)
curl -i -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0.0.0"}}}'
```

Expected: HTTP 200, response body has `result.serverInfo.name = "vault-search"`, response headers include `mcp-session-id`. Save that session ID.

- [ ] **Step 3: List tools using that session**

```bash
SID=<paste-session-id>
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | jq '.result.tools[].name'
```

Expected: prints `"search_vault"`, `"get_similar"`, `"get_context"`, `"reindex"`.

- [ ] **Step 4: Run a search**

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_vault","arguments":{"query":"science fiction novels","limit":3}}}' | jq -r '.result.content[0].text' | jq '.[0]'
```

Expected: a JSON object with at least `filePath`, `title`, and `snippet` fields. The exact note returned will vary by vault.

- [ ] **Step 5: Verify auth rejection**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer wrong" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: `401`.

- [ ] **Step 6: Stop the server (Ctrl-C) and confirm clean shutdown**

Expected output: `Shutting down…` then process exits.

- [ ] **Step 7: No commit (manual verification only — record any failures as new tasks)**

---

### Task 0.5: Smoke-test the watcher

**Files:** none modified.

- [ ] **Step 1: Start the server in stdio mode (lighter)**

```bash
export MCP_TRANSPORT=stdio
export VAULT_PATH=/tmp/test-vault
mkdir -p /tmp/test-vault
echo "# initial" > /tmp/test-vault/note1.md
node dist/mcp/server.js
```

Wait for: `[watch] Watching /tmp/test-vault for .md changes`.

- [ ] **Step 2: In another terminal, edit a file**

```bash
echo "# updated content with rare-token-zxqwerty" >> /tmp/test-vault/note1.md
```

- [ ] **Step 3: Observe the watcher trigger**

In the server's stderr, expect within ~3 seconds: `[watch] 1 change(s) detected, running incremental index...` followed by an `[watch] Index updated:` line.

- [ ] **Step 4: Stop the server**

Ctrl-C. Confirm clean shutdown (`closeDb` runs without error).

- [ ] **Step 5: No commit (manual smoke test)**

If the watcher fires but indexing fails, file an issue in the plan to investigate before continuing.

---

## Phase 1 — Production hardening

### Task 1.1: Add `/healthz` endpoint

**Files:**
- Create: `mcp/health.ts`
- Modify: `mcp/server.ts:132-145` (mount the route before the auth middleware)

- [ ] **Step 1: Write the failing test**

Create `mcp/health.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import express from "express";
import { healthRouter } from "./health";

async function get(app: express.Express, path: string) {
  const { default: supertest } = await import("supertest");
  return supertest(app).get(path);
}

describe("healthRouter", () => {
  it("returns 200 with status=ok at /healthz", async () => {
    const app = express();
    app.use(healthRouter);
    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
```

- [ ] **Step 2: Install supertest as a dev dependency**

```bash
npm install -D supertest @types/supertest
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run mcp/health.test.ts`
Expected: FAIL — `Cannot find module './health'`.

- [ ] **Step 4: Implement `mcp/health.ts`**

```ts
import { Router } from "express";

export const healthRouter = Router();

healthRouter.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run mcp/health.test.ts`
Expected: 1 test passes.

- [ ] **Step 6: Mount the router in `mcp/server.ts`**

In `mcp/server.ts`, add the import near the other mcp imports:

```ts
import { healthRouter } from "./health";
```

Inside `startHttp()`, immediately after `const app = createMcpExpressApp();`, add:

```ts
  app.use(healthRouter);    // mounted BEFORE auth so /healthz is unauthenticated
```

- [ ] **Step 7: Verify in a running server**

Start the server (`npm run build && node dist/mcp/server.js` with `MCP_TRANSPORT=http`), then in another terminal:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/healthz
```

Expected: `200`.

- [ ] **Step 8: Commit**

```bash
git add mcp/health.ts mcp/health.test.ts mcp/server.ts package.json package-lock.json
git commit -m "feat: add unauthenticated /healthz endpoint"
```

---

### Task 1.2: Add request logging middleware

**Files:**
- Create: `mcp/logging.ts`
- Modify: `mcp/server.ts` (mount the middleware on `/mcp`)

- [ ] **Step 1: Write the failing test**

Create `mcp/logging.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestLogger } from "./logging";

function mockReq(body: unknown): Request {
  return { method: "POST", body, originalUrl: "/mcp" } as Request;
}

function mockRes() {
  const handlers: Record<string, () => void> = {};
  const res: Partial<Response> = {
    statusCode: 200,
    on: ((evt: string, cb: () => void) => {
      handlers[evt] = cb;
      return res as Response;
    }) as Response["on"],
  };
  return { res: res as Response, fire: (evt: string) => handlers[evt]?.() };
}

describe("requestLogger", () => {
  it("logs method, tool name, status, and latency on response finish", () => {
    const log = vi.fn();
    const next: NextFunction = vi.fn();
    const { res, fire } = mockRes();

    requestLogger({ log })(
      mockReq({ method: "tools/call", params: { name: "search_vault" } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
    fire("finish");

    expect(log).toHaveBeenCalledOnce();
    const entry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.method).toBe("POST");
    expect(entry.mcpMethod).toBe("tools/call");
    expect(entry.toolName).toBe("search_vault");
    expect(entry.status).toBe(200);
    expect(typeof entry.latencyMs).toBe("number");
  });

  it("does not include query content", () => {
    const log = vi.fn();
    const next: NextFunction = vi.fn();
    const { res, fire } = mockRes();
    requestLogger({ log })(
      mockReq({
        method: "tools/call",
        params: { name: "search_vault", arguments: { query: "secret stuff" } },
      }),
      res,
      next,
    );
    fire("finish");
    const json = JSON.stringify(log.mock.calls[0][0]);
    expect(json).not.toContain("secret stuff");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run mcp/logging.test.ts`
Expected: FAIL — `Cannot find module './logging'`.

- [ ] **Step 3: Implement `mcp/logging.ts`**

```ts
import type { Request, Response, NextFunction } from "express";

export interface LogEntry {
  ts: string;
  method: string;
  url: string;
  mcpMethod?: string;
  toolName?: string;
  status: number;
  latencyMs: number;
}

export function requestLogger(opts: { log?: (entry: LogEntry) => void } = {}) {
  const log = opts.log ?? ((entry) => console.error(JSON.stringify(entry)));

  return function (req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const mcpMethod = typeof body?.method === "string" ? body.method : undefined;
    const toolName = typeof body?.params?.name === "string" ? body.params.name : undefined;

    res.on("finish", () => {
      log({
        ts: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        mcpMethod,
        toolName,
        status: res.statusCode,
        latencyMs: Date.now() - start,
      });
    });
    next();
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run mcp/logging.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Mount in `mcp/server.ts`**

Add the import:

```ts
import { requestLogger } from "./logging";
```

Inside `startHttp()`, mount it on `/mcp` *after* the body-parser is set up by `createMcpExpressApp` but *before* the auth middleware so that 401s are also logged. The existing flow is:

```ts
const app = createMcpExpressApp();
app.use(healthRouter);
// NEW:
app.use("/mcp", requestLogger());
if (authToken) {
  app.use("/mcp", bearerAuth(authToken));
  // ...
}
```

- [ ] **Step 6: Verify it runs**

Start the server, hit `/mcp` with a valid request, observe a JSON log line on stderr.

- [ ] **Step 7: Commit**

```bash
git add mcp/logging.ts mcp/logging.test.ts mcp/server.ts
git commit -m "feat: add request-logging middleware (no query content)"
```

---

### Task 1.3: Add request body-size and timeout limits

**Files:**
- Create: `mcp/limits.ts`
- Modify: `mcp/server.ts` (mount before auth)

- [ ] **Step 1: Write the failing tests**

Create `mcp/limits.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestTimeout } from "./limits";

describe("requestTimeout", () => {
  it("calls next() immediately and does not interfere on fast requests", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    requestTimeout(5000)({} as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns 504 if the request exceeds the timeout", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    requestTimeout(1000)({} as Request, res, next);
    vi.advanceTimersByTime(1001);
    expect(res.status).toHaveBeenCalledWith(504);
    vi.useRealTimers();
  });

  it("does nothing if headers were already sent before the timeout fires", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: true, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
    requestTimeout(1000)({} as Request, res, next);
    vi.advanceTimersByTime(1001);
    expect(res.status).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mcp/limits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp/limits.ts`**

```ts
import type { Request, Response, NextFunction } from "express";
import express from "express";

/** Per-request timeout. Returns 504 if a response hasn't been sent in time. */
export function requestTimeout(ms: number) {
  return function (_req: Request, res: Response, next: NextFunction): void {
    const t = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Request timeout" },
          id: null,
        });
      }
    }, ms);
    res.on("finish", () => clearTimeout(t));
    res.on("close", () => clearTimeout(t));
    next();
  };
}

/** JSON body parser with a hard size cap (default 1 MB). */
export function jsonBodyLimit(limit = "1mb") {
  return express.json({ limit });
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run mcp/limits.test.ts`
Expected: 3 tests pass.

- [ ] **Step 5: Wire into `mcp/server.ts`**

`createMcpExpressApp` ships with its own JSON parser, so `jsonBodyLimit` is exported for completeness but not used by default. Add only the timeout:

```ts
import { requestTimeout } from "./limits";
```

Inside `startHttp()`, after the logger and before auth:

```ts
const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_REQUEST_TIMEOUT_MS || "60000", 10);
app.use("/mcp", requestTimeout(REQUEST_TIMEOUT_MS));
```

- [ ] **Step 6: Cap `search_vault` `limit` argument**

In `mcp/server.ts`, find the `server.tool("search_vault", ...)` registration. Change the limit schema from `z.number().optional().default(10)` to `z.number().int().min(1).max(50).optional().default(10)`. Apply the same cap to `get_similar`. This prevents a buggy or malicious caller from requesting 100k results.

- [ ] **Step 7: Build and run quick sanity check**

```bash
npm run build
```

Expected: no TS errors.

- [ ] **Step 8: Commit**

```bash
git add mcp/limits.ts mcp/limits.test.ts mcp/server.ts
git commit -m "feat: add per-request timeout and bound search result limits"
```

---

### Task 1.4: End-to-end sanity check via docker-compose locally

**Files:** none modified.

- [ ] **Step 1: Bring up the stack against a small fixture vault**

```bash
mkdir -p /tmp/fixture-vault/Dashboard
cat > /tmp/fixture-vault/Dashboard/example.md <<'MD'
# Example Note
This is a hybrid-search test note about agentic AI workflows.
MD
mkdir -p /tmp/fixture-data
VAULT_HOST_PATH=/tmp/fixture-vault DATA_HOST_PATH=/tmp/fixture-data MCP_HOST_PORT=3099 docker compose up --build
```

Wait for the server log line: `vault-search MCP server started (HTTP) on port 3000`.
On first run, expect Ollama to download `nomic-embed-text` (~270 MB). This is one-time.

- [ ] **Step 2: From another shell, hit `/healthz`**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3099/healthz
```

Expected: `200`.

- [ ] **Step 3: Initialize a session and run a search**

(Reuse the curl flow from Task 0.4, but against `localhost:3099` and using the token from `.env`.) Expect `search_vault` to return the example note.

- [ ] **Step 4: Confirm the auth rejection log appears**

```bash
curl -s -o /dev/null http://localhost:3099/mcp -X POST -H "Authorization: Bearer wrong" -H "Content-Type: application/json" -d '{}'
```

Expected: in the docker logs, a JSON line with `status: 401`.

- [ ] **Step 5: Tear down**

`docker compose down`. No commit.

---

## Phase 2 — Deploy to NAS (Synology)

This phase is operational, not code. The deliverable is an executed deployment, captured in a runbook for repeatability.

### Task 2.1: Write the Synology deployment runbook

**Files:**
- Create: `docs/superpowers/runbooks/nas-deployment.md`

- [ ] **Step 1: Create the runbook**

```markdown
# NAS Deployment Runbook (Synology DSM)

> Goal: bring up the vault-search docker compose stack on the user's Synology NAS with the vault mounted read-only.

## Prerequisites
- Synology DSM 7.x+ with **Container Manager** package installed (Package Center → Container Manager). On older DSM this is "Docker."
- SSH access enabled (Control Panel → Terminal & SNMP → Enable SSH).
- The Obsidian vault is already syncing onto the NAS at `/var/services/homes/jpaters0n/ObsidianVault` (or another path — set `VAULT_HOST_PATH` to match).
- At least 4 GB free RAM for the Ollama embedding model.

## Steps

1. **SSH into the NAS**
   ```bash
   ssh jpaters0n@<nas-host>
   ```

2. **Clone the repo into your home directory**
   ```bash
   cd ~
   git clone <repo-url> vault-search
   cd vault-search
   ```

3. **Create `.env` with a fresh, unique token** (different from the one used in dev)
   ```bash
   cp .env.example .env
   echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" >> .env
   nano .env   # remove duplicate MCP_AUTH_TOKEN= line if needed
   chmod 600 .env
   ```

4. **Verify the vault path resolves**
   ```bash
   ls "$(grep ^VAULT_HOST_PATH= .env | cut -d= -f2)" | head
   ```
   Expected: lists vault directories (Dashboard, etc.).

5. **Create the data directory**
   ```bash
   mkdir -p "$(grep ^DATA_HOST_PATH= .env | cut -d= -f2)"
   ```

6. **Build and start the stack**
   ```bash
   sudo docker compose up -d --build
   ```
   First run: Ollama pulls `nomic-embed-text`. Watch with `sudo docker compose logs -f ollama`.

7. **Pull the embedding model into Ollama**
   ```bash
   sudo docker exec vault-search-ollama ollama pull nomic-embed-text
   ```

8. **Wait for the first index to complete**
   ```bash
   sudo docker compose logs -f vault-search
   ```
   On a multi-thousand-note vault, the first index takes 5–60 minutes depending on Ollama throughput on the NAS hardware. Look for `[index] done`.

9. **Local health check**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3099/healthz
   ```
   Expected: `200`.

10. **Search smoke test from the NAS**
    Use the curl flow from Task 0.4, but against `localhost:3099`, with the token from this NAS's `.env`. Confirm at least one tool call returns expected results.

## Troubleshooting
- **`fs.watch` doesn't pick up changes:** Synology shared folders can have flaky inode-based watching when the vault sync is via Synology Drive or rsync. If the watcher misses changes, fall back to a periodic full reindex by hitting the `reindex` tool from a cron task. (Investigate fix later if needed.)
- **OOM during indexing:** lower `EMBED_CONCURRENCY` in `src/config.ts` from 5 to 2 and rebuild.
- **Ollama slow on NAS CPU:** it's CPU-only (no GPU on most NAS units). Throughput is what it is; consider a smaller embedding model if the first-index wall-clock is unacceptable.
```

- [ ] **Step 2: Commit the runbook**

```bash
git add docs/superpowers/runbooks/nas-deployment.md
git commit -m "docs: synology NAS deployment runbook"
```

---

### Task 2.2: Execute the runbook

**Files:** none. This is an operational task.

- [ ] **Step 1: Run through every numbered step in `docs/superpowers/runbooks/nas-deployment.md` on the NAS.**

- [ ] **Step 2: At each step, if behavior diverges from "Expected," capture it.**
  Append a "Known issues encountered during deployment" section to the runbook with what you saw and how you resolved it.

- [ ] **Step 3: At the end, run a search from the NAS over SSH, using `localhost:3099` and the deployed token.**

Expected: results match what the same query returned in dev (Task 0.4). If they don't, do not proceed to Phase 3.

- [ ] **Step 4: Commit any runbook updates**

```bash
git add docs/superpowers/runbooks/nas-deployment.md
git commit -m "docs: capture issues hit during first NAS deployment"
```

---

## Phase 3 — Tailscale Funnel

### Task 3.1: Write the Tailscale Funnel runbook

**Files:**
- Create: `docs/superpowers/runbooks/tailscale-funnel.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Tailscale Funnel Runbook

> Goal: expose the vault-search MCP container's port 3099 publicly over HTTPS via Tailscale Funnel.

## Prerequisites
- Tailscale account.
- Funnel enabled in the Tailscale admin console: ACL must include `"funnel": ["..."]` for the NAS node, OR the user must accept the Funnel prompt on first run. See https://tailscale.com/kb/1223/funnel for current setup.
- The MCP container is up on the NAS, listening on port 3099 (Phase 2 done).
- A custom DNS name is NOT required — Funnel uses your `*.ts.net` hostname.

## Steps

1. **Install Tailscale on the NAS** (host-level, not in a container)
   - Synology: Package Center → search "Tailscale" → install. Sign in.
   - Confirm: `tailscale status` shows the NAS as a node.

2. **Enable HTTPS for your tailnet** (one-time, in admin console)
   Tailscale admin → DNS → "MagicDNS" enabled, "HTTPS Certificates" enabled.

3. **Test serve before funnel**
   On the NAS:
   ```bash
   sudo tailscale serve --bg --https=443 http://localhost:3099
   sudo tailscale serve status
   ```
   From a tailnet-joined device, browse `https://<nas>.<tailnet>.ts.net/healthz`. Expect `{"status":"ok"}`.

4. **Promote to Funnel (public exposure)**
   ```bash
   sudo tailscale funnel --bg 443
   sudo tailscale funnel status
   ```

5. **Verify from a public network** (phone on cellular, NOT home wifi)
   ```bash
   curl -s https://<nas>.<tailnet>.ts.net/healthz
   ```
   Expected: `{"status":"ok"}`.

6. **Verify auth gate**
   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://<nas>.<tailnet>.ts.net/mcp -X POST -H "Content-Type: application/json" -d '{}'
   ```
   Expected: `401`.

7. **Verify auth pass-through**
   Run the full Task 0.4 curl flow against `https://<nas>.<tailnet>.ts.net/mcp` with the production token.
   Expected: `tools/list` returns the four tool names.

## Operational notes
- **Bandwidth:** Funnel has [traffic limits](https://tailscale.com/kb/1223/funnel) (currently generous for personal use; check before relying on it).
- **Disable:** `sudo tailscale funnel --https=443 off` if you want to take the public surface down without removing Tailscale.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/tailscale-funnel.md
git commit -m "docs: tailscale funnel runbook"
```

---

### Task 3.2: Execute the Tailscale Funnel runbook

**Files:** none.

- [ ] **Step 1: Walk every step in the runbook on the NAS.**

- [ ] **Step 2: At step 5, verify the test is over cellular (phone with wifi off).**
  This confirms the endpoint is *truly* public, not just visible from the home LAN.

- [ ] **Step 3: Capture the public URL and store it securely** (password manager).
  This URL plus the bearer token is sufficient to read the vault — treat both as secrets.

- [ ] **Step 4: Append any deviations to the runbook and commit.**

---

## Phase 4 — Connect Claude mobile

### Task 4.1: Write the Claude Custom Connector runbook

**Files:**
- Create: `docs/superpowers/runbooks/claude-connector.md`

- [ ] **Step 1: Create the runbook**

```markdown
# Claude Custom Connector — vault-search

> Goal: register the deployed MCP server as a Custom Connector in Claude.ai so it's available from the mobile app.

## Steps

1. Open https://claude.ai on a desktop browser. (Custom Connector setup is easier on desktop; once registered, it's available in the mobile app.)

2. Settings → Connectors → "Add custom connector".

3. Fill in:
   - **Name:** `vault-search`
   - **MCP Server URL:** `https://<nas>.<tailnet>.ts.net/mcp`
   - **Auth method:** Bearer token (or "Custom header" if Bearer isn't a preset). Header: `Authorization`, value: `Bearer <token>`.

4. Save. Claude attempts an `initialize` handshake — should succeed within a few seconds. If it fails:
   - Check the server logs (`sudo docker compose logs -f vault-search` on the NAS) for the request.
   - 401 → token mismatch.
   - Network error → Funnel issue, retry Phase 3 step 5.

5. Enable the connector in a new chat. Confirm Claude lists the four tools when asked: "What tools do you have for searching my vault?"

6. **From the mobile app:** open Claude on the phone, start a new chat, ensure the connector is enabled (it should sync from the web settings), and ask:
   > "Search my vault for notes about science fiction novels. Show me the top 3."
   Expected: Claude calls `search_vault` and returns results.

## Tool description tuning

If Claude doesn't reliably pick the right tool, edit the `description` strings in `mcp/server.ts` (the second argument to `server.tool(...)` calls) and redeploy. Description quality is the primary lever — make them specific about WHEN to use each tool.

Example improvements:
- `search_vault`: lead with "Use this whenever the user asks about content in their personal notes / Obsidian vault."
- `get_context`: "Use after `search_vault` to read the full text of a result you want to quote or cite."
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/claude-connector.md
git commit -m "docs: claude custom connector runbook"
```

---

### Task 4.2: Register the connector and test from the phone

**Files:** none initially. May trigger Task 4.3 if descriptions need work.

- [ ] **Step 1: Walk the runbook on desktop browser.**

- [ ] **Step 2: From the phone over cellular, run at least 5 different real queries.**
  Note any tool selection failures (Claude refused to use the tool, picked the wrong tool, looped).

- [ ] **Step 3: If any failures observed, proceed to Task 4.3. Otherwise mark the phase done.**

---

### Task 4.3 (conditional): Tune tool descriptions

**Files:**
- Modify: `mcp/server.ts` (only the description strings)

Only run this task if Task 4.2 found tool-selection problems.

- [ ] **Step 1: For each problem case, write the description change you'd make.**

- [ ] **Step 2: Update `mcp/server.ts` and redeploy** (`docker compose up -d --build` on the NAS, after `git pull`).

- [ ] **Step 3: Re-test the same problem queries from the phone.**

- [ ] **Step 4: Commit**

```bash
git add mcp/server.ts
git commit -m "tune: improve MCP tool descriptions for better Claude tool selection"
```

---

## Phase 5 — Quality + observability

### Task 5.1: Add a CLI entrypoint for the eval harness

**Files:**
- Create: `src/eval-cli.ts`
- Modify: `package.json` (add `eval` script)

- [ ] **Step 1: Implement `src/eval-cli.ts`**

```ts
import path from "node:path";
import { runEval } from "./eval";
import { closeDb } from "./db";

async function main() {
  const queryFile = process.argv[2] || path.resolve(process.cwd(), "eval-queries.json");
  console.error(`Running eval against ${queryFile}…`);

  const summary = await runEval(queryFile);

  // Per-query detail to stderr; aggregate stats to stdout for easy capture.
  for (const r of summary.results) {
    console.error(
      `${r.first_relevant_rank ?? "—"}\trecall=${r.recall_at_10.toFixed(2)}\tmrr=${r.mrr.toFixed(2)}\t${r.query}`
    );
  }
  console.log(JSON.stringify({
    recall_at_10: summary.recall_at_10,
    mrr: summary.mrr,
    n: summary.results.length,
  }, null, 2));

  closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Add the `eval` script to `package.json`**

In `scripts`, add:

```json
"eval": "node dist/src/eval-cli.js"
```

- [ ] **Step 3: Build and run baseline**

```bash
npm run build
npm run eval > eval-baseline.json
cat eval-baseline.json
```

Expected: a JSON object with `recall_at_10`, `mrr`, `n`. Capture this baseline somewhere (paste into the runbook or save the file). It's the regression target.

- [ ] **Step 4: Commit**

```bash
git add src/eval-cli.ts package.json
git commit -m "feat: add CLI runner for eval harness"
```

---

### Task 5.2: Add a "recent queries" in-memory log on the server

For debugging what Claude actually called when something looked off. In-memory only (no persistence), bounded ring buffer.

**Files:**
- Create: `mcp/recent.ts`
- Modify: `mcp/logging.ts` (push to ring buffer in addition to logging)
- Modify: `mcp/server.ts` (mount a `/debug/recent` endpoint, behind auth)

- [ ] **Step 1: Write the failing test**

Create `mcp/recent.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { RecentRing } from "./recent";

describe("RecentRing", () => {
  it("retains the most recent N entries and drops older ones", () => {
    const r = new RecentRing<number>(3);
    r.push(1); r.push(2); r.push(3); r.push(4);
    expect(r.snapshot()).toEqual([2, 3, 4]);
  });

  it("returns a copy on snapshot, not the internal buffer", () => {
    const r = new RecentRing<number>(3);
    r.push(1);
    const snap = r.snapshot();
    snap.push(99);
    expect(r.snapshot()).toEqual([1]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run mcp/recent.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `mcp/recent.ts`**

```ts
export class RecentRing<T> {
  private buf: T[] = [];
  constructor(private readonly capacity: number) {
    if (capacity <= 0) throw new Error("capacity must be positive");
  }
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.capacity) this.buf.shift();
  }
  snapshot(): T[] {
    return this.buf.slice();
  }
}
```

- [ ] **Step 4: Run to verify passing**

Run: `npx vitest run mcp/recent.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Wire the ring into `requestLogger`**

Modify `mcp/logging.ts` to optionally push every log entry into a ring. Update the signature:

```ts
import type { Request, Response, NextFunction } from "express";
import { RecentRing } from "./recent";

export interface LogEntry {
  ts: string;
  method: string;
  url: string;
  mcpMethod?: string;
  toolName?: string;
  status: number;
  latencyMs: number;
}

export function requestLogger(opts: {
  log?: (entry: LogEntry) => void;
  ring?: RecentRing<LogEntry>;
} = {}) {
  const log = opts.log ?? ((entry) => console.error(JSON.stringify(entry)));
  const ring = opts.ring;

  return function (req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const mcpMethod = typeof body?.method === "string" ? body.method : undefined;
    const toolName = typeof body?.params?.name === "string" ? body.params.name : undefined;

    res.on("finish", () => {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        mcpMethod,
        toolName,
        status: res.statusCode,
        latencyMs: Date.now() - start,
      };
      log(entry);
      ring?.push(entry);
    });
    next();
  };
}
```

Re-run: `npx vitest run mcp/logging.test.ts` — existing 2 tests still pass.

- [ ] **Step 6: Mount `/debug/recent` (auth-gated) in `mcp/server.ts`**

In `startHttp()`:

```ts
import { RecentRing } from "./recent";
// ...
import type { LogEntry } from "./logging";
// (place this with the other imports at the top of the file)

const recentRing = new RecentRing<LogEntry>(200);
app.use("/mcp", requestLogger({ ring: recentRing }));

if (authToken) {
  app.use("/mcp", bearerAuth(authToken));
  app.get("/debug/recent", bearerAuth(authToken), (_req, res) => {
    res.json(recentRing.snapshot());
  });
}
```

- [ ] **Step 7: Verify in a running server**

```bash
TOKEN=$(grep ^MCP_AUTH_TOKEN= .env | cut -d= -f2)
# Hit /mcp a couple of times via the curl flow from Task 0.4, then:
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3000/debug/recent | jq 'length'
```

Expected: a positive integer matching how many `/mcp` requests you made.

- [ ] **Step 8: Commit**

```bash
git add mcp/recent.ts mcp/recent.test.ts mcp/logging.ts mcp/server.ts
git commit -m "feat: in-memory recent-queries ring buffer at /debug/recent"
```

---

### Task 5.3: Document the eval workflow

**Files:**
- Modify: `docs/superpowers/runbooks/nas-deployment.md` (add "regression check" section at the bottom)

- [ ] **Step 1: Append to the runbook**

```markdown
## Regression check after indexer/embedder changes

```bash
npm run build
npm run eval > eval-after.json
diff <(jq '.recall_at_10, .mrr' eval-baseline.json) <(jq '.recall_at_10, .mrr' eval-after.json)
```

Investigate any drop >0.05 in recall@10 or MRR before deploying. Per-query stderr output identifies which queries regressed.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/runbooks/nas-deployment.md
git commit -m "docs: regression-check workflow using eval harness"
```

---

## Self-review checklist (run at end of plan execution)

- [ ] All `git status` output is clean except for `.env` and `eval-baseline.json` (both gitignored or kept locally).
- [ ] `npm test` passes (all unit tests across phases).
- [ ] `curl https://<nas>.<tailnet>.ts.net/healthz` returns 200 from cellular.
- [ ] An unauthenticated `/mcp` POST returns 401.
- [ ] A real query from the Claude mobile app returns expected results from the phone.
- [ ] Recent-queries log shows the phone's calls when hitting `/debug/recent`.
- [ ] The `MCP_AUTH_TOKEN` value is *not* present in any committed file (search: `git grep MCP_AUTH_TOKEN -- ':!.env.example'` should only show env var *references*, never values).

---

## Out of scope (intentionally)

- Mobile web app frontend (option B in the spec) — deferred.
- Custom Obsidian mobile plugin (option C) — deferred indefinitely.
- OAuth or multi-user auth.
- Cloud fallback if the NAS is offline.
- Automated CI for tests (manual `npm test` is sufficient for a single-user project).
- Replacing `fs.watch` with `chokidar` — only revisit if Synology reliability issues are confirmed (see runbook troubleshooting).
