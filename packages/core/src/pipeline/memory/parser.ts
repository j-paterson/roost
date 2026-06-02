/**
 * Parser + serializer for Memory/topics/{slug}.md concept files.
 *
 * Spec: docs/superpowers/specs/2026-05-18-agent-memory-design.md §5.
 */
import { formatBitemporalRange, parseBitemporalRange } from "./schema";
import type { ConceptNode, ClaimEntry, ClaimSource, Relation, Confidence, RelationType } from "./schema";

function yamlString(s: string): string {
  // Double-quoted YAML string with full control-character escaping.
  const escaped = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function formatRelations(rels: Relation[]): string {
  return rels.map((r) => `${r.type} ${r.targetId}`).join(", ");
}

function assertNoReservedSeparator(text: string, field: string): void {
  if (text.includes(" · ")) {
    throw new Error(
      `serializeConcept: claim ${field} cannot contain " · " (reserved separator). ` +
      `Strip or replace before serialization. Offending text: "${text.slice(0, 80)}..."`,
    );
  }
}

function serializeClaim(c: ClaimEntry): string[] {
  assertNoReservedSeparator(c.text, `${c.id} text`);
  const headerParts = [
    `**${c.id}**`,
    formatBitemporalRange(c.range),
  ];
  if (c.relations.length > 0) {
    headerParts.push(formatRelations(c.relations));
  }
  headerParts.push(c.text);
  const header = `- ${headerParts.join(" · ")}`;

  const sourcesWiki = c.sources
    .map((s) => (s.label ? `[[${s.path}|${s.label}]]` : `[[${s.path}]]`))
    .join(", ");
  const provParts: string[] = [];
  provParts.push(`Sources: ${sourcesWiki}`);
  provParts.push(`logged: ${c.logged}`);
  if (c.confidence !== "auto") {
    provParts.push(`confidence: ${c.confidence}`);
  }
  const seenSuffix = c.seenIn.length === 1 ? "digest" : "digests";
  provParts.push(`seen in: ${c.seenIn.join(", ")} ${seenSuffix}`);
  const provLine = `  ${provParts.join(" · ")}`;

  return [header, provLine];
}

export function serializeConcept(c: ConceptNode): string {
  assertNoReservedSeparator(c.name, "name");
  assertNoReservedSeparator(c.summary, "summary");
  const lines: string[] = [];

  // Frontmatter.
  lines.push("---");
  lines.push("type: concept");
  lines.push(`slug: ${c.slug}`);
  lines.push(`name: ${yamlString(c.name)}`);
  lines.push(`summary: ${yamlString(c.summary)}`);
  lines.push(`embedding: [${c.embedding.join(", ")}]`);
  lines.push(`created: ${c.created}`);
  lines.push(`last_updated: ${c.lastUpdated}`);
  lines.push(`claim_count: ${c.claimCount}`);
  lines.push(`active_claim_count: ${c.activeClaimCount}`);
  lines.push(`related: [${c.related.join(", ")}]`);
  lines.push(`source_digests: [${c.sourceDigests.join(", ")}]`);
  lines.push("---");
  lines.push("");

  // H1 + summary.
  lines.push(`# ${c.name}`);
  lines.push("");
  lines.push(c.summary);
  lines.push("");

  // Claims.
  lines.push("## Claims");
  lines.push("");
  for (const claim of c.claims) {
    const [header, prov] = serializeClaim(claim);
    lines.push(header);
    lines.push(prov);
    lines.push("");
  }

  return lines.join("\n");
}

// ── Parser helpers ──────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const CLAIM_HEADER_RE =
  /^- \*\*([^*]+)\*\* · (\d{4}-\d{2}-\d{2} → (?:\d{4}-\d{2}-\d{2}|present)) · (.+)$/;
const PROV_LINE_RE = /^ {2}(.+)$/;
const RELATION_TOKEN_RE =
  /^(supports|refines|contradicts|supersedes) (c[1-9][0-9]*)$/;
const WIKILINK_RE = /\[\[(.+?)\]\]/g;

function parseFrontmatterField(line: string): { key: string; value: string } | null {
  const idx = line.indexOf(":");
  if (idx <= 0) return null;
  const key = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).trim();
  return { key, value };
}

function unquoteYamlString(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const body = s.slice(1, -1);
    let out = "";
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "\\" && i + 1 < body.length) {
        const next = body[i + 1];
        if (next === "n") { out += "\n"; i++; }
        else if (next === "r") { out += "\r"; i++; }
        else if (next === "t") { out += "\t"; i++; }
        else if (next === '"') { out += '"'; i++; }
        else if (next === "\\") { out += "\\"; i++; }
        else { out += body[i]; }
      } else {
        out += body[i];
      }
    }
    return out;
  }
  return s;
}

function parseYamlList(s: string): string[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((x) => x.trim()).filter(Boolean);
}

