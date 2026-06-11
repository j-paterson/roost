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
      eagle: { kind: "unconfigured" },
    },
    global: { lastFullUpdate: null, anythingToUpdate: false, anythingNeedsAttention: false },
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
      eagle: { kind: "unconfigured" },
    },
    global: { lastFullUpdate: null, anythingToUpdate: true, anythingNeedsAttention: false },
  });
}

describe("GlobalActionBar", () => {
  it("shows both Fast sync and Deep sync buttons when a platform is connected", () => {
    render(<GlobalActionBar state={connectedState()} isRunning={false} onFastSync={noop} onDeepSync={noop} onCancel={noop} />);
    expect(screen.getByRole("button", { name: /fast sync/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /deep sync/i })).toBeTruthy();
  });

  it("shows guidance + a disabled button when no platform is connected", () => {
    render(<GlobalActionBar state={mkState()} isRunning={false} onFastSync={noop} onDeepSync={noop} onCancel={noop} />);
    expect(screen.getByText(/connect a platform below/i)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /connect a platform first/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
    // The real sync buttons must not be present in this state.
    expect(screen.queryByRole("button", { name: /fast sync/i })).toBeNull();
  });

  it("renders the subline with platform + backlog counts when pending", () => {
    const state = mkState({
      platforms: {
        tiktok: { kind: "connected-idle", itemCount: 100, lastSync: 0, backlogs: { mediaFiles: 12, thread: 0, articleBody: 0, playback: 0 } },
        x: { kind: "unconfigured" },
        eagle: { kind: "unconfigured" },
      },
      global: { lastFullUpdate: null, anythingToUpdate: true, anythingNeedsAttention: false },
    });
    render(<GlobalActionBar state={state} isRunning={false} onFastSync={noop} onDeepSync={noop} onCancel={noop} />);
    expect(screen.getByText(/1 platform · 12 backfills/i)).toBeTruthy();
  });

  it("shows 'Syncing in progress…' + Cancel when isRunning", () => {
    render(<GlobalActionBar state={mkState()} isRunning={true} onFastSync={noop} onDeepSync={noop} onCancel={noop} />);
    expect(screen.getByText(/syncing in progress/i)).toBeTruthy();
    expect(screen.getByText(/cancel all/i)).toBeTruthy();
  });

  it("disables button when prereqs missing", () => {
    const state = mkState({
      prereqs: { folder: "missing", ollama: "ok" },
      global: { lastFullUpdate: null, anythingToUpdate: false, anythingNeedsAttention: true },
    });
    render(<GlobalActionBar state={state} isRunning={false} onFastSync={noop} onDeepSync={noop} onCancel={noop} />);
    const btn = screen.getByRole("button", { name: /fix prereqs/i });
    expect(btn.hasAttribute("disabled")).toBe(true);
  });

  it("calls onFastSync when Fast sync clicked", () => {
    const fn = vi.fn();
    render(<GlobalActionBar state={connectedState()} isRunning={false} onFastSync={fn} onDeepSync={noop} onCancel={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /fast sync/i }));
    expect(fn).toHaveBeenCalledOnce();
  });

  it("calls onDeepSync when Deep sync clicked", () => {
    const fn = vi.fn();
    render(<GlobalActionBar state={connectedState()} isRunning={false} onFastSync={noop} onDeepSync={fn} onCancel={noop} />);
    fireEvent.click(screen.getByRole("button", { name: /deep sync/i }));
    expect(fn).toHaveBeenCalledOnce();
  });
});
