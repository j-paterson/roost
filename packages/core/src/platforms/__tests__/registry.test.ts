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
  it("instagram is a registered and ENABLED platform (Phase 2: Task 9 — sync wired)", () => {
    const ig = getPlatform("instagram");
    expect(ig.enabled).toBe(true);
    expect(ig.origin).toBe("https://www.instagram.com");
    expect(ig.profileUrl).toBe("https://www.instagram.com/");
    expect(ig.authCookies).toEqual(["sessionid"]);
    expect(ig.probeSource.length).toBeGreaterThan(0); // active probe wired
    expect(typeof ig.sync).toBe("function"); // Task 9: sync wired
    expect(ig.parse).toBeDefined();    // Phase 2: parsers wired (Task 2)
    expect(ig.vault).toEqual({ folder: "Instagram", attachPrefix: "instagram", icon: "camera" });
  });
  it("enabledPlatforms includes instagram (Task 9)", () => {
    expect(enabledPlatforms().map((p) => p.id).sort()).toEqual(["instagram", "tiktok", "twitter"]);
  });
});
