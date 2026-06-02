import type { IntegrationFlags } from "@/settings";
import type { DetectStatus } from "@/integrations/registry";

type Status = DetectStatus | "unknown";

/** True if at least one embedding backend (Ollama or sidecar) is flagged on AND detected available. */
export function embeddingBackendAvailable(
  flags: IntegrationFlags,
  status: { ollama: Status; sidecar: Status },
): boolean {
  return (
    (flags.ollama && status.ollama === "available") ||
    (flags.sidecar && status.sidecar === "available")
  );
}
