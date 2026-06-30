/**
 * One-shot backfill: walk all markdown files in platform sync folders, find
 * link bookmarks (notes with link_url) missing OG preview fields (link_title,
 * link_desc, link_image), and fetch Open Graph metadata to fill the gaps.
 *
 * Resumable via .roost/link-meta-cache.json — successful fetches are persisted
 * so a re-run skips them. Per-item try/catch ensures one failure never aborts
 * the batch.
 *
 * Mirrors media-backfill structure: walk platform folders, queue construction,
 * per-item write resilience, periodic cache flush, Notice summary.
 *
 * Triggered from the Obsidian command palette: "Backfill link previews".
 */
import * as fs from "fs";
import * as path from "path";
import { Notice, requestUrl, TFile } from "obsidian";
import { vaultBasePath } from "@/lib/vault-utils";
import { cacheDir } from "@/lib/roost-paths";
import type { IRoostPlugin } from "@/types/plugin";
import type { EnrichmentDef, BackfillOpts } from "@/lib/enrichments";
import type { Platform } from "@/types/sync";
import { getPlatform, platformFolders } from "@/platforms/registry";
import { fetchOgMetadata } from "@/sync/cover-fetcher";
import type { OgMetadata } from "@/sync/cover-fetcher";

interface LinkMetaCacheEntry {
  ok: boolean;
  reason?: string;
  fetchedAt: number; // unix seconds
}
type LinkMetaCache = Record<string, LinkMetaCacheEntry>;

let backfillRunning = false;

/** Mirror of vault-index.needsLinkMeta — inlined here to avoid the circular
 *  enrichments → link-meta-backfill → vault-index → enrichments import cycle.
 *  A link bookmark (has link_url) still missing any OG preview field. */
function needsLinkMeta(fm: Record<string, unknown>): boolean {
  if (typeof fm.link_url !== "string" || !fm.link_url) return false;
  const missing = (k: string) => typeof fm[k] !== "string" || !(fm[k] as string);
  return missing("link_title") || missing("link_desc") || missing("link_image");
}

/** Compute the frontmatter patch for one link from fetched OG metadata.
 *  Returns existing fm values for fields already set, and fills missing fields
 *  from og metadata (never overwrites a non-empty existing value). Returns the
 *  fields to set; link_image_remote (when set) tells runBackfill to download
 *  that URL into the attach folder and store the vault path as link_image.
 *  link_image itself is never in the returned patch — runBackfill sets it after
 *  downloading (or falls back to the remote URL). */
