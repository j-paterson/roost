// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { fetchOgMetadata } from "@/sync/cover-fetcher";

const html = (body: string) => ({ status: 200, headers: {}, json: null, text: `<html><head>${body}</head></html>`, arrayBuffer: new ArrayBuffer(0) });

afterEach(() => __resetRequestUrlImpl());

describe("fetchOgMetadata", () => {
  it("parses og:title/description/image/site_name", async () => {
    __setRequestUrlImpl(async () => html(
      `<meta property="og:title" content="A Title">
       <meta property="og:description" content="A desc">
       <meta property="og:image" content="https://x.com/i.jpg">
       <meta property="og:site_name" content="Example">`));
    expect(await fetchOgMetadata("https://example.com/p")).toEqual({
      title: "A Title", description: "A desc", image: "https://x.com/i.jpg", siteName: "Example",
    });
  });

  it("falls back to <title> and the URL domain when og tags are absent", async () => {
    __setRequestUrlImpl(async () => html(`<title>Plain Title</title>`));
    const r = await fetchOgMetadata("https://www.example.com/p");
    expect(r.title).toBe("Plain Title");
    expect(r.siteName).toBe("example.com");
    expect(r.image).toBeNull();
    expect(r.description).toBeNull();
  });

  it("returns all-null on non-200 / fetch failure (never throws)", async () => {
    __setRequestUrlImpl(async () => { throw new Error("boom"); });
    expect(await fetchOgMetadata("https://dead.example")).toEqual({ title: null, description: null, image: null, siteName: null });
  });

  it("normalizes a protocol-relative og:image to https", async () => {
    __setRequestUrlImpl(async () => html(`<meta property="og:image" content="//cdn.example.com/i.jpg">`));
    expect((await fetchOgMetadata("https://example.com/p")).image).toBe("https://cdn.example.com/i.jpg");
  });

  it("returns all-null on a non-200 status", async () => {
    __setRequestUrlImpl(async () => ({ status: 404, headers: {}, json: null, text: "<html></html>", arrayBuffer: new ArrayBuffer(0) }));
    expect(await fetchOgMetadata("https://example.com/missing")).toEqual({ title: null, description: null, image: null, siteName: null });
  });
});
