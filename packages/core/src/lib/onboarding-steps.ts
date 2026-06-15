/**
 * Pure step-derivation for the onboarding wizard.
 * No side effects — deterministic from input.
 */

export type OnboardingStepId =
  | "welcome"
  | "sync-folder"
  | "embeddings"
  | "llm"
  | "optional-legos"
  | "done";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  /** True when the user has already satisfied the requirement for this step. */
  satisfied: boolean;
}

export interface OnboardingStepInput {
  /** Current syncFolder setting value. Non-empty + non-whitespace = satisfied. */
  syncFolder: string;
  /** Current llmBackend setting value. Non-empty = satisfied. */
  llmBackend: string;
}

const STEP_ORDER: OnboardingStepId[] = [
  "welcome",
  "sync-folder",
  "embeddings",
  "llm",
  "optional-legos",
  "done",
];

const STEP_TITLES: Record<OnboardingStepId, string> = {
  "welcome": "Welcome to Roost",
  "sync-folder": "Sync Folder",
  "embeddings": "Smart Assign Embeddings",
  "llm": "AI Model",
  "optional-legos": "Optional Add-ons",
  "done": "You're all set",
};

function isSatisfied(id: OnboardingStepId, input: OnboardingStepInput): boolean {
  switch (id) {
    case "sync-folder":
      return input.syncFolder.trim().length > 0;
    case "llm":
      return input.llmBackend.length > 0;
    // These steps are informational / always available
    case "welcome":
    case "embeddings":
    case "optional-legos":
    case "done":
      return true;
  }
}

/** Derive the ordered onboarding steps from current settings. Pure + deterministic. */
export function deriveOnboardingSteps(input: OnboardingStepInput): OnboardingStep[] {
  return STEP_ORDER.map((id) => ({
    id,
    title: STEP_TITLES[id],
    satisfied: isSatisfied(id, input),
  }));
}
