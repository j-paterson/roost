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

describe("hub state includes instagram", () => {
  it("deriveHubState produces a platforms.instagram entry", () => {
    const state = deriveHubState(baseInputs());
    expect(state.platforms.instagram).toBeTruthy();
  });

  it("instagram connected-idle when auth cookie present", () => {
    const state = deriveHubState({
      ...baseInputs(),
      authByPlatform: { instagram: "connected" },
    });
    expect(state.platforms.instagram.kind).toBe("connected-idle");
  });

  it("instagram expired-auth when logged-out with prior sync history", () => {
    const state = deriveHubState({
      ...baseInputs(),
      syncStateByPlatform: { instagram: { complete: true, count: 42, timestamp: 1 } },
      authByPlatform: { instagram: "logged-out" },
    });
    expect(state.platforms.instagram.kind).toBe("expired-auth");
  });

  it("instagram connected-idle contributes to anythingToUpdate", () => {
    const state = deriveHubState({
      ...baseInputs(),
      authByPlatform: { instagram: "connected" },
    });
    expect(state.global.anythingToUpdate).toBe(true);
  });
});
