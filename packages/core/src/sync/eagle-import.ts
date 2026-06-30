/**
 * Eagle library importer — reads items directly from Eagle's on-disk storage.
 * Avoids re-downloading media that Eagle already has.
 *
 * Eagle stores items at: {libraryPath}/images/{ITEM_ID}.info/
 * Each folder contains: metadata.json + media file(s)
 */
import { Vault, requestUrl } from "obsidian";
import { getSyncFiles, parseRoostId } from "@/lib/vault-utils";
import { buildFrontmatter, ensureFolder, ensureAuthorNote } from "@/lib/vault-helpers";
import { roostIdFromUrl } from "@/lib/roost-id";
import { sanitizeFilename, detectPlatformFromUrl, buildTikTokVideoUrl } from "../lib/extract";
import * as fs from "fs";
import * as path from "path";
import type { Platform } from "@/types/sync";
import { getPlatform, PLATFORMS } from "@/platforms/registry";

interface EagleFolder {
  id: string;
  name: string;
  children?: EagleFolder[];
}

interface EagleItem {
  id: string;
  name: string;
  ext: string;
  url: string;
  website: string;
  tags: string[];
  annotation: string;
  modificationTime: number;
  folders: string[];
  isDeleted: boolean;
  width?: number;
  height?: number;
  btime?: number;
  duration?: number;
}

interface EagleImportOpts {
  vault: Vault;
  syncFolder: string;
  eagleLibraryPath: string;
  eagleToken?: string;
  onProgress?: (current: number, total: number, name: string) => void;
  onLog?: (msg: string) => void;
}

/**
 * Discover Eagle library path via the API.
 */
export async function getEagleLibraryPath(token: string): Promise<string | null> {
  try {
    const res = await requestUrl({
      url: `http://localhost:41595/api/library/info?token=${token}`,
    });
    return res.json?.data?.library?.path || null;
  } catch {
    return null;
  }
}

/**
 * Import all items from Eagle library into Obsidian vault.
 * Copies media files directly from Eagle's disk storage — no re-downloading.
 */
