import type { App } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";
import { StatusStrip } from "@/ui/hub/status-strip";
import { useHubState } from "@/ui/hub/use-hub-state";

export function RoostHubStatusRow({ app, plugin }: { app: App; plugin: IRoostPlugin }) {
  const state = useHubState(app, plugin);
  return (
    <StatusStrip
      state={state}
      onOpenHub={() => {
        void plugin.activateHubLeaf();
      }}
    />
  );
}
