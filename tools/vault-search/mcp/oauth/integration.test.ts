import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import express from "express";
import supertest from "supertest";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { createOAuthProvider } from "./provider";
import { stashRequest } from "./request-stash";

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ISSUER = "http://localhost:39998";
const PKCE_VERIFIER = "x".repeat(43);
const PKCE_CHALLENGE = createHash("sha256").update(PKCE_VERIFIER).digest("base64url");

function makeApp() {
  const provider = createOAuthProvider({ expectedBearer: TOKEN });
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  // Stash req → res on /authorize so provider.authorize can read req.body
  // (mirrors the production server setup in mcp/server.ts).
  app.use("/authorize", (req, res, next) => {
    stashRequest(req, res);
    next();
  });
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(ISSUER), resourceName: "vault-search" }));
  app.post("/mcp", requireBearerAuth({ verifier: provider, requiredScopes: [] }), (_req, res) => {
    res.json({ ok: true });
  });
  return { app, provider };
}

describe("OAuth integration — full Claude-style flow", () => {
  it("DCR → /authorize (consent) → /token → authenticated /mcp", async () => {
    const { app } = makeApp();
    const agent = supertest(app);

    // 1. DCR
    const dcr = await agent
      .post("/register")
      .set("Content-Type", "application/json")
      .send({
        client_name: "TestClient",
        redirect_uris: ["http://localhost:9999/cb"],
        token_endpoint_auth_method: "none",
      });
    expect(dcr.status).toBe(201);
    const clientId = dcr.body.client_id as string;
    expect(clientId).toBeTruthy();

    // 2. /authorize submit (form POST with bearer)
    const authResp = await agent
      .post("/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "http://localhost:9999/cb",
        code_challenge: PKCE_CHALLENGE,
        code_challenge_method: "S256",
        state: "s1",
        bearer_token: TOKEN,
      })
      .redirects(0);
    expect(authResp.status).toBe(302);
    const loc = authResp.headers["location"] as string;
    expect(loc).toContain("http://localhost:9999/cb?");
    const code = new URL(loc).searchParams.get("code")!;
    expect(code).toBeTruthy();

    // 3. /token (exchange code for access token)
    const tokenResp = await agent
      .post("/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:9999/cb",
        code_verifier: PKCE_VERIFIER,
        client_id: clientId,
      });
    expect(tokenResp.status).toBe(200);
    const accessToken = tokenResp.body.access_token as string;
    expect(accessToken).toBeTruthy();

    // 4. Authenticated /mcp call
    const mcpResp = await agent
      .post("/mcp")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({});
    expect(mcpResp.status).toBe(200);
    expect(mcpResp.body.ok).toBe(true);
  });

  it("renders consent form with all OAuth params as hidden inputs (regression test for missing client_id)", async () => {
    const { app } = makeApp();
    const agent = supertest(app);

    // Pre-register a client (skip DCR for clarity)
    const dcr = await agent
      .post("/register")
      .set("Content-Type", "application/json")
      .send({ client_name: "TestClient", redirect_uris: ["http://localhost:9999/cb"], token_endpoint_auth_method: "none" });
    const clientId = dcr.body.client_id as string;

    // 1. GET /authorize — server should render consent page
    const consent = await agent.get("/authorize").query({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:9999/cb",
      code_challenge: PKCE_CHALLENGE,
      code_challenge_method: "S256",
      state: "s1",
    });
    expect(consent.status).toBe(200);
    const html = consent.text;

    // 2. Parse hidden inputs from the form
    const hiddenInputs: Record<string, string> = {};
    const re = /<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      hiddenInputs[m[1]] = m[2];
    }

    // 3. Critical: client_id, response_type, code_challenge_method MUST be in hidden inputs
    expect(hiddenInputs.client_id).toBe(clientId);
    expect(hiddenInputs.response_type).toBe("code");
    expect(hiddenInputs.code_challenge_method).toBe("S256");
    expect(hiddenInputs.code_challenge).toBe(PKCE_CHALLENGE);
    expect(hiddenInputs.redirect_uri).toBe("http://localhost:9999/cb");
    expect(hiddenInputs.state).toBe("s1");

    // 4. Simulate the user submitting the form: POST those exact hidden inputs + bearer_token
    const submit = await agent
      .post("/authorize")
      .type("form")
      .send({ ...hiddenInputs, bearer_token: TOKEN })
      .redirects(0);
    expect(submit.status).toBe(302);
    expect(submit.headers["location"]).toContain("http://localhost:9999/cb?code=");
  });

  it("rejects /mcp with no bearer (401)", async () => {
    const { app } = makeApp();
    const resp = await supertest(app).post("/mcp").send({});
    expect(resp.status).toBe(401);
  });

  it("rejects /mcp with bogus bearer (401)", async () => {
    const { app } = makeApp();
    const resp = await supertest(app).post("/mcp").set("Authorization", "Bearer bogus").send({});
    expect(resp.status).toBe(401);
  });
});
