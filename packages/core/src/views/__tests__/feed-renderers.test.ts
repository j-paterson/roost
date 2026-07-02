import { describe, it, expect, vi } from "vitest";
import type { BasesEntry } from "obsidian";
import { inferFeedPlatform, maybeAppendTrainingBar, type FeedRenderContext } from "@/views/feed/feed-renderers";

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
