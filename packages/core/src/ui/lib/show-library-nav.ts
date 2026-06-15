import type { SmartAssignMode } from "@/ui/lib/smart-assign/types";

/**
 * Whether the hub should show the folder-navigation tree (LibraryTree/
 * ExplorerTree). It shows in normal "sync" mode, AND during the Smart Assign
 * pipeline's pre-proposal window (mode flips to "staging" before the embed, but
 * the staging panel can't render until a proposal exists at step 2) — so the
 * tree must stay visible through embed+score instead of leaving the nav blank.
 */
export function showLibraryNav(mode: SmartAssignMode, hasProposal: boolean): boolean {
  return mode === "sync" || (mode === "staging" && !hasProposal);
}
