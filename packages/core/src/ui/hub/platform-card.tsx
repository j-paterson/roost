import type { RefObject } from "react";
import { type PlatformState } from "@/ui/hub/state";
import { formatAge } from "@/ui/hub/format-age";
import { Button } from "@/ui/components/ui/button";
import type { LiveSync } from "@/ui/hub/hub-body";
import type { SyncProgress } from "@/ui/components/progress-header";

export type PlatformId = "tiktok" | "x" | "eagle";

const TITLES: Record<PlatformId, string> = {
  tiktok: "TikTok",
  x: "X / Twitter",
  eagle: "Eagle",
};

const EDU_COPY: Record<PlatformId, string> = {
  tiktok: "Syncs TikTok bookmarks via your Obsidian webview login.",
  x: "Syncs X bookmarks via your Obsidian webview login.",
  eagle: "Imports items from a local Eagle library.",
};

interface BacklogRow {
  key: string;
  label: string;
  count: number;
  cta: string;
  bucket: string;
}

function backlogRowsFor(
  platform: PlatformId,
  backlogs: { mediaFiles: number; thread: number; articleBody: number; playback: number },
): BacklogRow[] {
  if (platform === "tiktok") {
    return backlogs.mediaFiles > 0
      ? [{ key: "mediaFiles", label: "missing media", count: backlogs.mediaFiles, cta: "Backfill", bucket: "mediaFiles" }]
      : [];
  }
  if (platform === "x") {
    const rows: BacklogRow[] = [];
    if (backlogs.thread > 0) rows.push({ key: "thread", label: "threads incomplete", count: backlogs.thread, cta: "Resolve", bucket: "thread" });
    if (backlogs.articleBody > 0) rows.push({ key: "article", label: "article bodies queued", count: backlogs.articleBody, cta: "Fetch", bucket: "articleBody" });
    return rows;
  }
  return [];
}

interface RowProps {
  icon: string;
  iconTone: string;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
  indent?: boolean;
}

function HubRow({ icon, iconTone, title, detail, action, indent }: RowProps) {
  return (
    <div className="grid grid-cols-[1.25rem_8rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-accent/30 transition-colors">
      <span className={`text-sm font-semibold ${iconTone}`} aria-hidden>{icon}</span>
      <span className={`text-sm ${indent ? "pl-4 text-muted-foreground" : "font-medium"}`}>{title}</span>
      <span className="text-sm text-muted-foreground truncate">{detail}</span>
      <div className="justify-self-end">{action}</div>
    </div>
  );
}

function progressDetail(p: SyncProgress): string {
  if (p.phase === "scanning") return "scanning vault…";
  if (p.phase === "setup") return "setting up Python environment…";
  if (p.phase === "clustering") return "processing…";
  if (p.phase === "embedding") return `${p.written} / ${p.count} items`;
  if (p.phase === "reducing") return `epoch ${p.written} / ${p.count}`;
  if (p.phase === "scoring") return `${p.written} / ${p.count} items scored`;
  if (p.phase === "writing") return `${p.written} / ${p.count} items written`;
  if (p.phase === "renaming") return `${p.written} / ${p.count} items renamed`;
  const total = p.written + p.resynced + p.skipped;
  const parts = [
    p.written > 0 && `${p.written} new`,
    p.resynced > 0 && `${p.resynced} resynced`,
    p.skipped > 0 && `${p.skipped} skipped`,
  ].filter(Boolean);
  return parts.length > 0
    ? `${total} / ${p.count} processed — ${parts.join(", ")}`
    : `${total} / ${p.count} processed`;
}

function progressBarPct(p: SyncProgress): number {
  if (p.count <= 0) return 0;
  const done = p.written + p.resynced + p.skipped;
  return Math.min(100, (done / p.count) * 100);
}

function isIndeterminate(p: SyncProgress | null): boolean {
  if (!p) return true;
  return p.phase === "clustering" || p.phase === "scanning" || p.phase === "setup";
}

