/**
 * PlatformDescriptor — the single source of truth for a sync platform's
 * config, webview bootstrap, sync function, and per-field parsers.
 *
 * Dependency direction: descriptor modules import leaf functions (sync
 * impls, extract.ts). The leaves must NOT import the registry. Consumers
 * are migrated in later tasks; nothing in the existing codebase is changed.
 */
import type { Platform, ElectronWebview, StopSignal, SyncPhaseProgress } from "@/types/sync";
import type { NormalizedRecord } from "@/lib/normalize";
import type { BookmarkRecord, extractTwitterMedia } from "@/lib/twitter-helpers";
import type { extractTikTokMedia } from "@/lib/tiktok-helpers";

/** Convenience aliases for the per-platform media shapes. */
export type TikTokMedia = ReturnType<typeof extractTikTokMedia>;
export type TwitterMedia = ReturnType<typeof extractTwitterMedia>;

/**
 * Per-platform bookmark field extractors — thin wrappers over the existing
 * lib/extract.ts functions. Later tasks will inline the logic here and
 * flip consumers to call parse.* instead of calling extract.ts directly.
 */
export interface PlatformParser {
  /** Platform-namespaced bookmark ID (e.g. "tiktok:123"). */
  id(record: BookmarkRecord): string | null;
  /** Primary text body (video description / tweet text / article body). */
  caption(record: BookmarkRecord): string;
  /** Display name of the content author. */
  authorName(record: BookmarkRecord): string;
  /** @-handle / screen_name of the content author. */
  authorHandle(record: BookmarkRecord): string | null;
  /** Canonical URL for the bookmark. */
  url(record: BookmarkRecord): string | null;
  /** Platform-specific media payload (photos/video for Twitter; images/video for TikTok). */
  media(record: BookmarkRecord): TikTokMedia | TwitterMedia;
  /** Best subtitle track URL (TikTok only — undefined for Twitter). */
  subtitleUrl?(record: BookmarkRecord): string | null;
}

/**
 * Common sync function shape.  Both syncTikTok and syncTwitter conform to
 * this via thin wrappers in tiktok.ts / twitter.ts.  The opts superset
 * covers all per-platform options; each impl ignores fields it doesn't use.
 */
export type SyncFn = (
  wc: ElectronWebview,
  webviewEl: ElectronWebview,
  opts: {
    stopSignal?: StopSignal;
    maxItems?: number;
    hydrateCachedThread?: (record: NormalizedRecord) => Promise<boolean>;
    fastSyncMode?: boolean;
    maxScrollTime?: number;
  },
  onProgress?: (p: SyncPhaseProgress) => void,
  onRecords?: (records: NormalizedRecord[]) => Promise<void>,
  onLog?: (msg: string) => void,
) => Promise<unknown>;

/**
 * A complete platform descriptor.  Config values are copied verbatim from
 * webview-manager.ts, config.ts, and platform-card.tsx.  sync and parse
 * delegate to the existing leaf functions; later tasks migrate consumers
 * to read these fields and move the source of truth inside the descriptor.
 */
export interface PlatformDescriptor {
  /** Canonical platform key used in vault IDs and settings (matches Platform). */
  id: Platform;
  /** Hub card identifier.  "tiktok" for TikTok, "x" for Twitter. */
  hubId: string;
  /** Human-readable name shown in UI (e.g. "TikTok", "X"). */
  displayName: string;
  /** Hub card copy. */
  card: {
    title: string;
    eduCopy: string;
  };
  /** Base origin URL used for cookie probing and webview reloads. */
  origin: string;
  /** URL loaded when the platform webview is first created. */
  profileUrl: string;
  /** httpOnly auth cookie names whose presence signals a live session. */
  authCookies: string[];
  /** Whether this platform is enabled and shown in the hub. */
  enabled: boolean;
  /** Raw probe script source (injected into the platform webview). */
  probeSource: string;
  /** Sync function — drives the webview scroll + record stream. */
  sync: SyncFn;
  /** Field-level parsers over raw API data. */
  parse: PlatformParser;
}
