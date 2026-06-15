#!/usr/bin/env node
/**
 * MCP server for vault-wide semantic search.
 * Exposes search_vault, get_similar, get_context, and reindex tools.
 *
 * Transports:
 *   - stdio (default): for Claude Code / local MCP clients
 *   - http:  Streamable HTTP (MCP spec) on MCP_PORT (default 3000)
 *
 * Set MCP_TRANSPORT=http to use HTTP transport.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import { bearerAuth } from "./auth";
import { healthRouter } from "./health";
import { hostAllowlist, parseAllowedHosts } from "./hosts";
import { requestLogger } from "./logging";
import type { LogEntry } from "./logging";
import { requestTimeout } from "./limits";
import { RecentRing } from "./recent";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthProvider, InMemoryStore } from "./oauth";
import { stashRequest } from "./oauth/request-stash";
import { z } from "zod";

// Import from core library
import { searchVault, findSimilar, getContext } from "../src/search";
import { indexVault, getStats } from "../src/indexer";
import { startWatcher } from "../src/watcher";
import { closeDb } from "../src/db";

// ---------------------------------------------------------------------------
// Tool registration — creates a fresh McpServer with all tools attached
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: "vault-search",
    version: "1.0.0",
  });

  server.tool(
    "search_vault",
    "Hybrid semantic + keyword search across the Obsidian vault. Returns ranked results with file paths, titles, headings, and text snippets.",
    {
      query: z.string().describe("The search query — can be natural language or keywords"),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Maximum number of results"),
    },
    async ({ query, limit }) => {
      const results = await searchVault(query, { limit });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );

  server.tool(
    "get_similar",
    "Find notes semantically similar to a given note. Useful for discovering related content.",
    {
      file_path: z.string().describe("Relative path to the note (e.g., 'Dashboard/The Library/Influence.md')"),
      limit: z.number().int().min(1).max(50).optional().default(10).describe("Maximum number of results"),
    },
    async ({ file_path, limit }) => {
      const results = await findSimilar(file_path, { limit });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(results, null, 2),
        }],
      };
    },
  );

  server.tool(
    "get_context",
    "Read the full content and frontmatter of a vault note.",
    {
      file_path: z.string().describe("Relative path to the note"),
    },
    async ({ file_path }) => {
      const result = getContext(file_path);
      if (!result) {
        return { content: [{ type: "text" as const, text: `File not found: ${file_path}` }] };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    },
  );

  server.tool(
    "reindex",
    "Re-index the vault. Incrementally updates only changed files unless full=true.",
    {
      full: z.boolean().optional().default(false).describe("Full rebuild instead of incremental"),
    },
    async ({ full }) => {
      const stats = await indexVault((phase, cur, total, detail) => {
        console.error(`[${phase}] ${cur}/${total}${detail ? ` — ${detail}` : ""}`);
      }, full);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(stats, null, 2),
        }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport: stdio (default) or Streamable HTTP
// ---------------------------------------------------------------------------

async function startStdio() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("vault-search MCP server started (stdio)");

  const watcher = startWatcher();
  console.error("vault-search file watcher started");

  process.on("SIGINT", () => { watcher.close(); closeDb(); process.exit(0); });
  process.on("SIGTERM", () => { watcher.close(); closeDb(); process.exit(0); });
}

async function startHttp() {
  const port = parseInt(process.env.MCP_PORT || "3000", 10);
  const authToken = process.env.MCP_AUTH_TOKEN;
  // Pass host:'0.0.0.0' so the SDK skips its own localhost DNS-rebinding
  // middleware — we install our own hostAllowlist below instead.
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Trust Tailscale Funnel as a single hop in front of us so X-Forwarded-For
  // is honoured (otherwise express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
  // on every OAuth request, causing /authorize to fail with bogus zod errors).
  app.set("trust proxy", 1);

  const allowedHosts = parseAllowedHosts(process.env.MCP_ALLOWED_HOSTS);
  if (allowedHosts.length === 0) {
    console.error("WARNING: MCP_ALLOWED_HOSTS not set — Host header is not validated");
  } else {
    console.error(`Host allowlist enabled (${allowedHosts.length} entries)`);
  }
  app.use(hostAllowlist(allowedHosts));

  const recentRing = new RecentRing<LogEntry>(200);

  app.use(healthRouter);    // mounted BEFORE auth so /healthz is unauthenticated

  app.use("/mcp", requestLogger({ ring: recentRing }));

  const REQUEST_TIMEOUT_MS = parseInt(process.env.MCP_REQUEST_TIMEOUT_MS || "60000", 10);
  app.use("/mcp", requestTimeout(REQUEST_TIMEOUT_MS));

  // Auth middleware — OAuth (default) or escape hatches
  const oauthIssuer = process.env.MCP_OAUTH_ISSUER;
  const directBearer = process.env.MCP_DIRECT_BEARER === "1";

  if (authToken && oauthIssuer && !directBearer) {
    const oauthStorePath = process.env.OAUTH_STORE_PATH;
    const store = new InMemoryStore(oauthStorePath);
    if (oauthStorePath) console.error(`OAuth store persisting to ${oauthStorePath}`);
    else console.error("WARNING: OAUTH_STORE_PATH unset — OAuth tokens are in-memory only and will be wiped on every restart");
    const provider = createOAuthProvider({ expectedBearer: authToken, store });

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

    app.use("/mcp", requireBearerAuth({ verifier: provider, requiredScopes: [] }));
    console.error(`OAuth issuer enabled at ${oauthIssuer}`);
  } else if (authToken && directBearer) {
    app.use("/mcp", bearerAuth(authToken));
    console.error("MCP_DIRECT_BEARER=1 — using simple bearer middleware on /mcp (no OAuth)");
  } else if (authToken) {
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

  // /debug/recent stays on master bearer — NOT OAuth tokens (admin endpoint).
  if (authToken) {
    app.get("/debug/recent", bearerAuth(authToken), (_req, res) => {
      res.json(recentRing.snapshot());
    });
    console.error("/debug/recent enabled (master-bearer-gated)");
  } else {
    console.error("/debug/recent disabled (no MCP_AUTH_TOKEN)");
  }

  // Track transports by session so subsequent requests reuse the same session
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New session — create a fresh server + transport pair
        const sessionServer = createServer();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid: string) => {
            transports[sid] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            delete transports[sid];
          }
        };

        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP POST:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // GET — SSE stream for server-to-client notifications
  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  // DELETE — session termination
  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transports[sessionId].handleRequest(req, res);
  });

  const watcher = startWatcher();
  console.error("vault-search file watcher started");

  app.listen(port, () => {
    console.error(`vault-search MCP server started (HTTP) on port ${port}`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down…");
    for (const sid of Object.keys(transports)) {
      try { await transports[sid].close(); } catch { /* ignore */ }
      delete transports[sid];
    }
    watcher.close();
    closeDb();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const transportMode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();

(transportMode === "http" ? startHttp() : startStdio()).catch((err) => {
  console.error("MCP server error:", err);
  process.exit(1);
});
