import { describe, it, expect } from "vitest";
import { buildPipelineRows } from "@/ui/hub/pipeline-rows";
import type { PipelinesPending } from "@/ui/hub/state";

// PipelineFlags is Record<PipelineId, boolean> — PipelineId also covers the
// enrichment ids (playback/articleBody/thread/mediaFiles/tweetBody/transcript),
// which buildPipelineRows doesn't render as rows but must be present to satisfy
// the type.
const allOn = {
  recipe: true, place: true, mediaExtraction: true, product: true, workout: true, tutorial: true, home: true,
  playback: true, articleBody: true, thread: true, mediaFiles: true, tweetBody: true, transcript: true,
};

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
  it("defaults pending and stale to 0 when no pendingPipelines supplied", () => {
    const row = buildPipelineRows(allOn, true).find(r => r.id === "recipe")!;
    expect(row.pending).toBe(0);
    expect(row.stale).toBe(0);
  });
  it("threads pending/stale onto the matching pipeline row", () => {
    const pending: PipelinesPending = {
      total: 5,
      byPipeline: [
        { id: "recipe", pending: 5, stale: 2, blocked: false },
        { id: "place", pending: 0, stale: 1, blocked: false },
      ],
    };
    const rows = buildPipelineRows(allOn, true, pending);
    const recipe = rows.find(r => r.id === "recipe")!;
    expect(recipe.pending).toBe(5);
    expect(recipe.stale).toBe(2);
    const place = rows.find(r => r.id === "place")!;
    expect(place.pending).toBe(0);
    expect(place.stale).toBe(1);
  });
  it("off/needs-llm rows still get pending counts (panel suppresses the badge)", () => {
    const pending: PipelinesPending = {
      total: 3,
      byPipeline: [{ id: "recipe", pending: 3, stale: 0, blocked: false }],
    };
    const offRow = buildPipelineRows({ ...allOn, recipe: false }, true, pending).find(r => r.id === "recipe")!;
    expect(offRow.pending).toBe(3); // count is threaded; the panel decides whether to render it
  });
});
