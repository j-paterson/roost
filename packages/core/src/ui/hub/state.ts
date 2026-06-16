import type { IncompleteByCategory } from "@/sync/vault-writer";
import type { PendingPipelinesResult, PendingPipelineEntry } from "@/pipeline/scan-pending-pipelines";
import type { PipelineId } from "@/lib/enrichments";

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
  /** Keyed by "tiktok" / "twitter" — live auth-cookie probe result. The real
   *  "logged in?" signal, independent of sync history. Optional/"unknown" when
   *  not yet probed, in which case derivation falls back to sync history. */
  authByPlatform?: Record<string, "connected" | "logged-out" | "unknown" | undefined>;
  /** Pending enrichment buckets from the latest scan; null if no sync has run yet. */
  incompleteByCategory: IncompleteByCategory | null;
  /** Derived pending-pipeline counts per pipeline; null until first refresh. */
  pendingPipelines: PendingPipelinesResult | null;
  /** True iff settings.eagleToken + eagleLibraryPath are populated. */
  eagleConfigured: boolean;
  /** Pre-computed active embedding backend + provenance mismatch (async work done at the call site). */
  embedding?: { backend: "sidecar" | "ollama"; mismatch: "none" | "match" | "sidecar-down" | "vault-moved" | "upgrade-available" };
  /** True while a job is running or any are queued in the serial job queue. */
  jobBusy: boolean;
  /** Label of the currently-running job (null when idle). */
  jobLabel: string | null;
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

export interface PipelinesPending {
  /** De-duped count of items pending across ALL active pipelines. */
  total: number;
  /** Per-pipeline breakdown (only active/unblocked pipelines with data). */
  byPipeline: { id: PipelineId; pending: number; stale: number; blocked: boolean }[];
}

export interface HubState {
  prereqs: { folder: PrereqStatus; ollama: PrereqStatus };
  platforms: { tiktok: PlatformState; x: PlatformState; eagle: PlatformState };
  global: {
    lastFullUpdate: SyncTimestamp | null;
    anythingToUpdate: boolean;
    anythingNeedsAttention: boolean;
    /** Non-null while a job is running in the serial queue. */
    runningJob: { label: string } | null;
    /** Pending + stale pipeline work, derived from the last pending scan. */
    pipelinesPending: PipelinesPending;
  };
  embedding: { label: string; warn: boolean } | null;
}

function derivePipelinesPending(input: HubInputs): PipelinesPending {
  const result = input.pendingPipelines;
  if (!result) return { total: 0, byPipeline: [] };

  // De-dup the global total using the pending item id sets.
  // An item matched by two pipelines counts once in the headline total,
  // but each pipeline's own badge keeps its full count.
  const dedupSet = new Set<string>();
  const byPipeline: PipelinesPending["byPipeline"] = [];

  for (const [id, entry] of Object.entries(result.byPipeline) as [PipelineId, PendingPipelineEntry][]) {
    byPipeline.push({ id, pending: entry.pending, stale: entry.stale, blocked: entry.blocked });
    if (!entry.blocked) {
      for (const itemId of (result.pendingItemIds[id] ?? [])) {
        dedupSet.add(itemId);
      }
    }
  }

  return { total: dedupSet.size, byPipeline };
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
  auth: "connected" | "logged-out" | "unknown",
): PlatformState {
  // A live auth cookie is the authoritative signal when we have it: the user
  // is connected even before their first sync (itemCount 0 → card shows
  // "Connected" + Sync). An interrupted last sync still surfaces as an error
  // so the Retry affordance shows.
  if (auth === "connected") {
    if (sync && !sync.complete) return { kind: "error", reason: "Last sync incomplete" };
    return { kind: "connected-idle", itemCount: sync?.count ?? 0, lastSync: sync?.timestamp ?? 0, backlogs };
  }
  // Cookie is gone. If we have sync history, the login expired (Reconnect);
  // otherwise it was never set up.
  if (auth === "logged-out") {
    return sync ? { kind: "expired-auth" } : { kind: "unconfigured" };
  }
  // auth "unknown" (not probed yet) → fall back to sync-history derivation so
  // we never wrongly downgrade a known-synced platform.
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
  const auth = input.authByPlatform ?? {};
  const platforms = {
    tiktok: deriveSocialPlatform(input.syncStateByPlatform.tiktok, backlogs, auth.tiktok ?? "unknown"),
    x: deriveSocialPlatform(input.syncStateByPlatform.twitter, backlogs, auth.twitter ?? "unknown"),
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

  const embedding = input.embedding
    ? {
        label: input.embedding.backend === "sidecar" ? "fine-tuned (sidecar)" : "Ollama base",
        warn: input.embedding.mismatch === "sidecar-down" || input.embedding.mismatch === "vault-moved",
      }
    : null;

  const runningJob = input.jobBusy && input.jobLabel ? { label: input.jobLabel } : null;
  const pipelinesPending = derivePipelinesPending(input);

  return { prereqs, platforms, global: { lastFullUpdate, anythingToUpdate, anythingNeedsAttention, runningJob, pipelinesPending }, embedding };
}
