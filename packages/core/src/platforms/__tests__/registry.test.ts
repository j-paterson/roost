import { describe, it, expect } from "vitest";
import { getPlatform, enabledPlatforms } from "@/platforms/registry";

describe("platform registry", () => {
  it("getPlatform returns the descriptor with current config values", () => {
    const tk = getPlatform("tiktok");
    expect(tk.displayName).toBe("TikTok");
    expect(tk.origin).toBe("https://www.tiktok.com");
    expect(tk.profileUrl).toBe("https://www.tiktok.com/profile");
    expect(tk.authCookies).toEqual(["sessionid", "sessionid_ss"]);
    expect(tk.hubId).toBe("tiktok");
    expect(tk.card.title).toBe("TikTok");
    const tw = getPlatform("twitter");
    expect(tw.displayName).toBe("X");
    expect(tw.origin).toBe("https://x.com");
    expect(tw.profileUrl).toBe("https://x.com/");
    expect(tw.hubId).toBe("x");
    expect(tw.authCookies).toEqual(["auth_token"]);
    expect(tw.card.title).toBe("X / Twitter");
  });
  it("enabledPlatforms returns only enabled descriptors", () => {
    const ids = enabledPlatforms().map((p) => p.id);
    expect(ids).toContain("tiktok");
    expect(ids).toContain("twitter");
  });
  it("instagram is a registered but DISABLED discovery-only platform", () => {
    const ig = getPlatform("instagram");
    expect(ig.enabled).toBe(false);
    expect(ig.origin).toBe("https://www.instagram.com");
    expect(ig.profileUrl).toBe("https://www.instagram.com/");
    expect(ig.authCookies).toEqual(["sessionid"]);
    expect(ig.probeSource.length).toBeGreaterThan(0); // the observer probe is wired
    expect(ig.sync).toBeUndefined();   // discovery-only — no sync yet (Phase 2)
    expect(ig.parse).toBeUndefined();  // discovery-only — no parsers yet (Phase 2)
  });
  it("enabledPlatforms excludes the disabled instagram", () => {
    expect(enabledPlatforms().map((p) => p.id).sort()).toEqual(["tiktok", "twitter"]);
  });
});
