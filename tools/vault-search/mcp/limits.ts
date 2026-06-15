import type { Request, Response, NextFunction } from "express";
import express from "express";

/** Per-request timeout. Returns 504 if a response hasn't been sent in time. */
export function requestTimeout(ms: number) {
  return function (_req: Request, res: Response, next: NextFunction): void {
    const t = setTimeout(() => {
      if (!res.headersSent) {
        res.status(504).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Request timeout" },
          id: null,
        });
      }
    }, ms);
    res.on("finish", () => clearTimeout(t));
    res.on("close", () => clearTimeout(t));
    next();
  };
}

/** JSON body parser with a hard size cap (default 1 MB). Exported for completeness; not mounted by default. */
export function jsonBodyLimit(limit = "1mb") {
  return express.json({ limit });
}
