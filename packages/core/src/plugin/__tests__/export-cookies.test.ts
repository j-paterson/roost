import { describe, it, expect } from "vitest";
import { toExportCookies } from "@/plugin/export-cookies";

describe("toExportCookies", () => {
  it("maps an x.com cookie to the export shape (preserves prior X behavior)", () => {
    const out = toExportCookies(
      [{ name: "auth_token", value: "abc", domain: ".x.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", expirationDate: 123 }],
      "https://x.com",
    );
    expect(out).toEqual([
      {
        url: "https://x.com",
        name: "auth_token",
        value: "abc",
        domain: ".x.com",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "no_restriction",
        expirationDate: 123,
      },
    ]);
  });

  it("maps an instagram cookie using the instagram origin host", () => {
    const out = toExportCookies(
      [{ name: "sessionid", value: "xyz", domain: ".instagram.com", path: "/" }],
      "https://www.instagram.com",
    );
    expect(out[0]).toMatchObject({
      url: "https://www.instagram.com",
      name: "sessionid",
      value: "xyz",
      domain: ".instagram.com",
      path: "/",
    });
  });

  it("falls back to the origin host-derived domain when a cookie omits domain", () => {
    const out = toExportCookies([{ name: "csrftoken", value: "t" }], "https://www.instagram.com");
    expect(out[0].domain).toBe(".instagram.com");
    expect(out[0].url).toBe("https://www.instagram.com");
    expect(out[0].path).toBe("/");
  });

  it("omits expirationDate when the raw cookie has none", () => {
    const out = toExportCookies([{ name: "n", value: "v", domain: ".x.com" }], "https://x.com");
    expect("expirationDate" in out[0]).toBe(false);
  });
});
