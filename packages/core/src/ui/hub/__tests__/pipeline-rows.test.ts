import { describe, it, expect } from "vitest";
import { buildPipelineRows } from "@/ui/hub/pipeline-rows";

const allOn = { recipe: true, place: true, mediaExtraction: true, product: true, workout: true, tutorial: true, home: true };

describe("buildPipelineRows", () => {
  it("one row per pipeline with label + status", () => {
    const rows = buildPipelineRows(allOn, true);
    expect(rows.map(r => r.id).sort()).toEqual(["home","mediaExtraction","place","product","recipe","tutorial","workout"]);
    expect(rows.every(r => r.label.length > 0)).toBe(true);
  });
  it("status active when on + llm", () => {
    expect(buildPipelineRows(allOn, true).find(r => r.id === "recipe")!.status).toBe("active");
  });
  it("status needs-llm when on but no llm", () => {
    expect(buildPipelineRows(allOn, false).find(r => r.id === "recipe")!.status).toBe("needs-llm");
  });
  it("status off when flag off", () => {
    expect(buildPipelineRows({ ...allOn, recipe: false }, true).find(r => r.id === "recipe")!.status).toBe("off");
  });
});
