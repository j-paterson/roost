import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Bearer-token middleware. Returns 401 unless `Authorization: Bearer <token>`
 * matches the expected token via constant-time compare.
 */
export function bearerAuth(expectedToken: string) {
  if (!expectedToken) {
    throw new Error("bearerAuth: expectedToken must be a non-empty string");
  }
  const expected = Buffer.from(expectedToken, "utf8");

  return function (req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;
    if (!header || typeof header !== "string") {
      reject(res);
      return;
    }
    const idx = header.indexOf(" ");
    if (idx <= 0) {
      reject(res);
      return;
    }
    const scheme = header.slice(0, idx);
    const presented = header.slice(idx + 1);
    if (scheme.toLowerCase() !== "bearer" || presented.length === 0) {
      reject(res);
      return;
    }
    const got = Buffer.from(presented, "utf8");
    if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
      reject(res);
      return;
    }
    next();
  };
}

function reject(res: Response): void {
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Unauthorized" },
    id: null,
  });
}
