// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { StatusStrip } from "@/ui/hub/status-strip";
import type { HubState } from "@/ui/hub/state";

afterEach(cleanup);

function mkState(over: Partial<HubState> = {}): HubState {
  return {
    prereqs: { folder: "ok", ollama: "ok" },
    platforms: {
      tiktok: { kind: "connected-idle", itemCount: 100, lastSync: Date.now(), backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } },
      x: { kind: "connected-idle", itemCount: 50, lastSync: Date.now(), backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 } },
      eagle: { kind: "unconfigured" },
    },
    global: { lastFullUpdate: Date.now(), anythingToUpdate: true, anythingNeedsAttention: false, runningJob: null },
    embedding: null,
    ...over,
  };
}

describe("StatusStrip", () => {
  it("renders 'all caught up' when nothing needs attention", () => {
    render(<StatusStrip state={mkState()} onOpenHub={() => {}} />);
    expect(screen.getByText(/all caught up/i)).toBeTruthy();
  });

  it("renders 'needs attention' for partial setup (folder missing but a platform connected)", () => {
    const state = mkState({
      prereqs: { folder: "missing", ollama: "ok" },
      global: { lastFullUpdate: null, anythingToUpdate: true, anythingNeedsAttention: true, runningJob: null },
    });
    render(<StatusStrip state={state} onOpenHub={() => {}} />);
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
  });

  it("renders 'setup incomplete' when both prereqs broken and no platform configured", () => {
    const state = mkState({
      prereqs: { folder: "missing", ollama: "missing" },
      platforms: {
        tiktok: { kind: "unconfigured" },
        x: { kind: "unconfigured" },
        eagle: { kind: "unconfigured" },
      },
      global: { lastFullUpdate: null, anythingToUpdate: false, anythingNeedsAttention: true, runningJob: null },
    });
    render(<StatusStrip state={state} onOpenHub={() => {}} />);
    expect(screen.getByText(/setup incomplete/i)).toBeTruthy();
  });

  it("invokes onOpenHub on click", () => {
    const fn = vi.fn();
    render(<StatusStrip state={mkState()} onOpenHub={fn} />);
    fireEvent.click(screen.getByRole("button"));
    expect(fn).toHaveBeenCalledOnce();
  });
});
