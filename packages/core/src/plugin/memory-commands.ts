/**
 * Agent memory command palette entries.
 */
import { Notice } from "obsidian";
import { runWeeklyDigest } from "@/pipeline/digest-pipeline";
import { currentWeekStart, weekIdFromStart } from "@/lib/week-boundary";
import { rebuildIndexOnly, CACHE_PATH as MEMORY_CACHE_PATH } from "@/pipeline/memory/writer";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export function registerMemoryCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "rebuild-memory-index",
    name: "Memory: rebuild MEMORY.md index from concept files",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      try {
        await rebuildIndexOnly(plugin.app, {
          indexOpts: {
            maxConcepts: plugin.settings.memoryIndexTier1MaxConcepts,
            maxAgeDays: plugin.settings.memoryIndexTier1MaxAgeDays,
          },
        });
        new Notice("Memory index rebuilt.");
        log("memory index rebuilt");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Memory index rebuild failed: ${msg}`);
        log(`memory index rebuild failed: ${msg}`);
      }
    },
  });

  plugin.addCommand({
    id: "rebuild-memory-from-digest",
    name: "Memory: rebuild from a specific weekly digest",
    callback: async () => {
      const defaultWeek = weekIdFromStart(currentWeekStart(new Date()));
      const weekId = window.prompt(
        "Rebuild memory from which digest week? (YYYY-MM-DD week start)",
        defaultWeek,
      );
      if (!weekId) return;
      const log = (msg: string): void => { plugin.fireLog(msg); };
      const parts = weekId.split("-").map(Number);
      if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
        new Notice(`Invalid week-start date: ${weekId}`);
        return;
      }
      const weekStart = new Date(parts[0], parts[1] - 1, parts[2]);
      const settingsForThisRun = { ...plugin.settings, memoryEnabled: true };
      try {
        const result = await runWeeklyDigest(
          plugin.app,
          plugin.settings.syncFolder,
          weekStart,
          log,
          settingsForThisRun,
        );
        new Notice(
          `Memory rebuilt from ${weekId}: ${result.itemCount} items across ${result.clusterCount} clusters.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Memory rebuild failed: ${msg}`);
        log(`memory rebuild failed: ${msg}`);
      }
    },
  });

  plugin.addCommand({
    id: "memory-calibrate",
    name: "Memory: print similarity-threshold calibration",
    callback: async () => {
      const log = (msg: string): void => { plugin.fireLog(msg); };
      try {
        if (!(await plugin.app.vault.adapter.exists(MEMORY_CACHE_PATH))) {
          new Notice("No memory cache found yet. Run at least one digest with memory enabled.");
          return;
        }
        const raw = await plugin.app.vault.adapter.read(MEMORY_CACHE_PATH);
        const cache = JSON.parse(raw) as {
          claimDecisions?: Record<string, { decision: { action: string }; similarity: number }>;
        };
        const bins: Record<string, number[]> = {
          skip_redundant: [],
          ambiguous_add: [],
          ambiguous_merge: [],
          ambiguous_invalidate: [],
          ambiguous_skip: [],
          add: [],
        };
        for (const entry of Object.values(cache.claimDecisions ?? {})) {
          const action = entry.decision.action;
          const sim = entry.similarity;
          if (sim >= 0.92) bins.skip_redundant.push(sim);
          else if (sim < 0.75) bins.add.push(sim);
          else if (action in { add: 1, merge: 1, invalidate: 1, skip: 1 }) {
            bins[`ambiguous_${action}`]?.push(sim);
          }
        }
        const summary = Object.entries(bins)
          .map(([k, sims]) => {
            if (sims.length === 0) return `  ${k}: 0 samples`;
            const avg = sims.reduce((a, b) => a + b, 0) / sims.length;
            const min = Math.min(...sims);
            const max = Math.max(...sims);
            return `  ${k}: ${sims.length} samples, avg ${avg.toFixed(3)}, range [${min.toFixed(3)}, ${max.toFixed(3)}]`;
          })
          .join("\n");
        log(`Memory calibration histogram:\n${summary}`);
        new Notice("Memory calibration printed to log.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        new Notice(`Calibration failed: ${msg}`);
        log(`calibration failed: ${msg}`);
      }
    },
  });
}
