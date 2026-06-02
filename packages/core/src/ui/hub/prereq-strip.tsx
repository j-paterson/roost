import { type PrereqStatus } from "@/ui/hub/state";
import { Button } from "@/ui/components/ui/button";

function statusBadge(s: PrereqStatus): { icon: string; tone: string } {
  if (s === "ok") return { icon: "✓", tone: "text-emerald-500" };
  if (s === "warning") return { icon: "⚠", tone: "text-amber-500" };
  return { icon: "✗", tone: "text-destructive" };
}

function PrereqRow({
  status,
  title,
  detail,
  action,
}: {
  status: PrereqStatus;
  title: string;
  detail: React.ReactNode;
  action?: React.ReactNode;
}) {
  const b = statusBadge(status);
  return (
    <div className="grid grid-cols-[1.25rem_8rem_1fr_auto] items-center gap-3 px-4 py-2 hover:bg-accent/30 transition-colors">
      <span className={`text-sm font-semibold ${b.tone}`} aria-hidden>{b.icon}</span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-sm text-muted-foreground truncate">{detail}</span>
      <div className="justify-self-end">{action}</div>
    </div>
  );
}

export function PrereqStrip({
  prereqs,
  folderPath,
  onPickFolder,
  onRecheckOllama,
}: {
  prereqs: { folder: PrereqStatus; ollama: PrereqStatus };
  folderPath: string;
  onPickFolder: () => void;
  onRecheckOllama: () => void;
}) {
  return (
    <>
      <PrereqRow
        status={prereqs.folder}
        title="Folder"
        detail={folderPath || <span className="italic">not set</span>}
        action={
          prereqs.folder !== "ok" ? (
            <Button variant="outline" size="xs" onClick={onPickFolder}>Set folder</Button>
          ) : null
        }
      />
      <PrereqRow
        status={prereqs.ollama}
        title="Local AI"
        detail="Ollama — for Smart Assign + memory (not required for sync)"
        action={
          prereqs.ollama !== "ok" ? (
            <Button variant="outline" size="xs" onClick={onRecheckOllama}>Re-check</Button>
          ) : null
        }
      />
    </>
  );
}
