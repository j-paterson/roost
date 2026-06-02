/**
 * Generates Memory/MEMORY.md (Tier 1, fits Hermes' 2200-char system prompt
 * budget) and Memory/MEMORY-archive.md (Tier 2, older/less-active).
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §6.
 */

export interface IndexConcept {
  slug: string;
  name: string;
  summary: string;
  lastUpdated: string;       // YYYY-MM-DD
  activeClaimCount: number;
}

export interface TierOptions {
  maxConcepts: number;
  maxAgeDays: number;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(later: string, earlier: string): number {
  const a = Date.parse(`${later}T00:00:00Z`);
  const b = Date.parse(`${earlier}T00:00:00Z`);
  return Math.floor((a - b) / MS_PER_DAY);
}

/**
 * Tier 1: concepts with `activeClaimCount >= 3` AND `lastUpdated within
 * maxAgeDays`, capped at `maxConcepts`. Sorted by lastUpdated descending.
 * Everything else goes to Tier 2.
 */
export function partitionTiers(
  concepts: IndexConcept[],
  today: string,
  opts: TierOptions,
): { tier1: IndexConcept[]; tier2: IndexConcept[] } {
  const sorted = [...concepts].sort((a, b) =>
    b.lastUpdated.localeCompare(a.lastUpdated),
  );
  const tier1: IndexConcept[] = [];
  const tier2: IndexConcept[] = [];
  for (const c of sorted) {
    const age = daysBetween(today, c.lastUpdated);
    const eligible = c.activeClaimCount >= 3 && age < opts.maxAgeDays;
    if (eligible && tier1.length < opts.maxConcepts) {
      tier1.push(c);
    } else {
      tier2.push(c);
    }
  }
  return { tier1, tier2 };
}

function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

function renderRow(c: IndexConcept): string {
  return `| ${c.slug} | ${escapePipe(c.name)} | ${c.lastUpdated} | ${c.activeClaimCount} | ${escapePipe(c.summary)} |`;
}

export function renderIndex(
  concepts: IndexConcept[],
  generatedIso: string,
): string {
  const activeTotal = concepts.reduce((n, c) => n + c.activeClaimCount, 0);
  const lines: string[] = [];
  lines.push("---");
  lines.push("roost_memory_index: true");
  lines.push(`generated: ${generatedIso}`);
  lines.push("schema_version: 1");
  lines.push(`concept_count: ${concepts.length}`);
  lines.push(`active_claim_count: ${activeTotal}`);
  lines.push("---");
  lines.push("");
  lines.push("# Domain interest index");
  lines.push("");
  lines.push("| Slug | Topic | Updated | Active | Summary |");
  lines.push("|---|---|---|---|---|");
  for (const c of concepts) lines.push(renderRow(c));
  lines.push("");
  return lines.join("\n");
}

export function renderArchive(
  concepts: IndexConcept[],
  generatedIso: string,
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push("roost_memory_archive: true");
  lines.push(`generated: ${generatedIso}`);
  lines.push("schema_version: 1");
  lines.push(`concept_count: ${concepts.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# Archived concepts");
  lines.push("");
  lines.push(
    "Concepts demoted from the active routing index. Still queryable by " +
      "the agent via read_file; just not surfaced in the main MEMORY.md table.",
  );
  lines.push("");
  lines.push("| Slug | Topic | Updated | Active | Summary |");
  lines.push("|---|---|---|---|---|");
  for (const c of concepts) lines.push(renderRow(c));
  lines.push("");
  return lines.join("\n");
}
