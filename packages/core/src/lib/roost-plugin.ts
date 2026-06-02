import type { App } from "obsidian";
import { PLUGIN_ID } from "@/config";
import type { IRoostPlugin } from "@/types/plugin";

type PluginHost = App & {
  plugins?: { plugins?: Record<string, IRoostPlugin> };
};

/** Typed access to the Roost plugin from views and modals */
export function getRoostPlugin(app: App): IRoostPlugin | null {
  return (app as PluginHost).plugins?.plugins?.[PLUGIN_ID] ?? null;
}
