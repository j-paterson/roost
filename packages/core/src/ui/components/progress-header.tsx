import * as React from "react";
import { Pill } from "./ui/pill";
import { Button } from "./ui/button";

const PIPELINE_STEPS = ["Embed", "Score Known", "Discover", "Describe", "Score New", "Review"] as const;

export interface SyncProgress {
  phase: string;
  count: number;
  written: number;
  skipped: number;
  resynced: number;
}

interface ProgressHeaderProps {
  syncing: boolean;
  syncProgress: SyncProgress | null;
  pipelineStep: number | null;
  categoryCount: number;
  mode: string;
  onCancel: () => void;
}

export function ProgressHeader({ syncing, syncProgress, pipelineStep, categoryCount, mode, onCancel }: ProgressHeaderProps) {
  // Outer container is unwrapped so RoostView can merge the setup-health panel
  // inside the same bordered block. Parent handles the bottom border.
  return (
    <div className="shrink-0">
      <div className="flex items-center gap-2 px-3 py-2">
        <strong className="text-muted-foreground text-base">Roost</strong>
        <div className="flex-1" />
        {mode === "staging" && (
          <span className="text-xs text-muted-foreground">{categoryCount} categories</span>
        )}
      </div>

      {/* Pipeline step indicator */}
      {pipelineStep != null && (() => {
        const step = pipelineStep;
        return (
          <div className="roost-pipeline-steps px-3 py-1.5 text-xs">
            <div className="roost-pipeline-pills">
              {PIPELINE_STEPS.map((name, i) => (
                <div key={name} className="flex items-center gap-1">
                  {i > 0 && <span className="roost-pipeline-arrow text-muted-foreground">→</span>}
                  <Pill
                    variant={i < step ? "success" : i === step ? "active" : "muted"}
                    size="sm"
                  >
                    {i < step ? "✓ " : ""}{name}
                  </Pill>
                </div>
              ))}
            </div>
            <Button
              variant="destructive"
              size="xs"
              className="rounded-full shrink-0"
              onClick={onCancel}
              title="Cancel Smart Assign"
            >Cancel</Button>
          </div>
        );
      })()}

      {/* Progress bar */}
      {syncing && syncProgress && (
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <span className="font-medium capitalize">{syncProgress.phase}</span>
            <span className="flex-1" />
            {syncProgress.phase === "scanning" ? (
              <span>scanning vault...</span>
            ) : syncProgress.phase === "embedding" ? (
              <span>{syncProgress.written} / {syncProgress.count} items</span>
            ) : syncProgress.phase === "setup" ? (
              <span>setting up Python environment...</span>
            ) : syncProgress.phase === "reducing" ? (
              <span>epoch {syncProgress.written} / {syncProgress.count}</span>
            ) : syncProgress.phase === "clustering" ? (
              <span>processing...</span>
            ) : syncProgress.phase === "scoring" ? (
              <span>{syncProgress.written} / {syncProgress.count} items scored</span>
            ) : syncProgress.phase === "writing" ? (
              <span>{syncProgress.written} / {syncProgress.count} items written</span>
            ) : syncProgress.phase === "renaming" ? (
              <span>{syncProgress.written} / {syncProgress.count} items renamed</span>
            ) : (
              <span>
                {syncProgress.written + syncProgress.resynced + syncProgress.skipped} / {syncProgress.count} processed
                {` — `}
                {[
                  syncProgress.written > 0 && `${syncProgress.written} new`,
                  syncProgress.resynced > 0 && `${syncProgress.resynced} resynced`,
                  syncProgress.skipped > 0 && `${syncProgress.skipped} skipped`,
                ].filter(Boolean).join(", ")}
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-border overflow-hidden">
            {syncProgress.phase === "clustering" || syncProgress.phase === "scanning" || syncProgress.phase === "setup" ? (
              <div className="h-full bg-primary rounded-full w-full animate-pulse" />
            ) : (
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: syncProgress.count > 0 ? `${Math.min(100, ((syncProgress.written + syncProgress.resynced + syncProgress.skipped) / syncProgress.count) * 100)}%` : "0%" }}
              />
            )}
          </div>
        </div>
      )}
      {syncing && !syncProgress && (
        <div className="px-3 pb-2">
          <div className="h-1.5 rounded-full bg-border overflow-hidden">
            <div className="h-full bg-primary rounded-full w-full animate-pulse" />
          </div>
        </div>
      )}
    </div>
  );
}
