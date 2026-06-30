import type { RefObject } from "react";
import { type PlatformState } from "@/ui/hub/state";
import { formatAge } from "@/ui/hub/format-age";
import { Button } from "@/ui/components/ui/button";
import type { LiveSync } from "@/ui/hub/hub-body";
import type { SyncProgress } from "@/ui/components/progress-header";
import { enabledPlatforms } from "@/platforms/registry";

export type PlatformId = "tiktok" | "x" | "instagram" | "reddit" | "eagle";

// Module-level lookup built once from the registry: hubId → descriptor.
// Eagle is not a sync platform and is handled by explicit literals below.
const _hubDescriptors = Object.fromEntries(enabledPlatforms().map(d => [d.hubId, d]));

function cardTitle(platform: PlatformId): string {
  if (platform === "eagle") return "Eagle";
  return _hubDescriptors[platform]?.card.title ?? platform;
}

function cardEduCopy(platform: PlatformId): string {
  if (platform === "eagle") return "Imports items from a local Eagle library.";
  return _hubDescriptors[platform]?.card.eduCopy ?? "";
}

interface BacklogRow {
  key: string;
  label: string;
  count: number;
}

function backlogRowsFor(
  platform: PlatformId,
  backlogs: { mediaFiles: number; thread: number; articleBody: number; playback: number },
): BacklogRow[] {
  if (platform === "tiktok") {
    return backlogs.mediaFiles > 0
      ? [{ key: "mediaFiles", label: "missing media", count: backlogs.mediaFiles }]
      : [];
  }
  if (platform === "x") {
    const rows: BacklogRow[] = [];
    if (backlogs.thread > 0) rows.push({ key: "thread", label: "threads incomplete", count: backlogs.thread });
    if (backlogs.articleBody > 0) rows.push({ key: "article", label: "article bodies queued", count: backlogs.articleBody });
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
  // enrich/articles report `count` as the current-item index against `total`
  // (the opposite of scroll phases), so render count/total directly rather
  // than the cumulative processed-count default below.
  if (p.phase === "enrich") return `enriching threads ${p.count} / ${p.total ?? p.count}`;
  if (p.phase === "articles") return `fetching articles ${p.count} / ${p.total ?? p.count}`;
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
  // enrich/articles: count is the current-item index against `total`.
  if (p.phase === "enrich" || p.phase === "articles") {
    const denom = p.total ?? 0;
    return denom > 0 ? Math.min(100, (p.count / denom) * 100) : 0;
  }
  if (p.count <= 0) return 0;
  const done = p.written + p.resynced + p.skipped;
  return Math.min(100, (done / p.count) * 100);
}

function isIndeterminate(p: SyncProgress | null): boolean {
  if (!p) return true;
  return p.phase === "clustering" || p.phase === "scanning" || p.phase === "setup";
}

/**
 * Active-sync row: two columns — the sync line (status + progress) on the left,
 * and a small live webview preview on the right that shows the platform site
 * driving the sync. The webview element is re-parented into `mountRef` by
 * run-platform-sync for the duration of the sync, then returned to the manager's
 * hidden container on completion (so the slot only renders while syncing).
 */
function LiveSyncRow({
  platform,
  live,
  mountRef,
  onCancel,
}: {
  platform: PlatformId;
  live: LiveSync;
  mountRef: RefObject<HTMLDivElement | null>;
  onCancel: () => void;
}) {
  const p = live.progress;
  return (
    <div className="border-b border-border last:border-b-0 px-4 py-2">
      <div className="grid grid-cols-[1fr_9rem] gap-3 items-stretch">
        {/* Left column: the sync line + progress bar. */}
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-muted-foreground animate-pulse" aria-hidden>⟳</span>
            <span className="text-sm font-medium truncate">{cardTitle(platform)}</span>
            <span className="ml-auto shrink-0">
              <Button variant="outline" size="xs" onClick={onCancel}>Cancel</Button>
            </span>
          </div>
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
        {/* Right column: small live webview preview (~9rem wide, 4:3). */}
        <div
          data-testid="sync-webview-slot"
          className="self-center border border-border rounded-md overflow-hidden bg-background"
          style={{ aspectRatio: "4 / 3" }}
          title={`${cardTitle(platform)} sync — live`}
        >
          <div ref={mountRef} className="w-full h-full" />
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
  loginActive,
  webviewMountRef,
  onConnect,
  onSync,
  onReconnect,
  onCancelLogin,
  onDisconnect,
  onCancel,
}: {
  platform: PlatformId;
  state: PlatformState;
  live?: LiveSync | null;
  /** True while the login webview is mounted inline in this card. */
  loginActive?: boolean;
  webviewMountRef?: RefObject<HTMLDivElement | null> | null;
  onConnect: () => void;
  onSync: () => void;
  onReconnect: () => void;
  /** Stop/cancel an in-progress inline login. */
  onCancelLogin?: () => void;
  /** Clear session + sync state. Omitted for platforms without a session
   *  (e.g. Eagle); the Disconnect button only renders when provided. */
  onDisconnect?: () => void;
  onCancel?: () => void;
}) {
  const title = cardTitle(platform);

  // While a sync is live for this platform, render the two-column sync row:
  // status + progress on the left, a small live webview preview on the right.
  if (live && webviewMountRef) {
    return (
      <LiveSyncRow
        platform={platform}
        live={live}
        mountRef={webviewMountRef}
        onCancel={onCancel ?? (() => {})}
      />
    );
  }

  // Inline login: show the embedded platform site (which displays its login
  // screen while logged out) until the auth probe detects the session.
  if (loginActive && webviewMountRef) {
    return (
      <>
        <HubRow
          icon="…"
          iconTone="text-muted-foreground animate-pulse"
          title={title}
          detail="Log in below — Roost will detect it automatically"
          action={<Button variant="outline" size="sm" onClick={onCancelLogin}>Cancel</Button>}
        />
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
        detail={cardEduCopy(platform)}
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
          action={
            <div className="flex items-center gap-2">
              <Button variant="default" size="sm" onClick={onSync}>Sync</Button>
              {onDisconnect && (
                <Button variant="outline" size="xs" onClick={onDisconnect} title="Clear login + sync state for this platform">
                  Disconnect
                </Button>
              )}
            </div>
          }
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
