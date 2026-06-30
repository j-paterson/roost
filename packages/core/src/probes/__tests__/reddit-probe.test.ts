import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PROBE = fs.readFileSync(
  path.resolve(__dirname, "../reddit-probe.js"), "utf-8",
);

/** Evaluate the probe IIFE against a fake window/fetch. */
function installProbe(win: Record<string, unknown>) {
  const fn = new Function("window", `${PROBE}; return window;`);
  return fn(win);
}

describe("reddit-probe", () => {
  let win: Record<string, unknown>;
  beforeEach(() => {
    win = {};
  });

  it("__roostRedditFetch sends credentials:include and returns {status,body}", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ kind: "Listing", data: { children: [] } }),
    }));
    win.fetch = fetchMock;
    installProbe(win);

    const raw = await (win.__roostRedditFetch as (p: string) => Promise<string>)(
      "/r/programming/saved.json",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe(200);
    expect(JSON.parse(parsed.body).kind).toBe("Listing");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { credentials: string },
    ];
    expect(url).toBe("/r/programming/saved.json");
    expect(init.credentials).toBe("include");
  });

  it("__roostRedditFetch returns status -1 on throw (never rejects)", async () => {
    win.fetch = vi.fn(async () => {
      throw new Error("network down");
    });
    installProbe(win);
    const raw = await (win.__roostRedditFetch as (p: string) => Promise<string>)(
      "/r/x/saved.json",
    );
    expect(JSON.parse(raw).status).toBe(-1);
  });
});
