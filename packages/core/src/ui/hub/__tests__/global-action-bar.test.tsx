// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { GlobalActionBar } from "@/ui/hub/global-action-bar";
import type { HubState } from "@/ui/hub/state";

afterEach(cleanup);

function mkState(over: Partial<HubState> = {}): HubState {
  return {
    prereqs: { folder: "ok", ollama: "ok" },
    platforms: {
      tiktok: { kind: "unconfigured" },
      x: { kind: "unconfigured" },
      instagram: { kind: "unconfigured" },
      reddit: { kind: "unconfigured" },
      eagle: { kind: "unconfigured" },
    },
    global: { lastFullUpdate: null, anythingToUpdate: false, anythingNeedsAttention: false, runningJob: null, pipelinesPending: { total: 0, byPipeline: [] } },
    embedding: null,
    ...over,
  };
}

const noop = () => {};

// A state with at least one connected platform, so the sync buttons are live.
function connectedState(): HubState {
  return mkState({
    platforms: {
      tiktok: { kind: "connected-idle", itemCount: 100, lastSync: 0, backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } },
      x: { kind: "unconfigured" },
      instagram: { kind: "unconfigured" },
      reddit: { kind: "unconfigured" },
      eagle: { kind: "unconfigured" },
    },
    global: { lastFullUpdate: null, anythingToUpdate: true, anythingNeedsAttention: false, runningJob: null, pipelinesPending: { total: 0, byPipeline: [] } },
  });
}

describe("GlobalActionBar", () => {
  it("shows both Quick sync all and Full rescan all buttons when a platform is connected", () => {
    render(<GlobalActionBar state={connectedState()} isRunning={false} onQuickSyncAll={noop} onFullSyncAll={noop} onCancel={noop} />);
    expect(screen.getByRole("button", { name: /quick sync all/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /full rescan all/i })).toBeTruthy();
  });

  it("shows guidance + a disabled button when no platform is connected", () => {
    render(<GlobalActionBar state={mkState()} isRunning={false} onQuickSyncAll={noop} onFullSyncAll={noop} onCancel={noop} />);
    expect(screen.getByText(/connect a platform below/i)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /connect a platform first/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
    // The real sync buttons must not be present in this state.
    expect(screen.queryByRole("button", { name: /quick sync all/i })).toBeNull();
  });

  it("renders the subline with platform + backlog counts when pending", () => {
    const state = mkState({
      platforms: {
        tiktok: { kind: "connected-idle", itemCount: 100, lastSync: 0, backlogs: { mediaFiles: 12, thread: 0, articleBody: 0, playback: 0 } },
        x: { kind: "unconfigured" },
        instagram: { kind: "unconfigured" },
        reddit: { kind: "unconfigured" },
        eagle: { kind: "unconfigured" },
      },
      global: { lastFullUpdate: null, anythingToUpdate: true, anythingNeedsAttention: false, runningJob: null, pipelinesPending: { total: 0, byPipeline: [] } },
    });
    render(<GlobalActionBar state={state} isRunning={false} onQuickSyncAll={noop} onFullSyncAll={noop} onCancel={noop} />);
    expect(screen.getByText(/1 platform · 12 backfills/i)).toBeTruthy();
  });

  it("shows 'Syncing in progress…' + Cancel when isRunning", () => {
    render(<GlobalActionBar state={mkState()} isRunning={true} onQuickSyncAll={noop} onFullSyncAll={noop} onCancel={noop} />);
    expect(screen.getByText(/syncing in progress/i)).toBeTruthy();
    expect(screen.getByText(/cancel all/i)).toBeTruthy();
  });

  it("disables button when prereqs missing", () => {
    const state = mkState({
      prereqs: { folder: "missing", ollama: "ok" },
      global: { lastFullUpdate: null, anythingToUpdate: false, anythingNeedsAttention: true, runningJob: null, pipelinesPending: { total: 0, byPipeline: [] } },
    });
    render(<GlobalActionBar state={state} isRunning={false} onQuickSyncAll={noop} onFullSyncAll={noop} onCancel={noop} />);
    const btn = screen.getByRole("button", { name: /fix prereqs/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("calls onQuickSyncAll when Quick sync all clicked", () => {
    const fn = vi.fn();
    render(<GlobalActionBar state={connectedState()} isRunning={false} onQuickSyncAll={fn} onFullSyncAll={noop} onCancel={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /quick sync all/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("calls onFullSyncAll when Full rescan all clicked", () => {
    const fn = vi.fn();
    render(<GlobalActionBar state={connectedState()} isRunning={false} onQuickSyncAll={noop} onFullSyncAll={fn} onCancel={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /full rescan all/i }));
    expect(fn).toHaveBeenCalledOnce();
  });
});
