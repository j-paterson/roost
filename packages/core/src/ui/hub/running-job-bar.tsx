/**
 * A slim banner shown at the top of the hub body whenever a heavy job is
 * running in the serial RoostJobQueue (backfills, pipeline runs). Surfaces the
 * running job's label and a Cancel button that aborts the current job's signal
 * so it stops between batches. The queue keeps draining after the abort.
 *
 * Rendered by hub-body.tsx only when state.global.runningJob is non-null.
 */
import { Button } from "@/ui/components/ui/button";

export function RunningJobBar({
  label,
  onCancel,
}: {
  label: string;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-muted/40">
      <span className="text-sm text-muted-foreground truncate min-w-0">
        <span className="font-medium text-foreground">Running:</span> {label}
      </span>
      <Button variant="ghost" size="sm" onClick={onCancel} className="shrink-0 ml-3">
        Cancel
      </Button>
    </div>
  );
}
