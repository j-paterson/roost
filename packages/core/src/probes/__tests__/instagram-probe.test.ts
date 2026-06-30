import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

const PROBE = fs.readFileSync(
  path.resolve(__dirname, "../instagram-probe.js"), "utf-8",
);

/** Evaluate the probe IIFE against a fake window/document/fetch. */
function installProbe(win: Record<string, unknown>) {
  // FileReader is added as a 4th parameter so the probe's `new FileReader()`
  // picks up win.FileReader (the test shim) rather than the happy-dom global.
  const fn = new Function("window", "document", "XMLHttpRequest", "FileReader", `${PROBE}; return window;`);
  return fn(win, win.document, win.XMLHttpRequest, win.FileReader);
}

describe("instagram-probe", () => {
  let win: Record<string, unknown>;
  beforeEach(() => {
    win = {
      document: { cookie: "csrftoken=TOKEN123; sessionid=abc" },
      XMLHttpRequest: function () {},
      __ig_www_claim: "0",
    };
  });

  it("__roostIgFetch sends auth headers and captures the returned www-claim", async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: { get: (k: string) => (k === "x-ig-set-www-claim" ? "hmac.AR3xyz" : null) },
      text: async () => JSON.stringify({ items: [], more_available: false }),
    }));
    win.fetch = fetchMock;
    installProbe(win);

    const raw = await (win.__roostIgFetch as (p: string) => Promise<string>)("/api/v1/feed/saved/posts/?count=5");
    const parsed = JSON.parse(raw);
    expect(parsed.status).toBe(200);
    expect(JSON.parse(parsed.body).more_available).toBe(false);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers["X-IG-App-ID"]).toBe("936619743392459");
    expect(init.headers["X-CSRFToken"]).toBe("TOKEN123");
    // www-claim from the response is captured for resend
    expect(win.__ig_www_claim).toBe("hmac.AR3xyz");
  });

  it("__roostIgFetch returns status -1 on throw (never rejects)", async () => {
    win.fetch = vi.fn(async () => { throw new Error("network down"); });
    installProbe(win);
    const raw = await (win.__roostIgFetch as (p: string) => Promise<string>)("/api/v1/x/");
    expect(JSON.parse(raw).status).toBe(-1);
  });

  it("__roostIgFetchMediaBase64 returns a data URL", async () => {
    win.fetch = vi.fn(async () => ({
      blob: async () => ({}),
    }));
    // FileReader shim
    (win as Record<string, unknown>).FileReader = class {
      result = "data:image/jpeg;base64,QUJD";
      onload: (() => void) | null = null;
      readAsDataURL() { setTimeout(() => this.onload && this.onload(), 0); }
    };
    installProbe(win);
    const out = await (win.__roostIgFetchMediaBase64 as (u: string) => Promise<string | null>)("https://cdn/x.jpg");
    expect(out).toBe("data:image/jpeg;base64,QUJD");
  });
});