function parseEmbedding(s: string): number[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return inner.split(",").map((x) => Number(x.trim()));
}

function isConfidence(s: string): s is Confidence {
  return s === "auto" || s === "medium" || s === "high";
}

function tryParseRelations(seg: string): Relation[] | null {
  const tokens = seg.split(",").map((t) => t.trim());
  const out: Relation[] = [];
  for (const tok of tokens) {
    const m = tok.match(RELATION_TOKEN_RE);
    if (!m) return null;
    out.push({ type: m[1] as RelationType, targetId: m[2] });
  }
  return out;
}

function parseClaimHeader(line: string): {
  id: string;
  range: ReturnType<typeof parseBitemporalRange>;
  relations: Relation[];
  text: string;
} | null {
  const m = line.match(CLAIM_HEADER_RE);
  if (!m) return null;
  const id = m[1].trim();
  const range = parseBitemporalRange(m[2]);
  if (!range) return null;
  const rest = m[3];

  // Try to split rest into (relations, text) at the first " · ":
  const sepIdx = rest.indexOf(" · ");
  if (sepIdx > 0) {
    const candidateRelations = rest.slice(0, sepIdx);
    const candidateText = rest.slice(sepIdx + 3);
    const rels = tryParseRelations(candidateRelations);
    if (rels !== null) {
      return { id, range, relations: rels, text: candidateText };
    }
  }
  // No relations segment — entire rest is the text.
  return { id, range, relations: [], text: rest };
}

function parseProvLine(line: string): {
  sources: ClaimSource[];
  logged: string;
  confidence: Confidence;
  seenIn: string[];
} | null {
  const m = line.match(PROV_LINE_RE);
  if (!m) return null;
  const body = m[1];
  const parts = body.split(" · ").map((p) => p.trim());

  let sources: ClaimSource[] = [];
  let logged = "";
  let confidence: Confidence = "auto";
  let seenIn: string[] = [];

  for (const part of parts) {
    if (part.startsWith("Sources:")) {
      const tail = part.slice("Sources:".length).trim();
      const links: ClaimSource[] = [];
      let lm;
      WIKILINK_RE.lastIndex = 0;
      while ((lm = WIKILINK_RE.exec(tail))) {
        const inner = lm[1];
        const pipeIdx = inner.indexOf("|");
        if (pipeIdx >= 0) {
          links.push({ path: inner.slice(0, pipeIdx), label: inner.slice(pipeIdx + 1) });
        } else {
          links.push({ path: inner });
        }
      }
      sources = links;
    } else if (part.startsWith("logged:")) {
      logged = part.slice("logged:".length).trim();
    } else if (part.startsWith("confidence:")) {
      const v = part.slice("confidence:".length).trim();
      if (isConfidence(v)) confidence = v;
    } else if (part.startsWith("seen in:")) {
      const tail = part.slice("seen in:".length).trim();
      // Strip trailing " digest" or " digests"
      const cleaned = tail.replace(/ digests?$/, "");
      seenIn = cleaned.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }

  return { sources, logged, confidence, seenIn };
}

// ── parseConcept ─────────────────────────────────────────────────────────────

export function parseConcept(md: string): ConceptNode | null {
  const fmMatch = md.match(FRONTMATTER_RE);
  if (!fmMatch) return null;
  const fmBody = fmMatch[1];
  const bodyMd = md.slice(fmMatch[0].length);

  const fm: Record<string, string> = {};
  for (const line of fmBody.split("\n")) {
    const field = parseFrontmatterField(line);
    if (field) fm[field.key] = field.value;
  }
  if (fm.type !== "concept") return null;

  const claims: ClaimEntry[] = [];
  const lines = bodyMd.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i];
    if (!headerLine.startsWith("- **")) continue;
    const header = parseClaimHeader(headerLine);
    if (!header || !header.range) continue;
    const provLine = lines[i + 1] ?? "";
    const prov = parseProvLine(provLine);
    if (!prov) continue;
    claims.push({
      id: header.id,
      range: header.range,
      relations: header.relations,
      text: header.text,
      sources: prov.sources,
      logged: prov.logged,
      confidence: prov.confidence,
      seenIn: prov.seenIn,
    });
    i++;
  }

  return {
    slug: fm.slug ?? "",
    name: unquoteYamlString(fm.name ?? ""),
    summary: unquoteYamlString(fm.summary ?? ""),
    embedding: parseEmbedding(fm.embedding ?? "[]"),
    created: fm.created ?? "",
    lastUpdated: fm.last_updated ?? "",
    claimCount: Number(fm.claim_count ?? 0),
    activeClaimCount: Number(fm.active_claim_count ?? 0),
    related: parseYamlList(fm.related ?? "[]"),
    sourceDigests: parseYamlList(fm.source_digests ?? "[]"),
    claims,
  };
}
