import { describe, it, expect } from "vitest";
import { cleanCaption, splitCaption } from "@/lib/caption";

describe("cleanCaption", () => {
  it("strips a trailing hashtag block", () => {
    expect(cleanCaption("Great yoga class #thelinehotel #atx #austinyoga"))
      .toBe("Great yoga class");
  });

  it("preserves inline hashtags mid-sentence", () => {
    expect(cleanCaption("Back at #thelinehotel soon")).toBe("Back at #thelinehotel soon");
  });

  it("strips leading 📍/emoji noise", () => {
    expect(cleanCaption("📍 The LINE Austin")).toBe("The LINE Austin");
    expect(cleanCaption("✨🔥 Great spot #tag")).toBe("Great spot");
  });

  it("collapses whitespace", () => {
    expect(cleanCaption("A   caption\n\nwith\tgaps  #tag")).toBe("A caption with gaps");
  });
});

describe("splitCaption", () => {
  it("returns title-only for short captions", () => {
    expect(splitCaption("Cute dog at the park #dogs")).toEqual({
      title: "Cute dog at the park",
      description: null,
    });
  });

  it("splits at first sentence boundary for long captions", () => {
    const raw =
      "The Art of Blossoming class at the LINE. @thelinehotel now holds wellness classes in this space. Will be back soon #thelinehotel #atx";
    const { title, description } = splitCaption(raw);
    expect(title).toBe("The Art of Blossoming class at the LINE.");
    expect(description).toContain("wellness classes");
    expect(description).not.toContain("#thelinehotel");
  });

  it("falls back to word-boundary cut when no sentence boundary found", () => {
    const raw =
      "wow this place is seriously the most underrated rooftop bar in all of lower manhattan come check it out";
    const { title, description } = splitCaption(raw);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith(" ")).toBe(false);
    expect(description).toBeTruthy();
  });
});
