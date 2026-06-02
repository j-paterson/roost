import { Button } from "@/ui/components/ui/button";
import type { IntegrationId } from "@/integrations/registry";

export interface IntegrationRow {
  id: IntegrationId;
  label: string;
  unlocks: string;
  enabled: boolean;
  status: "available" | "unavailable" | "unknown";
  setup: string;
}

function statusLine(row: IntegrationRow): { text: string; tone: string } {
  if (!row.enabled) return { text: row.unlocks, tone: "text-muted-foreground" };
  if (row.status === "available") return { text: "Detected", tone: "text-emerald-500" };
  if (row.status === "unavailable") return { text: "Not detected", tone: "text-amber-500" };
  return { text: "Checking…", tone: "text-muted-foreground" };
}

function IntegrationRowView({
  row,
  onToggle,
}: {
  row: IntegrationRow;
  onToggle: (id: IntegrationId, next: boolean) => void;
}) {
  const line = statusLine(row);
  const showSetup = row.enabled && row.status === "unavailable";
  return (
    <div className="px-4 py-2 hover:bg-accent/30 transition-colors">
      <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-3">
        <span className="text-sm font-medium">{row.label}</span>
        <span className={`text-sm truncate ${line.tone}`}>{line.text}</span>
        <Button
          variant={row.enabled ? "secondary" : "outline"}
          size="sm"
          aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.label}`}
          onClick={() => onToggle(row.id, !row.enabled)}
        >
          {row.enabled ? "On" : "Off"}
        </Button>
      </div>
      {showSetup && (
        <p className="mt-1 text-xs text-muted-foreground pl-0">{row.setup}</p>
      )}
    </div>
  );
}

export function IntegrationsPanel({
  rows,
  onToggle,
}: {
  rows: IntegrationRow[];
  onToggle: (id: IntegrationId, next: boolean) => void;
}) {
  return (
    <>
      {rows.map((r) => (
        <IntegrationRowView key={r.id} row={r} onToggle={onToggle} />
      ))}
    </>
  );
}
