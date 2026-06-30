/** Platform-agnostic preview-card model. Produced by descriptor.parse.link,
 *  written to link_* frontmatter, rendered by views/link-card-renderer.ts. */
export interface LinkCard {
  /** Destination URL — where clicking the card goes. */
  url: string;
  title?: string;
  description?: string;
  /** Domain / publisher, e.g. "arxiv.org". */
  siteName?: string;
  /** Local vault path (preferred) or remote URL of the preview image. */
  image?: string;
}

/** Lowercased registrable host, scheme + leading "www." stripped. Null on junk. */
export function domainFromUrl(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** True when a note is a link bookmark (has link_url) but is still missing any
 *  preview field the OG backfill fills. link_site is derivable, so it doesn't gate. */
export function needsLinkMeta(fm: Record<string, unknown>): boolean {
  if (typeof fm.link_url !== "string" || !fm.link_url) return false;
  const missing = (k: string) => typeof fm[k] !== "string" || !(fm[k] as string);
  return missing("link_title") || missing("link_desc") || missing("link_image");
}
