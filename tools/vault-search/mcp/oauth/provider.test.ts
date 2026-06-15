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

  it("uses stashed request when req argument is absent", async () => {
    const { stashRequest } = await import("./request-stash");
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
    const refreshed = await provider.exchangeRefreshToken(FAKE_CLIENT, tokens.refresh_token!);
    expect(refreshed.access_token).toBeTruthy();
    expect(refreshed.access_token).not.toBe(tokens.access_token);
  });
});
