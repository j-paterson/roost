import type { Request, Response, NextFunction } from "express";
import { RecentRing } from "./recent";

export interface LogEntry {
  ts: string;
  method: string;
  url: string;
  mcpMethod?: string;
  toolName?: string;
  status: number;
  latencyMs: number;
}

export function requestLogger(opts: {
  log?: (entry: LogEntry) => void;
  ring?: RecentRing<LogEntry>;
} = {}) {
  const log = opts.log ?? ((entry) => console.error(JSON.stringify(entry)));
  const ring = opts.ring;

  return function (req: Request, res: Response, next: NextFunction): void {
    const start = Date.now();
    const body = req.body as { method?: unknown; params?: { name?: unknown } } | undefined;
    const mcpMethod = typeof body?.method === "string" ? body.method : undefined;
    const toolName = typeof body?.params?.name === "string" ? body.params.name : undefined;

    res.on("finish", () => {
      const entry: LogEntry = {
        ts: new Date().toISOString(),
        method: req.method,
        url: req.originalUrl,
        mcpMethod,
        toolName,
        status: res.statusCode,
        latencyMs: Date.now() - start,
      };
      log(entry);
      ring?.push(entry);
    });
    next();
  };
}
