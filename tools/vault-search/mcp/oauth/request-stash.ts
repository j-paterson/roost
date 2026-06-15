import type { Request, Response } from "express";

const stash = new WeakMap<Response, Request>();

export function stashRequest(req: Request, res: Response): void {
  stash.set(res, req);
}

export function getStashedRequest(res: Response): Request | undefined {
  return stash.get(res);
}
