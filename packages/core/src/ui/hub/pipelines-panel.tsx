import { Button } from "@/ui/components/ui/button";
import type { PipelineId } from "@/lib/enrichments";
import type { PipelineRow } from "@/ui/hub/pipeline-rows";

function statusText(s: PipelineRow["status"]): { text: string; tone: string } {
  if (s === "active") return { text: "On", tone: "text-emerald-500" };
  if (s === "needs-llm") return { text: "Needs an LLM", tone: "text-amber-500" };
  return { text: "Off", tone: "text-muted-foreground" };
}

export function PipelinesPanel({
  rows, llm, onToggle,
}: {
  rows: PipelineRow[];
  llm: boolean;
  onToggle: (id: PipelineId, next: boolean) => void;
}) {
  return (
    <div>
      <div className="px-4 pt-2 pb-1 text-xs text-muted-foreground">
        {llm ? "Pipelines — powered by your LLM" : "Pipelines — connect Ollama or a cloud LLM to enable"}
      </div>
      {rows.map((row) => {
        const st = statusText(row.status);
        return (
          <div key={row.id} className="px-4 py-2 hover:bg-accent/30 transition-colors">
            <div className="grid grid-cols-[8rem_1fr_auto] items-center gap-3">
              <span className="text-sm font-medium">{row.label}</span>
              <span className={`text-sm truncate ${st.tone}`}>{row.enabled && llm ? row.blurb : st.text}</span>
              <Button
                variant={row.enabled ? "secondary" : "outline"}
                size="sm"
                disabled={!llm}
                aria-label={`${row.enabled ? "Disable" : "Enable"} ${row.label}`}
                onClick={() => onToggle(row.id, !row.enabled)}
              >
                {row.enabled ? "On" : "Off"}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
