import type { Request, Response, NextFunction } from "express";

/** Parse a comma-separated list into a normalized lowercase array. */
export function parseAllowedHosts(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Reject requests whose Host header is not in the allowed list.
 * Empty allowed list = no-op (preserves backwards compatibility).
 * /healthz is always exempt.
 */
export function hostAllowlist(allowed: string[]) {
  const set = new Set(allowed.map((h) => h.toLowerCase()));
  const enabled = set.size > 0;

  return function (req: Request, res: Response, next: NextFunction): void {
    if (!enabled) {
      next();
      return;
    }
    if (req.path === "/healthz") {
      next();
      return;
    }
    const host = (req.headers.host || "").toLowerCase();
    if (!host || !set.has(host)) {
      res.status(421).send();
      return;
    }
    next();
  };
}
