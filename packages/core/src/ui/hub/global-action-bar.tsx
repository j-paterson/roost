import { type HubState } from "@/ui/hub/state";
import { Button } from "@/ui/components/ui/button";
import { formatAge } from "@/ui/hub/format-age";

function countBacklogs(state: HubState): number {
  let total = 0;
  for (const p of [state.platforms.tiktok, state.platforms.x]) {
    if (p.kind === "connected-idle") {
      total += p.backlogs.mediaFiles + p.backlogs.thread + p.backlogs.articleBody + p.backlogs.playback;
    }
  }
  return total;
}

function countReadyPlatforms(state: HubState): number {
  let n = 0;
  if (state.platforms.tiktok.kind === "connected-idle") n += 1;
  if (state.platforms.x.kind === "connected-idle") n += 1;
  return n;
}

export function GlobalActionBar({
  state,
  isRunning,
  onQuickSyncAll,
  onFullSyncAll,
  onCancel,
}: {
  state: HubState;
  isRunning: boolean;
  onQuickSyncAll: () => void;
  onFullSyncAll: () => void;
  onCancel: () => void;
}) {
  // Sync only needs a folder to write notes into. Ollama is for Smart
  // Assign + memory — those features fail gracefully if Ollama is down,
  // so we don't gate sync on them.
  const prereqsBlocked = state.prereqs.folder !== "ok";

  if (isRunning) {
    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm">Syncing in progress…</span>
        <Button variant="destructive" size="sm" onClick={onCancel}>Cancel all</Button>
      </div>
    );
  }

  if (prereqsBlocked) {
    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm text-muted-foreground">Fix prerequisites to enable updates</span>
        <Button variant="secondary" size="sm" disabled aria-label="Fix prereqs first">
          ⚠ Fix prereqs first
        </Button>
      </div>
    );
  }

  // No connected platform yet → a global sync would have nothing to do. Show
  // guidance + a disabled button instead of a button that silently no-ops.
  if (!state.global.anythingToUpdate) {
    return (
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
        <span className="text-sm text-muted-foreground">Connect a platform below to start syncing</span>
        <Button
          variant="secondary"
          size="sm"
          disabled
          aria-label="Connect a platform first"
          title="Connect TikTok or X/Twitter in the Platforms section below first."
        >
          Connect a platform first
        </Button>
      </div>
    );
  }

  const backlogs = countBacklogs(state);
  const platformsReady = countReadyPlatforms(state);
  const pipelinesPendingTotal = state.global.pipelinesPending.total;
  const subParts: string[] = [];
  if (platformsReady > 0) subParts.push(`${platformsReady} platform${platformsReady === 1 ? "" : "s"}`);
  if (backlogs > 0) subParts.push(`${backlogs} backfills`);
  if (pipelinesPendingTotal > 0) subParts.push(`${pipelinesPendingTotal} pipeline item${pipelinesPendingTotal === 1 ? "" : "s"} pending`);
  const subline = subParts.length > 0 ? subParts.join(" · ") : "Nothing pending";

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border gap-3">
      <div className="flex flex-col text-sm min-w-0">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-medium">Last full update</span>
        <span className="text-sm truncate">
          {state.global.lastFullUpdate ? formatAge(state.global.lastFullUpdate) : "no syncs yet"}
          <span className="text-muted-foreground"> · {subline}</span>
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          onClick={onQuickSyncAll}
          title="Top up every connected platform: pull new items only, stopping at the last-synced point. Runs one platform at a time."
        >
          ⚡ Quick sync all
        </Button>
        <Button
          variant="default"
          size="sm"
          onClick={onFullSyncAll}
          title="Full rescan of every platform: re-check everything and fill in missing media/threads. Runs one platform at a time."
        >
          ⟳ Full rescan all
        </Button>
      </div>
    </div>
  );
}
