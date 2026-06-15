import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { hostAllowlist, parseAllowedHosts } from "./hosts";

function mockReq(host: string | undefined, path = "/mcp"): Request {
  return { headers: { host }, path } as unknown as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("parseAllowedHosts", () => {
  it("returns [] for empty / undefined input", () => {
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
    expect(parseAllowedHosts("   ")).toEqual([]);
  });
  it("trims and lowercases", () => {
    expect(parseAllowedHosts("Foo.com, BAR:80 ")).toEqual(["foo.com", "bar:80"]);
  });
  it("ignores empty entries from extra commas", () => {
    expect(parseAllowedHosts("a,,b,")).toEqual(["a", "b"]);
  });
});

describe("hostAllowlist middleware", () => {
  it("is a no-op when allowed list is empty", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist([])(mockReq("any.host"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("allows requests with an allowlisted Host", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com", "bar:80"])(mockReq("foo.com"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("matches case-insensitively", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("FOO.COM"), res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 421 on disallowed Host", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("evil.example"), res, next);
    expect(res.status).toHaveBeenCalledWith(421);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 421 when Host header is missing", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq(undefined), res, next);
    expect(res.status).toHaveBeenCalledWith(421);
    expect(next).not.toHaveBeenCalled();
  });

  it("exempts /healthz from the check", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    hostAllowlist(["foo.com"])(mockReq("anything", "/healthz"), res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
