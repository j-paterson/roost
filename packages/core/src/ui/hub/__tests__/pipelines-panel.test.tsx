// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PipelinesPanel } from "@/ui/hub/pipelines-panel";
import { buildPipelineRows } from "@/ui/hub/pipeline-rows";

// PipelineFlags is Record<PipelineId, boolean>, which also includes the
// enrichment ids (playback/articleBody/thread/mediaFiles) — present here only
// to satisfy the type; the panel renders just the 7 pipeline rows.
const allOn = {
  recipe: true, place: true, mediaExtraction: true, product: true, workout: true, tutorial: true, home: true,
  playback: true, articleBody: true, thread: true, mediaFiles: true,
};
afterEach(cleanup);

describe("PipelinesPanel", () => {
  it("renders a row per pipeline (recipe label present)", () => {
    const rows = buildPipelineRows(allOn, true);
    render(<PipelinesPanel rows={rows} llm={true} onToggle={() => {}} />);
    // use the actual recipe label from the rows so this is robust to the displayName text
    expect(screen.getByText(rows.find(r => r.id === "recipe")!.label)).toBeTruthy();
  });
  it("shows a connect-an-LLM header when no LLM", () => {
    render(<PipelinesPanel rows={buildPipelineRows(allOn, false)} llm={false} onToggle={() => {}} />);
    expect(screen.getByText(/connect.*llm/i)).toBeTruthy();
  });
  it("disables toggle buttons when no LLM", () => {
    const rows = buildPipelineRows(allOn, true);
    const recipeLabel = rows.find(r => r.id === "recipe")!.label;
    render(<PipelinesPanel rows={rows} llm={false} onToggle={() => {}} />);
    const btn = screen.getByRole("button", { name: new RegExp(`disable ${recipeLabel}`, "i") });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
  it("calls onToggle with id and next-state", () => {
    const onToggle = vi.fn();
    const rows = buildPipelineRows(allOn, true);
    const recipeLabel = rows.find(r => r.id === "recipe")!.label;
    render(<PipelinesPanel rows={rows} llm={true} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`disable ${recipeLabel}`, "i") }));
    expect(onToggle).toHaveBeenCalledWith("recipe", false);
  });
});
