import type { IncompleteByCategory } from "@/sync/vault-writer";

export type PrereqStatus = "ok" | "warning" | "missing";
export type SyncTimestamp = number;

export interface HubInputs {
  /** Configured sync folder path from settings (may be empty string). */
  syncFolder: string;
  /** Whether the configured folder currently exists on disk. */
  folderExists: boolean;
  /** Settings llmBackend choice. */
  llmBackend: "local" | "cloud" | "skip";
  /** Ollama availability state derived from integrationStatus, or null if backend != local. */
  ollamaState: "unknown" | "external" | "starting" | "ready" | "failed" | null;
  /** Same predicate as pipeline-gate: toggles + integration flags + detection. */
  llmReadyForPipelines: boolean;
  /** Keyed by "tiktok" / "twitter" — last sync state. */
  syncStateByPlatform: Record<string, { complete: boolean; count: number; timestamp: number } | undefined>;
  /** Pending enrichment buckets from the latest scan; null if no sync has run yet. */
  incompleteByCategory: IncompleteByCategory | null;
  /** True iff settings.eagleToken + eagleLibraryPath are populated. */
  eagleConfigured: boolean;
}

export interface Backlogs {
  mediaFiles: number;
  thread: number;
  articleBody: number;
  playback: number;
}

// `connecting`, `syncing`, and `expired-auth` are derived from runtime
// signals (active progress, auth probe results) outside the pure derivation
// path. They are part of the union so card consumers can render them when
// upstream sources feed them in; deriveHubState currently never produces
// them.
export type PlatformState =
  | { kind: "unconfigured" }
  | { kind: "connecting" }
  | { kind: "connected-idle"; itemCount: number; lastSync: SyncTimestamp; backlogs: Backlogs }
  | { kind: "syncing"; progress: { fetched: number; total: number | null } }
  | { kind: "expired-auth" }
  | { kind: "error"; reason: string };

export interface HubState {
  prereqs: { folder: PrereqStatus; ollama: PrereqStatus };
  platforms: { tiktok: PlatformState; x: PlatformState; eagle: PlatformState };
  global: {
    lastFullUpdate: SyncTimestamp | null;
    anythingToUpdate: boolean;
    anythingNeedsAttention: boolean;
  };
}

function derivePrereqs(input: HubInputs): { folder: PrereqStatus; ollama: PrereqStatus } {
  const folder: PrereqStatus =
    !input.syncFolder || !input.folderExists ? "missing" : "ok";

  let ollama: PrereqStatus;
  if (input.llmBackend === "skip") {
    ollama = "warning";
  } else if (input.llmBackend === "local" && input.ollamaState === "starting") {
    ollama = "warning";
  } else if (input.llmReadyForPipelines) {
    ollama = "ok";
  } else {
    ollama = "missing";
  }
  return { folder, ollama };
}

// `rawJson` is intentionally excluded from Backlogs: items missing raw.json
// have no per-item backfill — only a full re-sync recovers them — so there
// is no hub action for that bucket. The sync flow handles them.
function deriveBacklogs(byCategory: IncompleteByCategory | null): Backlogs {
  if (!byCategory) return { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 };
  return {
    mediaFiles: byCategory.mediaFiles.size,
    thread: byCategory.thread.size,
    articleBody: byCategory.articleBody.size,
    playback: byCategory.playback.size,
  };
}

function deriveSocialPlatform(
  sync: { complete: boolean; count: number; timestamp: number } | undefined,
  backlogs: Backlogs,
): PlatformState {
  if (!sync) return { kind: "unconfigured" };
  if (!sync.complete) return { kind: "error", reason: "Last sync incomplete" };
  return { kind: "connected-idle", itemCount: sync.count, lastSync: sync.timestamp, backlogs };
}

function deriveEagle(input: HubInputs): PlatformState {
  if (!input.eagleConfigured) return { kind: "unconfigured" };
  // Eagle has no continuous sync state in v1 — connected just means
  // configured. itemCount/lastSync are placeholders; the card renders as
  // "Connected" without metrics.
  return {
    kind: "connected-idle",
    itemCount: 0,
    lastSync: 0,
    backlogs: { mediaFiles: 0, thread: 0, articleBody: 0, playback: 0 },
  };
}

export function deriveHubState(input: HubInputs): HubState {
  const prereqs = derivePrereqs(input);
  const backlogs = deriveBacklogs(input.incompleteByCategory);
  const platforms = {
    tiktok: deriveSocialPlatform(input.syncStateByPlatform.tiktok, backlogs),
    x: deriveSocialPlatform(input.syncStateByPlatform.twitter, backlogs),
    eagle: deriveEagle(input),
  };

  // anythingToUpdate is "is there at least one platform we can include in the
  // Update-everything walk?", not "are backlogs > 0". The CTA label combines
  // this with backlog counts; treat the two signals separately.
  const anythingToUpdate =
    platforms.tiktok.kind === "connected-idle" || platforms.x.kind === "connected-idle";

  // Ollama is intentionally excluded here: it's an AI-features prereq, not
  // a sync prereq. The status strip and hub still surface its state, but a
  // down Ollama doesn't make the user's sync surface "need attention".
  const anythingNeedsAttention =
    prereqs.folder !== "ok" ||
    platforms.tiktok.kind === "error" ||
    platforms.x.kind === "error" ||
    platforms.tiktok.kind === "expired-auth" ||
    platforms.x.kind === "expired-auth";

  const timestamps = [
    input.syncStateByPlatform.tiktok?.timestamp,
    input.syncStateByPlatform.twitter?.timestamp,
  ].filter((t): t is number => typeof t === "number" && t > 0);
  const lastFullUpdate = timestamps.length > 0 ? Math.max(...timestamps) : null;

  return { prereqs, platforms, global: { lastFullUpdate, anythingToUpdate, anythingNeedsAttention } };
}
