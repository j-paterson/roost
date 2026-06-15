import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(typeof info?.expiresAt).toBe("number");
    expect(info?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000)); // at least "now"
  });

  it("returns undefined when verifying expired access token", () => {
    const t = store.issueTokens({ clientId: "c1" });
    vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000); // 31 days
    expect(store.verifyAccessToken(t.access_token)).toBeUndefined();
  });

  it("refresh exchanges a refresh token for a new access token (rotates)", () => {
    const t = store.issueTokens({ clientId: "c1" });
    const r = store.refreshTokens(t.refresh_token!);
    expect(r?.access_token).toBeTruthy();
    expect(r?.access_token).not.toBe(t.access_token);
    // Old refresh is invalidated
    expect(store.refreshTokens(t.refresh_token!)).toBeUndefined();
  });

  it("revokeAccessToken makes verify return undefined", () => {
    const t = store.issueTokens({ clientId: "c1" });
    store.revokeToken(t.access_token);
    expect(store.verifyAccessToken(t.access_token)).toBeUndefined();
  });
});

describe("InMemoryStore — disk persistence (survives restart)", () => {
  let tmpFile: string;

  beforeEach(() => {
    // override the outer beforeEach: use real timers so we can read/write the FS without weirdness
    vi.useRealTimers();
    tmpFile = path.join(os.tmpdir(), `store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    if (fs.existsSync(`${tmpFile}.tmp`)) fs.unlinkSync(`${tmpFile}.tmp`);
  });

  it("writes the file on every mutator and reloads on next construction", async () => {
    const s1 = new InMemoryStore(tmpFile);
    const client = await s1.registerClient({ client_name: "x", redirect_uris: ["https://e.example/cb"] });
    const tokens = s1.issueTokens({ clientId: client.client_id });

    expect(fs.existsSync(tmpFile)).toBe(true);

    // Simulate restart: discard s1, construct s2 against the same file.
    const s2 = new InMemoryStore(tmpFile);
    expect(await s2.getClient(client.client_id)).toBeTruthy();
    const verified = s2.verifyAccessToken(tokens.access_token);
    expect(verified?.clientId).toBe(client.client_id);
  });

  it("does NOT persist authorization codes (they're single-use 5-min TTL)", async () => {
    const s1 = new InMemoryStore(tmpFile);
    const client = await s1.registerClient({ client_name: "x", redirect_uris: ["https://e.example/cb"] });
    s1.putAuthCode("code-99", {
      clientId: client.client_id,
      redirectUri: "https://e.example/cb",
      codeChallenge: "ch",
      expiresAt: Date.now() + 300_000,
    });
    expect(s1.getAuthCode("code-99")).toBeTruthy();

    const s2 = new InMemoryStore(tmpFile);
    expect(s2.getAuthCode("code-99")).toBeUndefined();
  });

  it("revokeToken persists across construction", async () => {
    const s1 = new InMemoryStore(tmpFile);
    const client = await s1.registerClient({ client_name: "x", redirect_uris: ["https://e.example/cb"] });
    const tokens = s1.issueTokens({ clientId: client.client_id });
    s1.revokeToken(tokens.access_token);

    const s2 = new InMemoryStore(tmpFile);
    expect(s2.verifyAccessToken(tokens.access_token)).toBeUndefined();
  });

  it("file is written with mode 0o600 (owner read/write only)", async () => {
    const s = new InMemoryStore(tmpFile);
    await s.registerClient({ client_name: "x", redirect_uris: ["https://e.example/cb"] });
    const mode = fs.statSync(tmpFile).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tolerates a missing/invalid existing file at construction", () => {
    // Missing file — should construct fine, just no preload
    expect(() => new InMemoryStore(tmpFile)).not.toThrow();

    // Invalid JSON — should construct fine, log to stderr
    fs.writeFileSync(tmpFile, "not valid json{{");
    expect(() => new InMemoryStore(tmpFile)).not.toThrow();
  });

  it("constructed without filePath does not write any file", async () => {
    const s = new InMemoryStore();
    const c = await s.registerClient({ client_name: "x", redirect_uris: ["https://e.example/cb"] });
    s.issueTokens({ clientId: c.client_id });
    // No file path means no side-effects on disk. Nothing to assert beyond "no throw"
    expect(c.client_id).toBeTruthy();
  });
});
