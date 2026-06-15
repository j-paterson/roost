/**
 * Embedding cache provenance — records which backend produced the current
 * vectors so the system can detect silent degradation (e.g. fine-tuned sidecar
 * went down and the pipeline fell back to raw Ollama). Run-level granularity:
 * one record per embed pass, stamped when vectors actually change.
 */
import type { Vault } from "obsidian";
import * as fs from "fs";
import { cachePath } from "@/lib/roost-paths";
import { vaultBasePath } from "@/lib/vault-utils";

export interface EmbeddingProvenance {
  source: "sidecar" | "ollama";
  model: string;
  embeddedAt: string;   // ISO
  vaultPath: string;
}

export type ProvenanceMismatch =
  | { kind: "none" }
  | { kind: "match" }
  | { kind: "sidecar-down" }
  | { kind: "vault-moved"; was: string; now: string }
  | { kind: "upgrade-available" };

const FILE = "embedding-provenance.json";

export function loadProvenance(vault: Vault): EmbeddingProvenance | null {
  try {
    const raw = fs.readFileSync(cachePath(vaultBasePath(vault), FILE), "utf8");
    const p = JSON.parse(raw);
    if (p && (p.source === "sidecar" || p.source === "ollama") && typeof p.vaultPath === "string") return p;
    return null;
  } catch { return null; }
}

export function saveProvenance(vault: Vault, prov: EmbeddingProvenance): void {
  try {
    fs.writeFileSync(cachePath(vaultBasePath(vault), FILE), JSON.stringify(prov));
  } catch (e) {
    console.warn("[roost] failed to write embedding provenance:", e instanceof Error ? e.message : String(e));
  }
}

/**
 * Compare stored provenance against the currently-active backend + vault path.
 * Precedence: sidecar-down (running degraded NOW) is the headline and wins over
 * vault-moved; then vault-moved; then upgrade-available; else match.
 */
export function classifyMismatch(
  prov: EmbeddingProvenance | null,
  activeBackend: "sidecar" | "ollama",
  currentVaultPath: string,
): ProvenanceMismatch {
  if (!prov) return { kind: "none" };
  if (prov.source === "sidecar" && activeBackend === "ollama") return { kind: "sidecar-down" };
  if (prov.vaultPath !== currentVaultPath) return { kind: "vault-moved", was: prov.vaultPath, now: currentVaultPath };
  if (prov.source === "ollama" && activeBackend === "sidecar") return { kind: "upgrade-available" };
  return { kind: "match" };
}
