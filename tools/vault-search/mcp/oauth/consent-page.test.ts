import { describe, it, expect } from "vitest";
import { renderConsentPage, escapeHtml } from "./consent-page";

describe("escapeHtml", () => {
  it("escapes & < > \" '", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("renderConsentPage", () => {
  it("contains the client name escaped", () => {
    const html = renderConsentPage({
      clientName: '<script>alert(1)</script>',
      hiddenParams: { client_id: "abc" },
      errorMessage: undefined,
    });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("includes a hidden input for each param", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: { client_id: "c1", state: "s", code_challenge: "ch" },
      errorMessage: undefined,
    });
    expect(html).toContain('name="client_id" value="c1"');
    expect(html).toContain('name="state" value="s"');
    expect(html).toContain('name="code_challenge" value="ch"');
  });

  it("renders an error message when provided", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: "Invalid token",
    });
    expect(html).toContain("Invalid token");
  });

  it("does not render the error <p> block when errorMessage is undefined", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).not.toMatch(/<p[^>]*class="error"/);
    expect(html).not.toContain("Invalid token");
  });

  it("posts to /authorize", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).toContain('action="/authorize"');
    expect(html).toContain('method="post"');
  });

  it("has a password input named 'bearer_token'", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).toContain('name="bearer_token"');
    expect(html).toContain('type="password"');
  });

  it("disables form-level autocomplete (prevents browser caching of bearer token)", () => {
    const html = renderConsentPage({
      clientName: "Claude",
      hiddenParams: {},
      errorMessage: undefined,
    });
    expect(html).toMatch(/<form[^>]*autocomplete="off"/);
  });
});
