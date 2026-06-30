// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { renderLinkCard } from "@/views/link-card-renderer";

describe("renderLinkCard", () => {
  it("renders title, site, image and tags the element with the url", () => {
    const parent = document.createElement("div");
    const el = renderLinkCard(parent, {
      url: "https://arxiv.org/abs/1706.03762",
      title: "Attention Is All You Need",
      description: "We propose…",
      site: "arxiv.org",
      imageSrc: "app://x/p.jpg",
    });
    expect(el).not.toBeNull();
    expect(el!.dataset.linkUrl).toBe("https://arxiv.org/abs/1706.03762");
    expect(parent.querySelector(".roost-linkcard-title")!.textContent).toBe("Attention Is All You Need");
    expect(parent.querySelector(".roost-linkcard-site")!.textContent).toContain("arxiv.org");
    expect((parent.querySelector(".roost-linkcard-thumb") as HTMLElement).style.backgroundImage).toContain("app://x/p.jpg");
  });

  it("renders nothing and returns null when url is missing", () => {
    const parent = document.createElement("div");
    expect(renderLinkCard(parent, { url: "" })).toBeNull();
    expect(parent.children.length).toBe(0);
  });

  it("compact mode adds the compact class (stacked layout)", () => {
    const parent = document.createElement("div");
    const el = renderLinkCard(parent, { url: "https://x.com", title: "T" }, { compact: true });
    expect(el!.classList.contains("roost-linkcard-compact")).toBe(true);
  });
});