export async function importFromEagle(opts: EagleImportOpts): Promise<{ imported: number; skipped: number; errors: number }> {
  const { vault, syncFolder, eagleLibraryPath, onProgress, onLog } = opts;
  const imagesDir = path.join(eagleLibraryPath, "images");
  const log = onLog || (() => {});

  if (!fs.existsSync(imagesDir)) {
    log(`[FAIL] Eagle images directory not found: ${imagesDir}`);
    return { imported: 0, skipped: 0, errors: 0 };
  }

  // Scan existing roost_ids in vault for dedup
  const existingIds = new Set<string>();
  const vaultFiles = getSyncFiles(vault, syncFolder);
  for (const file of vaultFiles) {
    try {
      const content = await vault.cachedRead(file);
      const id = parseRoostId(content);
      if (id) existingIds.add(id);
    } catch { /* skip */ }
  }
  log(`Found ${existingIds.size} existing items in vault`);

  // Read Eagle's library metadata for folder names
  const folderNames = new Map<string, string>();
  try {
    const libMeta = JSON.parse(fs.readFileSync(path.join(eagleLibraryPath, "metadata.json"), "utf8")) as { folders?: EagleFolder[] };
    function walkFolders(folders: EagleFolder[], parentPath = "") {
      for (const f of folders) {
        const fp = parentPath ? `${parentPath}/${f.name}` : f.name;
        folderNames.set(f.id, fp);
        if (f.children?.length) walkFolders(f.children, fp);
      }
    }
    walkFolders(libMeta.folders || []);
  } catch (e: unknown) {
    log(`Warning: Could not read Eagle folder structure: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Scan all item folders
  const itemDirs = fs.readdirSync(imagesDir).filter(d => d.endsWith(".info"));
  log(`Found ${itemDirs.length} Eagle items`);

  const folderMemo = new Set<string>();
  const authorMemo = new Set<string>();
  let imported = 0, skipped = 0, errors = 0;

  for (let i = 0; i < itemDirs.length; i++) {
    const itemDir = itemDirs[i];
    const itemId = itemDir.replace(".info", "");
    const itemPath = path.join(imagesDir, itemDir);

    try {
      const metaPath = path.join(itemPath, "metadata.json");
      if (!fs.existsSync(metaPath)) { skipped++; continue; }

      const meta: EagleItem = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      if (meta.isDeleted) { skipped++; continue; }

      // Build roost_id from the website URL (post URL)
      const roostId = roostIdFromUrl(meta.website || meta.url || "");
      if (!roostId) { skipped++; continue; }
      if (existingIds.has(roostId)) { skipped++; continue; }

      onProgress?.(i + 1, itemDirs.length, meta.name?.slice(0, 50) || itemId);

      // Determine platform and folder
      const platform = detectPlatformFromUrl(meta.website || meta.url || "", meta.tags);
      const collection = meta.tags?.find(t => t.startsWith("collection:"))?.slice("collection:".length);
      // Flat folder structure — matches API sync (no collection subfolders)
      const platformFolder = platform in PLATFORMS
        ? getPlatform(platform as Platform).displayName
        : "Other";
      const folderPath = `${syncFolder}/${platformFolder}`;
      // Use the numeric platform ID (from roost_id) for folder name, not Eagle's internal ID.
      // This keeps attachment folders consistent with API-synced items.
      const numericId = roostId.split(":")[1];
      const attachFolder = `${folderPath}/${platform}-${numericId}`;

      // Ensure folders
      await ensureFolder(vault, folderPath, folderMemo);

      // Copy media files + thumbnail
      const mediaEmbeds: string[] = [];
      let coverPath: string | undefined;
      const files = fs.readdirSync(itemPath).filter(f => f !== "metadata.json" && !f.startsWith("."));

      // Main media file
      for (const file of files) {
        if (file.includes("_thumbnail")) continue;
        const srcPath = path.join(itemPath, file);
        const stat = fs.statSync(srcPath);
        if (!stat.isFile()) continue;
        const safeName = `media.${meta.ext || path.extname(file).slice(1) || "bin"}`;
        await ensureFolder(vault, attachFolder, folderMemo);
        const destPath = `${attachFolder}/${safeName}`;
        if (!vault.getAbstractFileByPath(destPath)) {
          try {
            const data = fs.readFileSync(srcPath);
            await vault.createBinary(destPath, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
            mediaEmbeds.push(`![[${destPath}]]`);
          } catch (e: unknown) {
            log(`Warning: Could not copy ${file}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        break;
      }

      // Copy thumbnail for video items (used as cover in cards view)
      const thumbFile = files.find(f => f.includes("_thumbnail"));
      if (thumbFile) {
        await ensureFolder(vault, attachFolder, folderMemo);
        const thumbDest = `${attachFolder}/thumb.png`;
        if (!vault.getAbstractFileByPath(thumbDest)) {
          try {
            const data = fs.readFileSync(path.join(itemPath, thumbFile));
            await vault.createBinary(thumbDest, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
          } catch { /* skip */ }
        }
        coverPath = thumbDest;
      } else {
        // For images, use the media file itself as cover
        const mediaExt = meta.ext || "";
        if (/^(jpg|jpeg|png|gif|webp)$/i.test(mediaExt)) {
          coverPath = `${attachFolder}/media.${mediaExt}`;
        }
      }

      // Create author note
      const author = extractAuthorFromMeta(meta);
      const authorLink = await ensureAuthorNote(vault, author, platform, authorMemo, folderMemo);
      const authorHandle = author.startsWith("@") ? author.slice(1) : author;

      // Construct URL from handle + ID if not available from Eagle metadata
      let itemUrl = meta.website || meta.url || "";
      if (!itemUrl && platform === "tiktok" && authorHandle && authorHandle !== "Unknown") {
        itemUrl = buildTikTokVideoUrl(authorHandle, numericId);
      }
      if (!itemUrl && platform === "instagram" && numericId) {
        // numericId here is the imported shortcode/id from tags or filename.
        itemUrl = `https://www.instagram.com/p/${numericId}/`;
      }

      // Build tags — both frontmatter and inline
      const rawTags = meta.tags?.filter(t => !t.startsWith("collection:") && t !== platform && !t.startsWith("@")) || [];
      const collectionTag = collection ? `collection/${sanitizeFilename(collection)}` : null;
      const fmTags = [platform, ...rawTags, ...(collectionTag ? [collectionTag] : [])];
      const inlineTags = [
        ...rawTags.filter(t => t.startsWith("#")).map(t => t),
        ...rawTags.filter(t => !t.startsWith("#") && t.length > 1 && t.length < 30).map(t => `#${t}`),
        ...(collectionTag ? [`#${collectionTag}`] : []),
      ].slice(0, 15);

      // coverPath was set during media copy above
      const titleText = meta.annotation?.split("\n")[0] || meta.name || "";
      // Derive published date from TikTok video ID (Snowflake-style timestamp) when possible
      let publishedDate: string | undefined;
      if (platform === "tiktok" && numericId) {
        try {
          // Use BigInt(32) instead of `32n` literal so the call doesn't
          // require ES2020 target.
          const ts = Number(BigInt(numericId) >> BigInt(32));
          if (ts > 1_400_000_000 && ts < 2_000_000_000) {
            publishedDate = new Date(ts * 1000).toISOString().split("T")[0];
          }
        } catch { /* non-numeric ID, fall through */ }
      }
      // Instagram shortcode→timestamp decoding deferred (design spec §10); IG
      // imports keep whatever published date the Eagle payload provided.
      if (!publishedDate) {
        publishedDate = meta.modificationTime ? new Date(meta.modificationTime * 1000).toISOString().split("T")[0] : undefined;
      }
      const savedDate = meta.btime ? new Date(meta.btime).toISOString().split("T")[0] : undefined;

      const fm = buildFrontmatter({
        roost_id: roostId,
        title: titleText,
        cover: coverPath ? `[[${coverPath}]]` : undefined,
        platform,
        author: authorLink,
        url: itemUrl || undefined,
        collection,
        published: publishedDate,
        saved: savedDate,
        tags: fmTags.length > 0 ? fmTags : undefined,
      });

      // Generate minimal raw.json sidecar so scanIncompleteIds doesn't flag this item
      await ensureFolder(vault, attachFolder, folderMemo);
      const minimalRaw: {
        _source: string;
        id: string;
        desc: string;
        author: { uniqueId: string; nickname: string };
        music?: { title: string; authorName: string };
        stats?: { playCount: number; diggCount: number; commentCount: number; shareCount: number; collectCount: number };
        media_type?: number;
        like_count?: number;
        comment_count?: number;
      } = {
        _source: "eagle-import",
        id: numericId,
        desc: titleText,
        author: { uniqueId: authorHandle, nickname: authorHandle },
      };
      if (platform === "tiktok") {
        minimalRaw.music = { title: "", authorName: "" };
        minimalRaw.stats = { playCount: 0, diggCount: 0, commentCount: 0, shareCount: 0, collectCount: 0 };
      } else if (platform === "instagram") {
        minimalRaw.media_type = 1;
        minimalRaw.like_count = 0;
        minimalRaw.comment_count = 0;
      }
      const rawJsonPath = `${attachFolder}/raw.json`;
      const existingRaw = vault.getAbstractFileByPath(rawJsonPath);
      if (!existingRaw) {
        await vault.create(rawJsonPath, JSON.stringify(minimalRaw, null, 2));
      }

      // Body: annotation text, media embeds, inline tags, attribution
      const bodyParts: string[] = [];
      if (meta.annotation) bodyParts.push(meta.annotation.split("\n\n")[0]);
      if (mediaEmbeds.length > 0) bodyParts.push("", ...mediaEmbeds);
      if (inlineTags.length > 0) bodyParts.push("", inlineTags.join(" "));
      if (itemUrl) bodyParts.push("", `— ${authorLink} · [Original](${itemUrl})`);

      const content = `---\n${fm}\n---\n\n${bodyParts.join("\n")}\n`;
      const filename = sanitizeFilename(`${author} - ${itemId}`) + ".md";
      const filePath = `${folderPath}/${filename}`;
      if (!vault.getAbstractFileByPath(filePath)) {
        await vault.create(filePath, content);
      }

      existingIds.add(roostId);
      imported++;
    } catch (e: unknown) {
      errors++;
      if (errors <= 5) log(`Error importing ${itemId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { imported, skipped, errors };
}

function extractAuthorFromMeta(meta: EagleItem): string {
  const authorTag = meta.tags?.find(t => t.startsWith("@"));
  if (authorTag) return authorTag;
  const match = meta.name?.match(/@(\w+)/);
  return match ? `@${match[1]}` : "Unknown";
}

