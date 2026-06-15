import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestTimeout } from "./limits";

describe("requestTimeout", () => {
  it("calls next() immediately and does not interfere on fast requests", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), on: vi.fn() } as unknown as Response;
    requestTimeout(5000)({} as Request, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("returns 504 if the request exceeds the timeout", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), on: vi.fn() } as unknown as Response;
    requestTimeout(1000)({} as Request, res, next);
    vi.advanceTimersByTime(1001);
    expect(res.status).toHaveBeenCalledWith(504);
    vi.useRealTimers();
  });

  it("does nothing if headers were already sent before the timeout fires", () => {
    vi.useFakeTimers();
    const next: NextFunction = vi.fn();
    const res = { headersSent: true, status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis(), on: vi.fn() } as unknown as Response;
    requestTimeout(1000)({} as Request, res, next);
    vi.advanceTimersByTime(1001);
    expect(res.status).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
