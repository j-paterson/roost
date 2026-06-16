/**
 * One-off vault migration command palette entries.
 */
import { Notice } from "obsidian";
import { runMediaPipelineMigration } from "@/pipeline/media-pipeline-migrate";
import { runRecipePipelineMigration } from "@/pipeline/recipe-pipeline-migrate";
import { runPlacePipelineMigration } from "@/pipeline/place-pipeline-migrate";
import { runNamespaceMigration } from "@/lib/namespace-migrate";
import { recoverStructuredFrontmatter } from "@/pipeline/recover-structured-frontmatter";
import type { RoostCommandHost } from "@/plugin/roost-command-host";

export function registerMigrationCommands(plugin: RoostCommandHost): void {
  plugin.addCommand({
    id: "migrate-media-pipeline",
    name: "Migrate Media pipeline notes to bookmark frontmatter",
    callback: async () => { await runMediaPipelineMigration(plugin); },
  });
  plugin.addCommand({
    id: "migrate-recipe-pipeline",
    name: "Migrate Recipe pipeline notes to bookmark frontmatter",
    callback: async () => { await runRecipePipelineMigration(plugin); },
  });
  plugin.addCommand({
    id: "migrate-place-pipeline",
    name: "Migrate Places pipeline notes to bookmark frontmatter",
    callback: async () => { await runPlacePipelineMigration(plugin); },
  });
  plugin.addCommand({
    id: "migrate-pipeline-namespaces",
    name: "Migrate Roost frontmatter namespaces",
    callback: async () => { await runNamespaceMigration(plugin); },
  });
  plugin.addCommand({
    id: "recover-structured-frontmatter",
    name: "Recover ingredient/exercise frontmatter from cache",
    callback: async () => {
      const result = await recoverStructuredFrontmatter(plugin);
      new Notice(
        `Recover complete: ${result.recipesFixed} recipe notes fixed, ${result.workoutsFixed} workout notes fixed.`,
      );
    },
  });
}
