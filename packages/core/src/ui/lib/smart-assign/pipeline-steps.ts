/**
 * Single source of truth for the Smart Assign pipeline step order + labels.
 *
 * The numeric indices in PIPELINE_STEP MUST match the array positions in
 * PIPELINE_STEPS and the numbers passed to host.setPipelineStep across the
 * clustering step modules. Renumbering in one place (e.g. inserting a step)
 * stays consistent everywhere by referencing PIPELINE_STEP.* instead of literals.
 *
 * Leaf module (no imports) so UI components and the clustering pipeline can both
 * depend on it without forming a runtime import cycle (see CLAUDE.md invariant 1).
 */
export const PIPELINE_STEPS = [
  "Embed",
  "Retrain",
  "Score Known",
  "Discover",
  "Describe",
  "Score New",
  "Review",
] as const;

export const PIPELINE_STEP = {
  EMBED: 0,
  RETRAIN: 1,
  SCORE_KNOWN: 2,
  DISCOVER: 3,
  DESCRIBE: 4,
  SCORE_NEW: 5,
  REVIEW: 6,
} as const;
