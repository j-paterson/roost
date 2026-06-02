import { describe, it, expect, vi } from "vitest";
import * as obsidian from "obsidian";
import { registerRoostCommands } from "@/plugin/register-roost-commands";
import { ENRICHMENTS, isPipelineEnrichmentId } from "@/lib/enrichments";
import { PIPELINE_INACTIVE_MESSAGE } from "@/lib/pipeline-gate-plugin";

/** Build a minimal plugin stub that satisfies registerRoostCommands registration
 *  (methods are only called during callback invocation, not at registration time,
 *  so only addCommand + addRibbonIcon + settings + integrationStatus are required).
 *  llmBackend "skip" forces llmAvailable → false → all pipeline commands inactive. */
function makePluginStub(overrides?: { pipelineOn?: boolean; llmBackend?: "skip" | "local" | "cloud" }) {
  const cmds = new Map<string, () => Promise<void> | void>();
  const plugin = {
    addCommand: (c: { id: string; name: string; callback: () => Promise<void> | void }) => {
      cmds.set(c.id, c.callback);
    },
    addRibbonIcon: vi.fn(),
    app: {},
    settings: {
      llmBackend: overrides?.llmBackend ?? "skip",
      anthropicApiKey: "",
      integrations: { vaultSearch: false, ollama: false, sidecar: false, ffmpeg: false },
      pipelines: {
        recipe: overrides?.pipelineOn ?? true,
        place: overrides?.pipelineOn ?? true,
        mediaExtraction: overrides?.pipelineOn ?? true,
        product: overrides?.pipelineOn ?? true,
        workout: overrides?.pipelineOn ?? true,
        tutorial: overrides?.pipelineOn ?? true,
        home: overrides?.pipelineOn ?? true,
      },
    },
    integrationStatus: {
      ollama: "unknown",
      sidecar: "unknown",
      ffmpeg: "unknown",
      "vault-search": "unknown",
    },
  } as any;
  return { plugin, cmds };
}

describe("pipeline command guard", () => {
  it("registers all pipeline commands without throwing", () => {
    const { plugin, cmds } = makePluginStub();
    registerRoostCommands(plugin);
    // All 7 pipeline commandIds must be registered.
    const pipelineEnrichments = ENRICHMENTS.filter((e) => isPipelineEnrichmentId(e.id));
    for (const def of pipelineEnrichments) {
      expect(cmds.has(def.commandId)).toBe(true);
    }
  });

  it("pipeline command fires Notice and does NOT call runBackfill when inactive (llm=skip)", async () => {
    const { plugin, cmds } = makePluginStub({ llmBackend: "skip", pipelineOn: true });
    // Spy on Notice constructor — the mock is a no-op class; we verify it is called.
    const noticeSpy = vi.spyOn(obsidian, "Notice");
    registerRoostCommands(plugin);

    // Find the recipe enrichment def and spy on its runBackfill.
    const recipeDef = ENRICHMENTS.find(e => e.id === "recipe")!;
    const backfillSpy = vi.spyOn(recipeDef, "runBackfill").mockResolvedValue(undefined);

    const recipeCb = cmds.get("run-recipe-pipeline");
    expect(recipeCb).toBeTruthy();
    await recipeCb!();

    expect(noticeSpy).toHaveBeenCalledOnce();
    expect(noticeSpy.mock.calls[0][0]).toBe(PIPELINE_INACTIVE_MESSAGE);
    expect(backfillSpy).not.toHaveBeenCalled();

    backfillSpy.mockRestore();
    noticeSpy.mockRestore();
  });

  it("pipeline command runs backfill when active (flag on + local llm available)", async () => {
    const { plugin, cmds } = makePluginStub({ llmBackend: "local", pipelineOn: true });
    // Make ollama appear available so llmAvailable returns true.
    plugin.integrationStatus.ollama = "available";
    plugin.settings.integrations.ollama = true;

    registerRoostCommands(plugin);

    const recipeDef = ENRICHMENTS.find(e => e.id === "recipe")!;
    const backfillSpy = vi.spyOn(recipeDef, "runBackfill").mockResolvedValue(undefined);

    const recipeCb = cmds.get("run-recipe-pipeline");
    await recipeCb!();

    expect(backfillSpy).toHaveBeenCalledOnce();
    backfillSpy.mockRestore();
  });

  it("non-pipeline (backfill) commands run unconditionally even when llm is skip", async () => {
    const { plugin, cmds } = makePluginStub({ llmBackend: "skip" });
    registerRoostCommands(plugin);

    // articleBody is a data backfill — NOT a pipeline id — so it must always run.
    const articleDef = ENRICHMENTS.find(e => e.id === "articleBody")!;
    const backfillSpy = vi.spyOn(articleDef, "runBackfill").mockResolvedValue(undefined);

    const cb = cmds.get(articleDef.commandId);
    expect(cb).toBeTruthy();
    await cb!();

    expect(backfillSpy).toHaveBeenCalledOnce();
    backfillSpy.mockRestore();
  });
});
