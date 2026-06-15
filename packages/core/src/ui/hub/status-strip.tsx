import { type HubState } from "@/ui/hub/state";
import { formatAge } from "@/ui/hub/format-age";

export function StatusStrip({
  state,
  onOpenHub,
}: {
  state: HubState;
  onOpenHub: () => void;
}) {
  let icon: string;
  let tone: string;
  let label: string;

  if (state.global.anythingNeedsAttention) {
    const allMissing =
      state.prereqs.folder !== "ok" &&
      state.prereqs.ollama !== "ok" &&
      Object.values(state.platforms).every((p) => p.kind === "unconfigured");
    if (allMissing) {
      icon = "✗";
      tone = "text-destructive";
      label = "Setup incomplete";
    } else {
      icon = "⚠";
      tone = "text-amber-500";
      label = "Needs attention";
    }
  } else {
    icon = "✓";
    tone = "text-emerald-500";
    label = `All caught up · ${formatAge(state.global.lastFullUpdate)}`;
  }

  return (
    <button
      type="button"
      onClick={onOpenHub}
      className="roost-hub-strip group w-full text-left px-3 py-2 border-b border-border hover:bg-accent/50 flex items-center gap-2 transition-colors"
    >
      <span className={`shrink-0 ${tone} font-semibold`} aria-hidden>{icon}</span>
      <span className="flex-1 text-sm">{label}</span>
      {state.embedding && (
        <span className="text-muted-foreground text-xs">
          {state.embedding.warn ? "⚠️ " : ""}Embeddings: {state.embedding.label}
        </span>
      )}
      <span className="text-muted-foreground text-xs opacity-70 group-hover:opacity-100">
        Open Hub →
      </span>
    </button>
  );
}
