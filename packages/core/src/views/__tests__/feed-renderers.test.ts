import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import type { BasesEntry } from "obsidian";

// Isolate the link-card call-site guard: heavy card rendering is out of scope.
vi.mock("@/ui/components/expanded-card", () => ({ renderExpandedCard: vi.fn() }));
vi.mock("@/views/entry-to-expanded-card", () => ({ entryToExpandedCardData: vi.fn(() => ({})) }));
vi.mock("@/views/feed/card-helpers", () => ({
  resolveImageUrl: vi.fn(() => null),
  resolveVideoUrl: vi.fn(() => null),
  resolveAllImages: vi.fn(() => []),
}));
vi.mock("@/views/link-card-renderer", () => ({ renderLinkCard: vi.fn(() => null) }));

import { renderLinkCard } from "@/views/link-card-renderer";
import { inferFeedPlatform, maybeAppendTrainingBar, renderFeedItem, type FeedRenderContext } from "@/views/feed/feed-renderers";

function makeEntry(values: Record<string, unknown>): BasesEntry {
  return { getValue: (k: string) => values[k] ?? null, file: { basename: "x" } } as unknown as BasesEntry;
}

describe("inferFeedPlatform", () => {
  it("returns tiktok for note.platform === 'tiktok'", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "tiktok" }))).toBe("tiktok");
  });

  it("returns x for note.platform === 'twitter'", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "twitter" }))).toBe("x");
  });

  it("returns default for other or missing platforms", () => {
    expect(inferFeedPlatform(makeEntry({ "note.platform": "youtube" }))).toBe("default");
    expect(inferFeedPlatform(makeEntry({}))).toBe("default");
  });
});

describe("maybeAppendTrainingBar — review-pass guess override", () => {
  const baseCtx = (over: Partial<FeedRenderContext>): FeedRenderContext => ({
    app: {} as never,
    imagePropId: "note.cover",
    trainingMode: true,
    onTrainingAction: vi.fn(),
    onAction: vi.fn(),
    ...over,
  });

  it("renders the guess + action bar from guessFor when frontmatter has NO category (staged proposal)", () => {
    // The real-world bug: staged Smart Assign proposals aren't written to frontmatter,
    // so readGuess returns null. guessFor supplies the proposed category.
    const el = document.createElement("div");
    const entry = makeEntry({ "note.roost_id": "twitter:1" }); // no roost_category
    maybeAppendTrainingBar(el, entry, baseCtx({ guessFor: () => "Tech" }), "twitter:1");

    const banner = el.querySelector(".roost-training-guess");
    expect(banner?.textContent).toBe("Roost guessed: Tech");
    // The confirm/reject/move/skip controls must be present (were entirely missing before).
    expect(el.querySelector('[data-action="confirm"]')).not.toBeNull();
    expect(el.querySelector('[data-action="reject"]')).not.toBeNull();
    expect(el.querySelector('[data-action="recategorize"]')).not.toBeNull();
    expect(el.querySelector('[data-action="skip"]')).not.toBeNull();
  });

  it("falls back to the frontmatter guess when guessFor returns null (regular Train mode)", () => {
    const el = document.createElement("div");
    const entry = makeEntry({ "note.roost_id": "twitter:2", "note.roost_category": "Design" });
    maybeAppendTrainingBar(el, entry, baseCtx({ guessFor: () => null }), "twitter:2");
    expect(el.querySelector(".roost-training-guess")?.textContent).toBe("Roost guessed: Design");
  });

  it("renders nothing when neither guessFor nor frontmatter yields a category", () => {
    const el = document.createElement("div");
    const entry = makeEntry({ "note.roost_id": "twitter:3" }); // no category
    maybeAppendTrainingBar(el, entry, baseCtx({ guessFor: () => null }), "twitter:3");
    expect(el.children.length).toBe(0);
  });
});

describe("renderFeedItem — link card guarded against Bases 'null' wrapper sentinels", () => {
  beforeAll(() => {
    const proto = HTMLElement.prototype as any;
    if (!proto.createDiv) {
      proto.createDiv = function (opts?: { cls?: string; text?: string }) {
        const d = document.createElement("div");
        if (opts?.cls) d.className = opts.cls;
        if (opts?.text) d.textContent = opts.text;
        this.appendChild(d);
        return d;
      };
    }
    const p = HTMLElement.prototype as any;
    if (!p.addClass) p.addClass = function (cls: string) { this.classList.add(cls); };
    if (!p.removeClass) p.removeClass = function (cls: string) { this.classList.remove(cls); };
    if (!p.empty) p.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
  });

  beforeEach(() => { vi.mocked(renderLinkCard).mockClear(); });

  const ctx = { app: {} as never, imagePropId: "note.cover", onAction: vi.fn() } as unknown as FeedRenderContext;
  // A Base that declares the link_url column hands back a Value wrapper whose
  // toString() is the literal "null" for notes lacking the field.
  const nullWrapper = { toString: () => "null" };

  it("does NOT render a link card when link fields are 'null' wrapper sentinels (the null/null/null box)", () => {
    const entry = makeEntry({
      "note.roost_id": "twitter:10",
      "note.platform": "twitter",
      "note.link_url": nullWrapper,
      "note.link_title": nullWrapper,
      "note.link_desc": nullWrapper,
      "note.link_site": nullWrapper,
    });
    renderFeedItem(document.createElement("div"), entry, ctx);
    expect(renderLinkCard).not.toHaveBeenCalled();
  });

  it("still renders the link card for a real link_url, with sentinel fields collapsed to undefined", () => {
    const entry = makeEntry({
      "note.roost_id": "reddit:11",
      "note.platform": "reddit",
      "note.link_url": "https://example.com/article",
      "note.link_title": "A real title",
      "note.link_desc": nullWrapper, // absent in the note — must not render as "null"
      "note.link_site": "example.com",
    });
    renderFeedItem(document.createElement("div"), entry, ctx);
    expect(renderLinkCard).toHaveBeenCalledOnce();
    const [, data] = vi.mocked(renderLinkCard).mock.calls[0];
    expect(data).toMatchObject({
      url: "https://example.com/article",
      title: "A real title",
      site: "example.com",
    });
    expect(data.description).toBeUndefined();
  });
});
