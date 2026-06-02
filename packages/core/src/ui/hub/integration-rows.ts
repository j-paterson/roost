import { INTEGRATIONS, type IntegrationId } from "@/integrations/registry";
import type { IntegrationFlags } from "@/settings";
import type { IntegrationRow } from "@/ui/hub/integrations-panel";

/** Build the panel rows from the registry, the settings flags, and live detection status. */
export function buildIntegrationRows(
  flags: IntegrationFlags,
  status: Record<IntegrationId, "available" | "unavailable" | "unknown">,
): IntegrationRow[] {
  return INTEGRATIONS.map((i) => ({
    id: i.id,
    label: i.label,
    unlocks: i.unlocks,
    enabled: flags[i.flagKey],
    status: status[i.id],
    setup: i.setup.instructions,
  }));
}
