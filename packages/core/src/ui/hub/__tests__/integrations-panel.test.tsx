// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { IntegrationsPanel, type IntegrationRow } from "@/ui/hub/integrations-panel";

afterEach(cleanup);

const rows = (over: Partial<IntegrationRow>[] = []): IntegrationRow[] => {
  const base: IntegrationRow[] = [
    { id: "ollama", label: "Ollama", unlocks: "Embeddings + LLM.", enabled: false, status: "unknown", setup: "Install Ollama." },
    { id: "ffmpeg", label: "ffmpeg", unlocks: "Video vision.", enabled: true, status: "available", setup: "brew install ffmpeg." },
  ];
  return base.map((r, i) => ({ ...r, ...(over[i] ?? {}) }));
};

describe("IntegrationsPanel", () => {
  it("renders a row per integration with its label", () => {
    render(<IntegrationsPanel rows={rows()} onToggle={() => {}} />);
    expect(screen.getByText("Ollama")).toBeTruthy();
    expect(screen.getByText("ffmpeg")).toBeTruthy();
  });
  it("shows 'Detected' for an enabled+available integration", () => {
    render(<IntegrationsPanel rows={rows()} onToggle={() => {}} />);
    expect(screen.getByText(/detected/i)).toBeTruthy();
  });
  it("shows setup instructions for an enabled+unavailable integration", () => {
    render(<IntegrationsPanel rows={rows([{}, { enabled: true, status: "unavailable" }])} onToggle={() => {}} />);
    expect(screen.getByText(/brew install ffmpeg/i)).toBeTruthy();
  });
  it("does NOT show setup instructions when the flag is off", () => {
    render(<IntegrationsPanel rows={rows()} onToggle={() => {}} />);
    expect(screen.queryByText(/install ollama/i)).toBeNull();
  });
  it("calls onToggle with id and next-enabled when a toggle is clicked", () => {
    const onToggle = vi.fn();
    render(<IntegrationsPanel rows={rows()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: /enable ollama/i }));
    expect(onToggle).toHaveBeenCalledWith("ollama", true);
  });
  it("toggling an enabled integration requests disable", () => {
    const onToggle = vi.fn();
    render(<IntegrationsPanel rows={rows()} onToggle={onToggle} />);
    fireEvent.click(screen.getByRole("button", { name: /disable ffmpeg/i }));
    expect(onToggle).toHaveBeenCalledWith("ffmpeg", false);
  });
});
