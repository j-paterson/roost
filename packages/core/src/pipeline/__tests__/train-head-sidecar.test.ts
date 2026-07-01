import { describe, it, expect } from "vitest";
import { __setRequestUrlImpl, __resetRequestUrlImpl } from "obsidian";
import { trainStackedHeadsViaSidecar } from "@/pipeline/train-head-sidecar";
import type { TrainingRow } from "@/pipeline/train-head";

const rows: TrainingRow[] = [
  { id: "a", vecText: [0], vecVision: [0], category: "x", ts: 1 },
  { id: "b", vecText: [0], vecVision: [0], category: "y", ts: 2 },
];
const heads = {
  text: { classes: ["x", "y"], W: [[1], [2]], b: [0, 0], dim: 1, norm: "l2", trainedOn: 2, version: 1 },
  vision: { classes: ["x", "y"], W: [[1], [2]], b: [0, 0], dim: 1, norm: "l2", trainedOn: 2, version: 1 },
  meta: { classes: ["x", "y"], W: [[1, 1, 1, 1]], b: [0], inDim: 4, norm: "none", version: 1 },
};

describe("trainStackedHeadsViaSidecar", () => {
  it("sends only {id,category} + oofFolds and returns parsed heads on 200", async () => {
    let sent: any = null;
    __setRequestUrlImpl(async (req: any) => {
      sent = JSON.parse(req.body);
      return { status: 200, json: heads, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) };
    });
    const out = await trainStackedHeadsViaSidecar(rows, 3);
    __resetRequestUrlImpl();
    expect(sent).toEqual({ rows: [{ id: "a", category: "x" }, { id: "b", category: "y" }], oofFolds: 3 });
    expect(out?.text.classes).toEqual(["x", "y"]);
    expect(out?.meta.inDim).toBe(4);
  });

  it("returns null on non-2xx", async () => {
    __setRequestUrlImpl(async () => ({ status: 500, json: { error: "boom" }, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) }));
    const out = await trainStackedHeadsViaSidecar(rows, 3);
    __resetRequestUrlImpl();
    expect(out).toBeNull();
  });

  it("returns null when requestUrl throws (sidecar down)", async () => {
    __setRequestUrlImpl(async () => { throw new Error("ECONNREFUSED"); });
    const out = await trainStackedHeadsViaSidecar(rows, 3);
    __resetRequestUrlImpl();
    expect(out).toBeNull();
  });

  it("returns null on malformed response (missing heads)", async () => {
    __setRequestUrlImpl(async () => ({ status: 200, json: { text: {} }, text: "", headers: {}, arrayBuffer: new ArrayBuffer(0) }));
    const out = await trainStackedHeadsViaSidecar(rows, 3);
    __resetRequestUrlImpl();
    expect(out).toBeNull();
  });
});
