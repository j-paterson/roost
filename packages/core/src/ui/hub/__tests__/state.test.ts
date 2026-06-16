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
    pendingPipelines: null,
    eagleConfigured: false,
    jobBusy: false,
    jobLabel: null,
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

describe("deriveHubState — auth-driven connection", () => {
  it("connected (cookie present) with no sync history → connected-idle, 0 items", () => {
    const s = deriveHubState({
      ...baseInputs(),
      authByPlatform: { tiktok: "connected" },
    });
    expect(s.platforms.tiktok.kind).toBe("connected-idle");
    if (s.platforms.tiktok.kind === "connected-idle") expect(s.platforms.tiktok.itemCount).toBe(0);
  });

  it("logged-out (cookie gone) with prior sync history → expired-auth", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { twitter: { complete: true, count: 50, timestamp: 1 } },
      authByPlatform: { twitter: "logged-out" },
    });
    expect(s.platforms.x.kind).toBe("expired-auth");
    expect(s.global.anythingNeedsAttention).toBe(true);
  });

  it("logged-out with no history → unconfigured", () => {
    const s = deriveHubState({ ...baseInputs(), authByPlatform: { tiktok: "logged-out" } });
    expect(s.platforms.tiktok.kind).toBe("unconfigured");
  });

  it("connected but last sync incomplete → error (retry)", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: false, count: 10, timestamp: 1 } },
      authByPlatform: { tiktok: "connected" },
    });
    expect(s.platforms.tiktok.kind).toBe("error");
  });

  it("unknown auth falls back to sync-history derivation (unchanged behavior)", () => {
    const s = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { tiktok: { complete: true, count: 7, timestamp: 1 } },
      authByPlatform: { tiktok: "unknown" },
    });
    expect(s.platforms.tiktok.kind).toBe("connected-idle");
  });

  it("connected platform makes global.anythingToUpdate true even before first sync", () => {
    const s = deriveHubState({ ...baseInputs(), authByPlatform: { tiktok: "connected" } });
    expect(s.global.anythingToUpdate).toBe(true);
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
        tweetBody: new Set(),
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

describe("deriveHubState — embedding", () => {
  it("ollama backend with sidecar-down mismatch → warn label", () => {
    const s = deriveHubState({
      ...baseInputs(),
      embedding: { backend: "ollama", mismatch: "sidecar-down" },
    });
    expect(s.embedding).toEqual({ label: "Ollama base", warn: true });
  });

  it("sidecar backend with match mismatch → no warn", () => {
    const s = deriveHubState({
      ...baseInputs(),
      embedding: { backend: "sidecar", mismatch: "match" },
    });
    expect(s.embedding).toEqual({ label: "fine-tuned (sidecar)", warn: false });
  });

  it("explicit sidecar configured but down → warn (sidecar-down mismatch injected by probeEmbedding)", () => {
    // Simulates Fix 1: probeEmbedding overrides mismatchKind to "sidecar-down" when
    // reason === "configured-sidecar" && sidecarConfiguredButDown. deriveHubState
    // must surface warn:true for this backend+mismatch combination.
    const s = deriveHubState({
      ...baseInputs(),
      embedding: { backend: "sidecar", mismatch: "sidecar-down" },
    });
    expect(s.embedding).toEqual({ label: "fine-tuned (sidecar)", warn: true });
  });

  it("no embedding input → null", () => {
    const s = deriveHubState(baseInputs());
    expect(s.embedding).toBeNull();
  });
});
