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

describe("hub state includes reddit", () => {
  it("deriveHubState produces a platforms.reddit entry", () => {
    const state = deriveHubState(baseInputs());
    expect(state.platforms.reddit).toBeTruthy();
  });

  it("reddit connected-idle when auth cookie present", () => {
    const state = deriveHubState({
      ...baseInputs(),
      authByPlatform: { reddit: "connected" },
    });
    expect(state.platforms.reddit.kind).toBe("connected-idle");
  });

  it("reddit expired-auth when logged-out with prior sync history", () => {
    const state = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { reddit: { complete: true, count: 42, timestamp: 1 } },
      authByPlatform: { reddit: "logged-out" },
    });
    expect(state.platforms.reddit.kind).toBe("expired-auth");
  });

  it("reddit connected-idle contributes to anythingToUpdate", () => {
    const state = deriveHubState({
      ...baseInputs(),
      authByPlatform: { reddit: "connected" },
    });
    expect(state.global.anythingToUpdate).toBe(true);
  });
});
