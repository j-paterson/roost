import fs from "fs";
import path from "path";
import { VAULT_PATH, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP_TOKENS, CHARS_PER_TOKEN } from "./config";
import type { Chunk, ParsedFile } from "./types";

const TARGET_CHARS = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

/** Parse frontmatter from markdown content */
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  if (!content.startsWith("---")) return { frontmatter: {}, body: content };
  const end = content.indexOf("---", 3);
  if (end === -1) return { frontmatter: {}, body: content };

  const fmStr = content.slice(3, end);
  const body = content.slice(end + 3).trim();

  // Simple YAML parser (handles key: value, key: "value", arrays)
  const fm: Record<string, any> = {};
  const lines = fmStr.split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.replace(/\ufeff/g, "").trim();
    if (!trimmed) continue;

    // Array item
    if (trimmed.startsWith("- ") && currentKey) {
      if (!currentArray) currentArray = [];
      currentArray.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush previous array
    if (currentArray && currentKey) {
      fm[currentKey] = currentArray;
      currentArray = null;
    }

    // Key: value
    const m = trimmed.match(/^([^:]+?):\s*(.*)/);
    if (m) {
      currentKey = m[1].trim();
      let val = m[2].trim();
      if (val) {
        // Strip quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        fm[currentKey] = val;
        currentKey = null;
      }
      // else: value on next lines (array)
    }
  }
  if (currentArray && currentKey) {
    fm[currentKey] = currentArray;
  }

  return { frontmatter: fm, body };
}

/** Strip dataview/tasks/button code blocks */
function stripSpecialBlocks(text: string): string {
  return text.replace(/```(?:dataview|tasks|button)\n[\s\S]*?```/g, "");
}

/** Split text by markdown headings (H1-H3) */
function splitByHeadings(text: string): { heading: string | null; content: string }[] {
  const sections: { heading: string | null; content: string }[] = [];
  const lines = text.split("\n");
  let currentHeading: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
      }
      currentHeading = headingMatch[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  // Flush last section
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, content: currentLines.join("\n").trim() });
  }

  return sections;
}

/** Recursively split text at paragraph boundaries */
function recursiveSplit(text: string, heading: string | null): { heading: string | null; content: string }[] {
  if (text.length <= TARGET_CHARS) {
    return [{ heading, content: text }];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: { heading: string | null; content: string }[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length > TARGET_CHARS && current.length > 0) {
      chunks.push({ heading, content: current.trim() });
      // Overlap: keep last bit
      const overlapStart = Math.max(0, current.length - OVERLAP_CHARS);
      current = current.slice(overlapStart) + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) {
    chunks.push({ heading, content: current.trim() });
  }

  return chunks;
}

/** Parse and chunk a markdown file */
/**
 * Frontmatter fields whose string values carry semantic search signal.
 * Critical for bookmark-style files (TikTok, X) where the actual transcript /
 * description / URL lives in YAML, not the body. Notes typically don't set
 * these fields, so they're a no-op for the rest of the vault.
 */
const SEARCHABLE_FRONTMATTER_FIELDS = [
  "subtitle",       // TikTok transcript / video description
  "description",    // generic
  "url",            // for finding specific bookmarks
  "sound",          // TikTok sound name
  "author",         // wikilinks de-bracketed
  "roost_category", // user-curated category
  "platform",       // tiktok / twitter / etc.
];

export function frontmatterToSearchableText(fm: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const field of SEARCHABLE_FRONTMATTER_FIELDS) {
    const v = fm[field];
    if (typeof v === "string" && v.trim()) {
      // Strip wikilink brackets so e.g. `[[People/@foo]]` becomes `People/@foo` for tokenization.
      lines.push(v.replace(/\[\[([^\]]+)\]\]/g, "$1").trim());
    }
  }
  return lines.join("\n");
}

export function chunkFile(relPath: string): ParsedFile {
  const fullPath = path.join(VAULT_PATH, relPath);
  const raw = fs.readFileSync(fullPath, "utf-8");
  const stat = fs.statSync(fullPath);

  const { frontmatter, body } = parseFrontmatter(raw);
  const title = frontmatter.title || path.basename(relPath, ".md");
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];

  // Build context prefix
  const contextParts = [`Title: ${title}`, `Path: ${relPath}`];
  if (tags.length > 0) contextParts.push(`Tags: ${tags.join(", ")}`);
  const contextPrefix = contextParts.join(" | ");

  // Pull semantic frontmatter fields into the chunked text so bookmark-style
  // files (TikTok subtitles, etc.) are actually findable.
  const fmText = frontmatterToSearchableText(frontmatter);
  const bodyWithFm = fmText ? `${body}\n\n${fmText}` : body;

  // Strip special blocks
  const cleaned = stripSpecialBlocks(bodyWithFm);

  // If entire content is short, single chunk
  if (cleaned.length <= TARGET_CHARS) {
    const content = `${contextPrefix}\n\n${cleaned}`;
    return {
      path: relPath,
      title,
      tags,
      frontmatter,
      mtime_ms: Math.floor(stat.mtimeMs),
      chunks: [{
        chunkIndex: 0,
        heading: null,
        content,
        tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      }],
    };
  }

  // Split by headings, then recursive within sections
  const sections = splitByHeadings(cleaned);
  const rawChunks: { heading: string | null; content: string }[] = [];

  for (const section of sections) {
    if (!section.content.trim()) continue;
    if (section.content.length <= TARGET_CHARS) {
      rawChunks.push(section);
    } else {
      rawChunks.push(...recursiveSplit(section.content, section.heading));
    }
  }

  // Prepend context to first chunk
  const chunks: Chunk[] = rawChunks
    .filter(c => c.content.trim().length > 20) // skip very short chunks
    .map((c, i) => {
      const content = i === 0 ? `${contextPrefix}\n\n${c.content}` : c.content;
      return {
        chunkIndex: i,
        heading: c.heading,
        content,
        tokenCount: Math.ceil(content.length / CHARS_PER_TOKEN),
      };
    });

  return {
    path: relPath,
    title,
    tags,
    frontmatter,
    mtime_ms: Math.floor(stat.mtimeMs),
    chunks,
  };
}
