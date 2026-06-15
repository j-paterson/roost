import { describe, it, expect } from "vitest";
import express from "express";
import { healthRouter } from "./health";

async function get(app: express.Express, path: string) {
  const { default: supertest } = await import("supertest");
  return supertest(app).get(path);
}

describe("healthRouter", () => {
  it("returns 200 with status=ok at /healthz", async () => {
    const app = express();
    app.use(healthRouter);
    const res = await get(app, "/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});
