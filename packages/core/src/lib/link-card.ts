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
