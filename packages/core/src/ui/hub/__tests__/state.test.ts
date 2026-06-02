// @vitest-environment node
import { describe, it, expect } from "vitest";
import { deriveHubState, type HubInputs } from "@/ui/hub/state";

function baseInputs(): HubInputs {
  return {
    syncFolder: "Roost",
    folderExists: true,
    llmBackend: "local",
    ollamaState: "ready",
    llmReadyForPipelines: true,
    syncStateByPlatform: {},
    incompleteByCategory: null,
    eagleConfigured: false,
  };
}

describe("deriveHubState — prereqs", () => {
  it("ok when folder set + folder exists + ollama ready", () => {
    const s = deriveHubState(baseInputs());
    expect(s.prereqs.folder).toBe("ok");
    expect(s.prereqs.ollama).toBe("ok");
  });
  it("missing folder when syncFolder empty", () => {
    const s = deriveHubState({ ...baseInputs(), syncFolder: "" });
    expect(s.prereqs.folder).toBe("missing");
  });
  it("missing folder when folder does not exist on disk", () => {
    const s = deriveHubState({ ...baseInputs(), folderExists: false });
    expect(s.prereqs.folder).toBe("missing");
  });
  it("missing ollama when local backend selected but LLM not ready", () => {
    const s = deriveHubState({ ...baseInputs(), ollamaState: "failed", llmReadyForPipelines: false });
    expect(s.prereqs.ollama).toBe("missing");
  });
  it("ok ollama when external and pipeline LLM gate passes", () => {
    const s = deriveHubState({ ...baseInputs(), ollamaState: "external", llmReadyForPipelines: true });
    expect(s.prereqs.ollama).toBe("ok");
  });
  it("missing ollama when detected but integration flag off", () => {
    const s = deriveHubState({ ...baseInputs(), ollamaState: "external", llmReadyForPipelines: false });
    expect(s.prereqs.ollama).toBe("missing");
  });
  it("starting ollama is a warning", () => {
    const s = deriveHubState({ ...baseInputs(), ollamaState: "starting" });
    expect(s.prereqs.ollama).toBe("warning");
  });
  it("cloud backend ok when LLM ready, missing otherwise", () => {
    const ok = deriveHubState({ ...baseInputs(), llmBackend: "cloud", llmReadyForPipelines: true });
    expect(ok.prereqs.ollama).toBe("ok");
    const missing = deriveHubState({ ...baseInputs(), llmBackend: "cloud", llmReadyForPipelines: false });
    expect(missing.prereqs.ollama).toBe("missing");
  });
  it("skip backend yields ollama=warning (features disabled)", () => {
    const s = deriveHubState({ ...baseInputs(), llmBackend: "skip" });
    expect(s.prereqs.ollama).toBe("warning");
  });
});

describe("deriveHubState — platforms", () => {
  it("unconfigured when no sync state for platform", () => {
    const s = deriveHubState(baseInputs());
    expect(s.platforms.tiktok.kind).toBe("unconfigured");
    expect(s.platforms.x.kind).toBe("unconfigured");
    expect(s.platforms.eagle.kind).toBe("unconfigured");
  });
  it("connected idle when sync state complete", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: true, count: 100, timestamp: 1700000000000 } },
    });
    expect(s.platforms.tiktok.kind).toBe("connected-idle");
    if (s.platforms.tiktok.kind === "connected-idle") {
      expect(s.platforms.tiktok.itemCount).toBe(100);
      expect(s.platforms.tiktok.lastSync).toBe(1700000000000);
    }
  });
  it("connected error when sync state incomplete", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { twitter: { complete: false, count: 50, timestamp: 1700000000000 } },
    });
    expect(s.platforms.x.kind).toBe("error");
  });
  it("eagle connected idle when eagleConfigured true", () => {
    const s = deriveHubState({ ...baseInputs(), eagleConfigured: true });
    expect(s.platforms.eagle.kind).toBe("connected-idle");
  });
});

describe("deriveHubState — backlogs", () => {
  it("attaches backlog counts to connected platforms", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: true, count: 100, timestamp: 0 } },
      incompleteByCategory: {
        rawJson: new Set(),
        mediaFiles: new Set(["a", "b", "c"]),
        thread: new Set(),
        articleBody: new Set(),
        playback: new Set(),
      },
    });
    if (s.platforms.tiktok.kind === "connected-idle") {
      expect(s.platforms.tiktok.backlogs.mediaFiles).toBe(3);
    }
  });
});

describe("deriveHubState — global", () => {
  it("anythingToUpdate true when any platform is connected-idle", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: true, count: 100, timestamp: 0 } },
    });
    expect(s.global.anythingToUpdate).toBe(true);
  });
  it("anythingNeedsAttention true when prereqs missing", () => {
    const s = deriveHubState({ ...baseInputs(), syncFolder: "" });
    expect(s.global.anythingNeedsAttention).toBe(true);
  });
  it("anythingNeedsAttention false when all prereqs ok and no platform errors", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: true, count: 100, timestamp: 0 } },
    });
    expect(s.global.anythingNeedsAttention).toBe(false);
  });
});
