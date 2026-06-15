import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import { requestLogger } from "./logging";

function mockReq(body: unknown): Request {
  return { method: "POST", body, originalUrl: "/mcp" } as Request;
}

function mockRes() {
  const handlers: Record<string, () => void> = {};
  const res: Partial<Response> = {
    statusCode: 200,
    on: ((evt: string, cb: () => void) => {
      handlers[evt] = cb;
      return res as Response;
    }) as Response["on"],
  };
  return { res: res as Response, fire: (evt: string) => handlers[evt]?.() };
}

describe("requestLogger", () => {
  it("logs method, tool name, status, and latency on response finish", () => {
    const log = vi.fn();
    const next: NextFunction = vi.fn();
    const { res, fire } = mockRes();

    requestLogger({ log })(
      mockReq({ method: "tools/call", params: { name: "search_vault" } }),
      res,
      next,
    );
    expect(next).toHaveBeenCalled();
    fire("finish");

    expect(log).toHaveBeenCalledOnce();
    const entry = log.mock.calls[0][0] as Record<string, unknown>;
    expect(entry.method).toBe("POST");
    expect(entry.mcpMethod).toBe("tools/call");
    expect(entry.toolName).toBe("search_vault");
    expect(entry.status).toBe(200);
    expect(typeof entry.latencyMs).toBe("number");
  });

  it("does not include query content", () => {
    const log = vi.fn();
    const next: NextFunction = vi.fn();
    const { res, fire } = mockRes();
    requestLogger({ log })(
      mockReq({
        method: "tools/call",
        params: { name: "search_vault", arguments: { query: "secret stuff" } },
      }),
      res,
      next,
    );
    fire("finish");
    const json = JSON.stringify(log.mock.calls[0][0]);
    expect(json).not.toContain("secret stuff");
  });
});
