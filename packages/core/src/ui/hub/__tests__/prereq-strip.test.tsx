// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { PrereqStrip } from "@/ui/hub/prereq-strip";

afterEach(cleanup);

describe("PrereqStrip", () => {
  it("shows ✓ for both prereqs when ok", () => {
    render(<PrereqStrip prereqs={{ folder: "ok", ollama: "ok" }} folderPath="Roost" onPickFolder={() => {}} onRecheckOllama={() => {}} />);
    const items = screen.getAllByText("✓");
    expect(items.length).toBe(2);
  });

  it("shows ✗ and calls onPickFolder when folder missing", () => {
    const pick = vi.fn();
    render(<PrereqStrip prereqs={{ folder: "missing", ollama: "ok" }} folderPath="" onPickFolder={pick} onRecheckOllama={() => {}} />);
    expect(screen.getByText("✗")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /set folder/i }));
    expect(pick).toHaveBeenCalledOnce();
  });

  it("calls onRecheckOllama when ollama missing and recheck clicked", () => {
    const recheck = vi.fn();
    render(<PrereqStrip prereqs={{ folder: "ok", ollama: "missing" }} folderPath="Roost" onPickFolder={() => {}} onRecheckOllama={recheck} />);
    fireEvent.click(screen.getByRole("button", { name: /re-check/i }));
    expect(recheck).toHaveBeenCalledOnce();
  });
});
