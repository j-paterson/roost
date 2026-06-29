import { describe, it, expect } from "vitest";
import { getPlatform, enabledPlatforms } from "@/platforms/registry";

describe("platform registry", () => {
  it("getPlatform returns the descriptor with current config values", () => {
    const tk = getPlatform("tiktok");
    expect(tk.displayName).toBe("TikTok");
    expect(tk.origin).toBe("https://www.tiktok.com");
    expect(tk.authCookies).toEqual(["sessionid", "sessionid_ss"]);
    expect(tk.hubId).toBe("tiktok");
    const tw = getPlatform("twitter");
    expect(tw.displayName).toBe("X");
    expect(tw.hubId).toBe("x");
    expect(tw.authCookies).toEqual(["auth_token"]);
  });
  it("enabledPlatforms returns only enabled descriptors", () => {
    const ids = enabledPlatforms().map((p) => p.id);
    expect(ids).toContain("tiktok");
    expect(ids).toContain("twitter");
  });
});