function LiveSyncRow({
  platform,
  live,
  onCancel,
}: {
  platform: PlatformId;
  live: LiveSync;
  onCancel: () => void;
}) {
  const p = live.progress;
  return (
    <div className="border-b border-border last:border-b-0">
      <div className="grid grid-cols-[1.25rem_8rem_1fr_auto] items-center gap-3 px-4 py-2">
        <span className="text-sm font-semibold text-muted-foreground animate-pulse" aria-hidden>⟳</span>
        <span className="text-sm font-medium">{TITLES[platform]}</span>
        <span className="text-sm text-muted-foreground truncate">
          {p ? (
            <>
              <span className="capitalize">{p.phase}</span>
              {" · "}
              {progressDetail(p)}
            </>
          ) : (
            "starting…"
          )}
        </span>
        <div className="justify-self-end">
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        </div>
      </div>
      <div className="px-4 pb-2">
        <div className="h-1.5 rounded-full bg-border overflow-hidden">
          {isIndeterminate(p) ? (
            <div className="h-full bg-primary rounded-full w-full animate-pulse" />
          ) : (
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${progressBarPct(p!)}%` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LiveSyncPane({
  mountRef,
}: {
  mountRef: RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="mx-4 mb-3 border border-border rounded-md overflow-hidden bg-muted/20">
      <div ref={mountRef} className="w-full h-72 bg-background" />
    </div>
  );
}

export function PlatformCard({
  platform,
  state,
  live,
  webviewMountRef,
  onConnect,
  onSync,
  onReconnect,
  onBackfill,
  onCancel,
}: {
  platform: PlatformId;
  state: PlatformState;
  live: LiveSync | null;
  webviewMountRef: RefObject<HTMLDivElement | null> | null;
  onConnect: () => void;
  onSync: () => void;
  onReconnect: () => void;
  onBackfill: (id: string) => void;
  onCancel: () => void;
}) {
  const title = TITLES[platform];

  // While a sync is live for this platform, render the syncing row +
  // progress bar + the embedded webview pane regardless of the
  // persisted PlatformState.
  if (live && webviewMountRef) {
    return (
      <>
        <LiveSyncRow platform={platform} live={live} onCancel={onCancel} />
        <LiveSyncPane mountRef={webviewMountRef} />
      </>
    );
  }

  if (state.kind === "unconfigured") {
    return (
      <HubRow
        icon="—"
        iconTone="text-muted-foreground"
        title={title}
        detail={EDU_COPY[platform]}
        action={<Button variant="default" size="sm" onClick={onConnect}>Connect</Button>}
      />
    );
  }

  if (state.kind === "connecting") {
    return (
      <HubRow
        icon="…"
        iconTone="text-muted-foreground"
        title={title}
        detail="Connecting…"
      />
    );
  }

  if (state.kind === "connected-idle") {
    const detail =
      state.itemCount > 0 ? (
        <>
          <span className="font-medium text-foreground">{state.itemCount.toLocaleString()}</span> items
          {state.lastSync > 0 && <span> · last sync {formatAge(state.lastSync)}</span>}
        </>
      ) : (
        "Connected"
      );
    return (
      <>
        <HubRow
          icon="✓"
          iconTone="text-emerald-500"
          title={title}
          detail={detail}
          action={<Button variant="default" size="sm" onClick={onSync}>Sync</Button>}
        />
        {backlogRowsFor(platform, state.backlogs).map((row) => (
          <HubRow
            key={row.key}
            icon="⚠"
            iconTone="text-amber-500"
            title=""
            detail={
              <span>
                <span className="font-medium text-foreground">{row.count.toLocaleString()}</span> {row.label}
              </span>
            }
            action={<Button variant="outline" size="xs" onClick={() => onBackfill(row.bucket)}>{row.cta}</Button>}
            indent
          />
        ))}
      </>
    );
  }

  if (state.kind === "syncing") {
    return (
      <HubRow
        icon="⟳"
        iconTone="text-muted-foreground animate-pulse"
        title={title}
        detail={`Syncing… ${state.progress.fetched}${state.progress.total != null ? ` / ~${state.progress.total}` : ""}`}
      />
    );
  }

  if (state.kind === "expired-auth") {
    return (
      <HubRow
        icon="⚠"
        iconTone="text-amber-500"
        title={title}
        detail="Login expired"
        action={<Button variant="default" size="sm" onClick={onReconnect}>Reconnect</Button>}
      />
    );
  }

  return (
    <HubRow
      icon="✗"
      iconTone="text-destructive"
      title={title}
      detail={`Last sync failed — ${state.reason}`}
      action={<Button variant="default" size="sm" onClick={onSync}>Retry</Button>}
    />
  );
}
