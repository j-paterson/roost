import { describe, it, expect, vi } from "vitest";
import { paginateSaved, type RedditFetch } from "@/sync/reddit-sync";

function listing(ids: string[], after: string | null) {
  return { status: 200, body: JSON.stringify({ kind: "Listing", data: {
    after, dist: ids.length,
    children: ids.map(id => ({ kind: "t3", data: { id, name: "t3_" + id, permalink: "/r/x/comments/" + id + "/t/", created_utc: 1700000000, author: "u", subreddit: "x" } })),
  } }) };
}

describe("paginateSaved", () => {
  it("follows after until null; emits normalized records", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValueOnce(listing(["a", "b"], "t3_b")).mockResolvedValueOnce(listing(["c"], null));
    const emitted: string[] = [];
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.totalFetched).toBe(3);
    expect(emitted).toEqual(["reddit:a", "reddit:b", "reddit:c"]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[1][0]).toContain("after=t3_b");
  });

  it("stops at the 1000-item hard cap", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValue(listing(Array.from({length:100},(_,i)=>"x"+i), "t3_more"));
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 100, earlyOutThreshold: 3, maxItems: null, hardCap: 250, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(res.totalFetched).toBe(100); // stops at the hard cap; 100 unique emitted, raw scan hit the 250 cap
    expect(res.hitHardCap).toBe(true);
  });

  it("dedupes ids seen across pages", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValueOnce(listing(["a", "b"], "t3_b")).mockResolvedValueOnce(listing(["b", "c"], null));
    const emitted: string[] = [];
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(emitted).toEqual(["reddit:a", "reddit:b", "reddit:c"]); // b not re-emitted
    expect(res.totalFetched).toBe(3);
  });

  it("filters non-t3 children", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValue({ status: 200, body: JSON.stringify({ kind: "Listing", data: { after: null, children: [ { kind: "t1", data: { id: "cmt" } }, { kind: "t3", data: { id: "post", permalink: "/r/x/comments/post/t/", created_utc: 1700000000, author: "u", subreddit: "x" } } ] } }) });
    const emitted: string[] = [];
    await paginateSaved({ fetch, sleep: async () => {}, onRecords: async (rs) => { emitted.push(...rs.map(r => r.id)); }, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {} });
    expect(emitted).toEqual(["reddit:post"]);
  });

  it("backs off then aborts on 429", async () => {
    const fetch: RedditFetch = vi.fn().mockResolvedValue({ status: 429, body: "" });
    const res = await paginateSaved({ fetch, sleep: async () => {}, onRecords: async () => {}, knownIds: new Set(), prevComplete: false, batchSize: 1, earlyOutThreshold: 3, maxItems: null, hardCap: 1000, isStopped: () => false, onLog: () => {}, onProgress: () => {}, maxBackoffRetries: 2 });
    expect(res.abortedRateLimited).toBe(true);
  });
});
