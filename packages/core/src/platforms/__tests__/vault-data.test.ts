import { describe, it, expect } from "vitest";
import { PLATFORMS } from "@/platforms/registry";

describe("descriptor vault data", () => {
  it("every SYNC-CAPABLE platform has vault folder/attachPrefix/icon", () => {
    // Discovery-only descriptors (no sync fn — e.g. reddit before its sync
    // lands) legitimately omit vault; they never write to the vault. Only
    // platforms that actually sync need the vault block.
    for (const p of Object.values(PLATFORMS)) {
      if (!p.sync) continue;
      expect(p.vault, `${p.id} missing vault`).toBeTruthy();
      expect(typeof p.vault!.folder).toBe("string");
      expect(typeof p.vault!.attachPrefix).toBe("string");
      expect(typeof p.vault!.icon).toBe("string");
    }
  });
  it("preserves existing folder names exactly", () => {
    expect(PLATFORMS.tiktok.vault!.folder).toBe("TikTok");
    expect(PLATFORMS.twitter.vault!.folder).toBe("X");
    expect(PLATFORMS.instagram.vault!.folder).toBe("Instagram");
  });
});
