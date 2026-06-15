import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import { stashRequest, getStashedRequest } from "./request-stash";

describe("request-stash", () => {
  it("stores and retrieves the request keyed by response", () => {
    const req = {} as Request;
    const res = {} as Response;
    stashRequest(req, res);
    expect(getStashedRequest(res)).toBe(req);
  });

  it("returns undefined for unknown response", () => {
    expect(getStashedRequest({} as Response)).toBeUndefined();
  });
});
