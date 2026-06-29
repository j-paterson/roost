import * as fs from "fs";
import type { Vault } from "obsidian";
import { cachePath, cacheDir } from "@/lib/roost-paths";
import { vaultBasePath } from "@/lib/vault-utils";

export interface RetrainLogRecord {
  ts: number;
  ran: boolean;
  swapped: boolean;
  reason: string;
  avgOverallDelta?: number;
  avgMacroDelta?: number;
  catastrophic?: string[];
}

const FILE = "retrain-log.jsonl";

export function appendRetrainLog(vault: Vault, rec: RetrainLogRecord): void {
  const root = vaultBasePath(vault);
  if (!root) return;
  try {
    fs.mkdirSync(cacheDir(root), { recursive: true });
    fs.appendFileSync(cachePath(root, FILE), JSON.stringify(rec) + "\n");
  } catch (e: unknown) {
    console.warn("[roost] retrain-log append failed:", e instanceof Error ? e.message : String(e));
  }
}

/** Parse a raw JSONL string into RetrainLogRecords. Each line is parsed independently;
 *  unparseable lines are silently skipped so one corrupt line cannot discard the whole log. */
export function parseRetrainLines(raw: string): RetrainLogRecord[] {
  const out: RetrainLogRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as RetrainLogRecord);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}

export function readRetrainLog(vault: Vault): RetrainLogRecord[] {
  const root = vaultBasePath(vault);
  if (!root) return [];
  try {
    const raw = fs.readFileSync(cachePath(root, FILE), "utf8");
    return parseRetrainLines(raw);
  } catch {
    return [];
  }
}
