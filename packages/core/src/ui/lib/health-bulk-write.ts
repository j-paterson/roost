import type { App, TFile } from "obsidian";
import {
  bulkWriteAssignments,
  type BulkWriteAssignmentsArgs,
  type BulkWriteResult,
} from "@/ui/lib/bulk-write-assignments";
import type { IRoostPlugin } from "@/types/plugin";

export interface HealthBulkWriteDeps {
  app: App;
  plugin: IRoostPlugin;
  log: (msg: string) => void;
  scanLibrary: () => void | Promise<void>;
}

export interface HealthBulkWriteArgs<T> {
  itemAssignments: Map<string, string>;
  fileByKey: Map<string, TFile>;
  patchFor: (key: string, value: string) => Record<string, string | null>;
  afterWrite: () => T | Promise<T>;
}

/** Bulk-write vault notes during a Vault Health action, then refresh library tree. */
export async function bulkWriteHealthAction<T>(
  deps: HealthBulkWriteDeps,
  args: HealthBulkWriteArgs<T>,
): Promise<{ result: BulkWriteResult; data: T }> {
  let data!: T;
  const result = await bulkWriteAssignments({
    itemAssignments: args.itemAssignments,
    fileByKey: args.fileByKey,
    fileManager: deps.app.fileManager,
    plugin: deps.plugin,
    events: deps.app.metadataCache,
    patchFor: args.patchFor,
    log: deps.log,
    setProgress: () => {},
    runUnderGuard: async () => {
      await deps.scanLibrary();
      data = await args.afterWrite();
    },
  });
  return { result, data };
}

/** Bulk-write explicit per-key patches (review decisions, etc.). */
export async function bulkWritePatches(
  writes: Map<string, { file: TFile; patch: Record<string, string | null> }>,
  args: Omit<BulkWriteAssignmentsArgs, "itemAssignments" | "fileByKey" | "patchFor">,
): Promise<BulkWriteResult> {
  const itemAssignments = new Map<string, string>();
  const fileByKey = new Map<string, TFile>();
  for (const [key, { file }] of writes) {
    itemAssignments.set(key, "");
    fileByKey.set(key, file);
  }
  return bulkWriteAssignments({
    ...args,
    itemAssignments,
    fileByKey,
    patchFor: (key) => writes.get(key)?.patch ?? {},
  });
}
