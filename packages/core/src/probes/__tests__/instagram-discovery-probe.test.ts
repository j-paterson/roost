// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(resolve(__dirname, "../instagram-discovery.js"), "utf8");

// Snapshot the pristine globals the probe wraps, so each test starts unwrapped
// (the probe monkey-patches window.fetch + XMLHttpRequest.prototype in place).
const ORIG_FETCH = window.fetch;
const ORIG_OPEN = XMLHttpRequest.prototype.open;
const ORIG_SEND = XMLHttpRequest.prototype.send;
const ORIG_SETH = XMLHttpRequest.prototype.setRequestHeader;

function injectProbe() {
  // The probe is an IIFE that mutates window — eval it in the happy-dom global.
  // eslint-disable-next-line no-eval
  (0, eval)(SRC);
}

describe("instagram-discovery probe", () => {
  beforeEach(() => { delete (window as any).__INSTAGRAM_DISCOVERY__; });
  afterEach(() => {
    window.fetch = ORIG_FETCH;
    XMLHttpRequest.prototype.open = ORIG_OPEN;
    XMLHttpRequest.prototype.send = ORIG_SEND;
    XMLHttpRequest.prototype.setRequestHeader = ORIG_SETH;
  });

  it("installs the discovery store and wraps fetch", () => {
    injectProbe();
    const store = (window as any).__INSTAGRAM_DISCOVERY__;
    expect(store).toBeDefined();
    expect(store.installed).toBe(true);
    expect(Array.isArray(store.observedCalls)).toBe(true);
    expect(typeof window.fetch).toBe("function");
  });

  it("records an instagram API fetch into observedCalls", async () => {
    // Stub the native fetch BEFORE injecting so the probe wraps our stub.
    (window as any).fetch = async () =>
      new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
    injectProbe();
    await window.fetch("https://www.instagram.com/api/v1/feed/saved/posts/?max_id=A", {
      method: "GET", headers: { "x-ig-app-id": "936" },
    });
    const store = (window as any).__INSTAGRAM_DISCOVERY__;
    expect(store.observedCalls.length).toBe(1);
    expect(store.observedCalls[0].url).toContain("/api/v1/feed/saved");
  });

  it("ignores non-API instagram URLs (CDN media)", async () => {
    (window as any).fetch = async () => new Response("img", { status: 200 });
    injectProbe();
    await window.fetch("https://scontent-xx.cdninstagram.com/v/photo.jpg");
    expect((window as any).__INSTAGRAM_DISCOVERY__.observedCalls.length).toBe(0);
  });
});
