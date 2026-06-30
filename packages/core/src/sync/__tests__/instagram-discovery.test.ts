import { describe, it, expect } from "vitest";
import { isInstagramApiCall, summarizeFindings, type ObservedCall } from "@/sync/instagram-discovery";

const call = (url: string, extra: Partial<ObservedCall> = {}): ObservedCall => ({
  url, method: "GET", reqHeaders: {}, at: 1, ...extra,
});

describe("isInstagramApiCall", () => {
  it("matches saved + collections + graphql API URLs", () => {
    expect(isInstagramApiCall("https://www.instagram.com/api/v1/feed/saved/posts/?max_id=abc")).toBe(true);
    expect(isInstagramApiCall("https://i.instagram.com/api/v1/collections/list/")).toBe(true);
    expect(isInstagramApiCall("https://www.instagram.com/graphql/query")).toBe(true);
  });
  it("rejects non-API instagram URLs and CDN media", () => {
    expect(isInstagramApiCall("https://www.instagram.com/user/saved/")).toBe(false);     // page, not /api/
    expect(isInstagramApiCall("https://scontent-xx.cdninstagram.com/v/photo.jpg")).toBe(false); // CDN
    expect(isInstagramApiCall("https://www.google.com/api/x")).toBe(false);              // not instagram
  });
});

describe("summarizeFindings", () => {
  it("keeps only API calls, dedupes by method+path, counts, and strips query in the key", () => {
    const calls = [
      call("https://www.instagram.com/api/v1/feed/saved/posts/?max_id=A", { reqHeaders: { "x-ig-app-id": "936" }, respSample: "x".repeat(900) }),
      call("https://www.instagram.com/api/v1/feed/saved/posts/?max_id=B"), // same endpoint, diff cursor
      call("https://i.instagram.com/api/v1/collections/list/"),
      call("https://www.instagram.com/user/saved/"), // not API → dropped
    ];
    const f = summarizeFindings(calls);
    expect(f.totalObserved).toBe(4);
    expect(f.apiCalls).toBe(3);
    expect(f.endpoints).toHaveLength(2); // saved (count 2) + collections (count 1)
    const saved = f.endpoints.find((e) => e.path.includes("/feed/saved"))!;
    expect(saved.count).toBe(2);
    expect(saved.method).toBe("GET");
    expect(saved.exampleQuery).toBe("max_id=A");           // representative = first call
    expect(saved.authHeaders["x-ig-app-id"]).toBe("936");
    expect(saved.respSampleHead.length).toBe(400); // 900-char sample sliced to exactly 400
    expect(f.endpoints[0].count).toBeGreaterThanOrEqual(f.endpoints[1].count); // sorted desc
  });
});
