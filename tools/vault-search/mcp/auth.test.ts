import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { bearerAuth } from "./auth";

function mockReq(authHeader?: string): Request {
  return { headers: authHeader ? { authorization: authHeader } : {} } as Request;
}

function mockRes() {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe("bearerAuth", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("calls next() when token matches", () => {
    const next: NextFunction = vi.fn();
    const mw = bearerAuth(TOKEN);
    mw(mockReq(`Bearer ${TOKEN}`), mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns 401 when Authorization header is missing", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token is wrong", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq("Bearer wrong"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when scheme is not Bearer", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(`Basic ${TOKEN}`), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when header is malformed (no space)", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq("Bearer"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when token differs in length only", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(`Bearer ${TOKEN}x`), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("throws if constructed with empty token", () => {
    expect(() => bearerAuth("")).toThrow();
  });

  it("returns 401 when Authorization header is an array", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    // Simulate Express giving us an array-valued header
    const req = { headers: { authorization: [`Bearer ${TOKEN}`, "Bearer other"] as unknown as string } } as Request;
    bearerAuth(TOKEN)(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when there are extra spaces between scheme and token", () => {
    const next: NextFunction = vi.fn();
    const res = mockRes();
    bearerAuth(TOKEN)(mockReq(`Bearer  ${TOKEN}`), res, next);  // two spaces
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
