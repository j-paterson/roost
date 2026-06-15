import { describe, it, expect } from "vitest";
import { deriveOnboardingSteps, type OnboardingStepInput } from "@/lib/onboarding-steps";

describe("deriveOnboardingSteps", () => {
  it("returns exactly 6 steps in order", () => {
    const input: OnboardingStepInput = { syncFolder: "", llmBackend: "" };
    const steps = deriveOnboardingSteps(input);
    expect(steps).toHaveLength(6);
    expect(steps.map((s) => s.id)).toEqual([
      "welcome",
      "sync-folder",
      "embeddings",
      "llm",
      "optional-legos",
      "done",
    ]);
  });

  it("sync-folder step: satisfied when syncFolder is non-empty", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "Bookmarks", llmBackend: "" });
    const step = steps.find((s) => s.id === "sync-folder")!;
    expect(step.satisfied).toBe(true);
  });

  it("sync-folder step: unsatisfied when syncFolder is empty string", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "", llmBackend: "" });
    const step = steps.find((s) => s.id === "sync-folder")!;
    expect(step.satisfied).toBe(false);
  });

  it("sync-folder step: unsatisfied when syncFolder is only whitespace", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "   ", llmBackend: "" });
    const step = steps.find((s) => s.id === "sync-folder")!;
    expect(step.satisfied).toBe(false);
  });

  it("llm step: satisfied when llmBackend is non-empty", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "", llmBackend: "local" });
    const step = steps.find((s) => s.id === "llm")!;
    expect(step.satisfied).toBe(true);
  });

  it("llm step: unsatisfied when llmBackend is empty string", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "", llmBackend: "" });
    const step = steps.find((s) => s.id === "llm")!;
    expect(step.satisfied).toBe(false);
  });

  it("welcome, embeddings, optional-legos, done steps always satisfied", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "", llmBackend: "" });
    for (const id of ["welcome", "embeddings", "optional-legos", "done"] as const) {
      const step = steps.find((s) => s.id === id)!;
      expect(step.satisfied).toBe(true);
    }
  });

  it("each step has a non-empty title", () => {
    const steps = deriveOnboardingSteps({ syncFolder: "Bookmarks", llmBackend: "local" });
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
    }
  });
});
