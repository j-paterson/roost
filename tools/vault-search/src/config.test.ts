import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("config — DB_PATH env-var honoring", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses process.env.DB_PATH when set", async () => {
    vi.stubEnv("DB_PATH", "/data/search.db");
    vi.stubEnv("VAULT_PATH", "/vault");
    const config = await import("./config");
    expect(config.DB_PATH).toBe("/data/search.db");
  });

  it("falls back to VAULT_PATH/.vault-search/search.db when DB_PATH unset", async () => {
    vi.stubEnv("VAULT_PATH", "/vault");
    vi.stubEnv("DB_PATH", "");
    const config = await import("./config");
    expect(config.DB_PATH).toBe("/vault/.vault-search/search.db");
  });
});
