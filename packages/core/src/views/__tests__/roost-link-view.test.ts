// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { buildLinkViewHeader } from "@/views/roost-link-view";

describe("buildLinkViewHeader", () => {
  it("shows the domain and an open-in-browser action for a url", () => {
    const host = document.createElement("div");
    buildLinkViewHeader(host, "https://www.arxiv.org/abs/1706.03762");
    expect(host.querySelector(".roost-linkview-domain")!.textContent).toBe("arxiv.org");
    expect(
      host.querySelector("a.roost-linkview-open")!.getAttribute("href"),
    ).toBe("https://www.arxiv.org/abs/1706.03762");
  });
});
