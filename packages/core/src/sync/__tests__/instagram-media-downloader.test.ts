import { describe, it, expect, vi } from "vitest";
import { downloadInstagramMedia } from "@/sync/media-downloader";

function fakeWc(dataUrl: string | null) {
  return {
    executeJavaScript: vi.fn(async () => dataUrl),
  } as unknown as Parameters<typeof downloadInstagramMedia>[0];
}

describe("downloadInstagramMedia", () => {
  it("decodes a base64 data URL to an ArrayBuffer", async () => {
    // "ABC" → base64 "QUJD"
    const buf = await downloadInstagramMedia(fakeWc("data:image/jpeg;base64,QUJD"), "https://cdn/x.jpg");
    expect(buf).not.toBeNull();
    expect(Buffer.from(buf as ArrayBuffer).toString("utf-8")).toBe("ABC");
  });

  it("returns null when the probe returns null", async () => {
    const buf = await downloadInstagramMedia(fakeWc(null), "https://cdn/x.jpg");
    expect(buf).toBeNull();
  });
});
