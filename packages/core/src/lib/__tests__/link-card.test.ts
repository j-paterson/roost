import { describe, it, expect } from "vitest";
import { domainFromUrl } from "@/lib/link-card";

describe("domainFromUrl", () => {
  it("strips scheme + www and lowercases", () => {
    expect(domainFromUrl("https://www.NYTimes.com/2024/article")).toBe("nytimes.com");
  });
  it("keeps non-www subdomains", () => {
    expect(domainFromUrl("https://arxiv.org/abs/1706.03762")).toBe("arxiv.org");
    expect(domainFromUrl("https://blog.example.co.uk/x")).toBe("blog.example.co.uk");
  });
  it("returns null for junk", () => {
    expect(domainFromUrl("not a url")).toBeNull();
    expect(domainFromUrl("")).toBeNull();
  });
});