export function mergeLinkMeta(
  fm: Record<string, unknown>,
  og: OgMetadata,
): Record<string, string | undefined> {
  const get = (k: string): string | undefined => {
    const v = fm[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
  const patch: Record<string, string | undefined> = {};
  // Preserve existing value, or fill from og if missing
  patch.link_title = get("link_title") ?? (og.title ?? undefined);
  patch.link_desc  = get("link_desc")  ?? (og.description ?? undefined);
  patch.link_site  = get("link_site")  ?? (og.siteName ?? undefined);
  // Image is handled specially: signal download via link_image_remote
  if (!get("link_image") && og.image) patch.link_image_remote = og.image;
  return patch;
}

export async function runLinkMetaBackfill(plugin: IRoostPlugin, _opts?: BackfillOpts): Promise<void> {
  if (backfillRunning) {
    new Notice("Link preview backfill is already running.");
    return;
  }
  backfillRunning = true;
  try {
    const log = (msg: string) => { plugin.fireLog("[link-meta-backfill] " + msg); };

    const app = plugin.app;
    const vaultRoot = vaultBasePath(app.vault);
    if (!vaultRoot) { new Notice("Link preview backfill failed: cannot locate vault path."); return; }

    const roostDir = cacheDir(vaultRoot);
    fs.mkdirSync(roostDir, { recursive: true });
    const cachePath = path.join(roostDir, "link-meta-cache.json");

    const cache: LinkMetaCache = (() => {
      try { return JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch { return {}; }
    })();
    const now = Math.floor(Date.now() / 1000);

    // Collect all platform folders (e.g. "X", "TikTok", "Instagram", "Reddit")
    const platformFolderSet = new Set(platformFolders());
    const syncFolder = plugin.settings.syncFolder;

    // Walk all markdown files in the vault, filter to platform sync folders,
    // and select notes where needsLinkMeta returns true.
    const queue: TFile[] = [];
    let cacheHits = 0;
    let alreadyComplete = 0;

    const allFiles = app.vault.getMarkdownFiles();
    for (const file of allFiles) {
      // Must start with <syncFolder>/
      if (!file.path.startsWith(syncFolder + "/")) continue;

      // Second segment must be a known platform folder
      const relPath = file.path.substring(syncFolder.length + 1);
      const slashIdx = relPath.indexOf("/");
      if (slashIdx < 0) continue; // file directly in syncFolder, not in a platform subfolder
      const platformFolder = relPath.substring(0, slashIdx);
      if (!platformFolderSet.has(platformFolder)) continue;

      const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;

      // Only process notes that have a roost_id (genuine Roost bookmarks)
      if (typeof fm.roost_id !== "string") continue;

      if (!needsLinkMeta(fm)) {
        alreadyComplete++;
        continue;
      }

      // Resumable cache hit
      if (cache[fm.roost_id as string]?.ok) {
        cacheHits++;
        continue;
      }

      queue.push(file);
    }

    if (queue.length === 0) {
      new Notice(
        `No link previews to backfill (${alreadyComplete} already complete, ${cacheHits} cache hits).`,
      );
      return;
    }

    log(`Queue: ${queue.length} notes need link preview metadata (${alreadyComplete} complete, ${cacheHits} cache hits)`);
    new Notice(`Backfilling ${queue.length} link previews…`);

    let succeeded = 0, failed = 0;
    const failReasons: Record<string, number> = {};

    for (let i = 0; i < queue.length; i++) {
      const file = queue[i];
      // Re-read frontmatter — it may have changed since we built the queue
      const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      if (!fm) continue;

      const roostId = fm.roost_id as string;
      const linkUrl = fm.link_url;
      if (typeof linkUrl !== "string" || !linkUrl) continue;

      try {
        const og = await fetchOgMetadata(linkUrl);
        const patch = mergeLinkMeta(fm, og);

        // Handle image: try to download into the note's attach folder. If the
        // download fails for any reason, fall back to storing the remote URL
        // directly in link_image (Task 9's renderer handles both vault wikilinks
        // and https URLs).
        if (patch.link_image_remote) {
          const imageUrl = patch.link_image_remote;
          const colonIdx = roostId.indexOf(":");
          if (colonIdx > 0) {
            const platformId = roostId.substring(0, colonIdx) as Platform;
            const itemId = roostId.substring(colonIdx + 1);
            try {
              const platformVault = getPlatform(platformId).vault;
              if (platformVault) {
                // Derive attach folder from the note's parent directory
                const dir = file.path.replace(/\/[^/]+\.md$/, "");
                const attachFolderVaultPath = `${dir}/${platformVault.attachPrefix}-${itemId}`;
                const ext = imageUrl.match(/\.(jpe?g|png|webp|gif)/i)?.[1] ?? "jpg";
                const imgFileName = `og-image.${ext}`;
                const imgVaultPath = `${attachFolderVaultPath}/${imgFileName}`;

                // Ensure attach folder exists on the filesystem
                const attachFsFull = path.join(vaultRoot, attachFolderVaultPath);
                fs.mkdirSync(attachFsFull, { recursive: true });

                const imgResp = await requestUrl({ url: imageUrl });
                const existing = app.vault.getAbstractFileByPath(imgVaultPath);
                if (!existing) {
                  await app.vault.createBinary(imgVaultPath, imgResp.arrayBuffer);
                }
                patch.link_image = `[[${imgVaultPath}]]`;
              } else {
                // Platform has no vault config — store remote URL
                patch.link_image = imageUrl;
              }
            } catch {
              // Download failed — store remote URL directly (renderer handles it)
              patch.link_image = imageUrl;
            }
          } else {
            // Malformed roost_id — store remote URL
            patch.link_image = imageUrl;
          }
          // Clear the ephemeral signal regardless of which path was taken
          patch.link_image_remote = undefined;
        }

        // Write only if the patch has at least one non-undefined value
        const hasPatch = Object.values(patch).some(v => v !== undefined);
        if (hasPatch) {
          await app.fileManager.processFrontMatter(file, (existingFm) => {
            for (const [k, v] of Object.entries(patch)) {
              if (v !== undefined) existingFm[k] = v;
            }
          });
        }

        cache[roostId] = { ok: true, fetchedAt: now };
        succeeded++;
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message.slice(0, 80) : "error";
        cache[roostId] = { ok: false, reason, fetchedAt: now };
        failReasons["exception"] = (failReasons["exception"] ?? 0) + 1;
        failed++;
        log(`Failed for ${roostId}: ${e instanceof Error ? e.message : String(e)}`);
      }

      // Periodic cache flush + progress log
      if ((i + 1) % 10 === 0 || i + 1 === queue.length) {
        log(`Progress: ${i + 1}/${queue.length} (${succeeded} ok, ${failed} failed)`);
        try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); } catch { /* best-effort */ }
      }
    }

    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    const breakdown = Object.entries(failReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${reason}`)
      .join(", ");
    const summary = `Link preview backfill: ${succeeded} succeeded, ${failed} failed${breakdown ? ` — ${breakdown}` : ""}`;
    log(summary);
    new Notice(summary);
  } finally {
    backfillRunning = false;
  }
}

export const LINK_META_ENRICHMENT: EnrichmentDef = {
  id: "linkMeta",
  displayName: "Link previews",
  schemaVersion: 1,
  commandId: "backfill-link-previews",
  commandName: "Backfill link previews",
  runBackfill: runLinkMetaBackfill,
  panelDetail: "Link bookmarks missing preview metadata (title/description/image). Backfill fetches Open Graph tags.",
  fieldsWritten: ["link_title", "link_desc", "link_site", "link_image"],
};
