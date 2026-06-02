/**
 * Policy-driven renderer for the Media list "Where" column.
 */
import { MUSIC_SUBCATEGORIES } from "@/config";
import { detectPlatformFromUrl } from "@/lib/extract";
import { mountTikTokMusicPlayer } from "./inline-audio-player";
import { watchableUrl } from "./watchable-url";

export interface MediaRow {
  filePath: string;
  title: string;
  creator: string;
  type: string;
  genre: string;
  rating: string;
  where: string;
  url: string;
  spotifyId: string | null | undefined;
  tmdbId: string | null;
  tmdbType: "movie" | "tv" | null;
  anilistId: string | null;
  year: number | null;
}

const WATCHABLE_SUBCATEGORIES_RENDER = new Set([
  "films", "series", "anime", "documentaries",
]);

const MUSIC_SERVICES: Array<{
  label: string;
  match: string;
  buildUrl: (query: string) => string;
}> = [
  { label: "Spotify", match: "spotify", buildUrl: (q) => `https://open.spotify.com/search/${q}` },
  { label: "YouTube", match: "youtube", buildUrl: (q) => `https://www.youtube.com/results?search_query=${q}` },
  { label: "Apple Music", match: "apple", buildUrl: (q) => `https://music.apple.com/search?term=${q}` },
  { label: "SoundCloud", match: "soundcloud", buildUrl: (q) => `https://soundcloud.com/search?q=${q}` },
  { label: "Bandcamp", match: "bandcamp", buildUrl: (q) => `https://bandcamp.com/search?q=${q}` },
];

type SourceKind = "spotify" | "tiktok" | "x-post";
type SourceDescriptor =
  | { kind: "spotify"; trackId: string }
  | { kind: "tiktok"; videoUrl: string }
  | { kind: "x-post"; videoUrl: string }
  | null;

function isPlayableMusicRow(row: MediaRow): boolean {
  const typeNorm = row.type.toLowerCase().trim();
  if (!MUSIC_SUBCATEGORIES.has(typeNorm)) return false;
  return Boolean(row.title || row.creator);
}

function isWatchableRow(row: MediaRow): boolean {
  return WATCHABLE_SUBCATEGORIES_RENDER.has(row.type.toLowerCase().trim());
}

function musicPlayLink(row: MediaRow): { label: string; url: string } | null {
  const typeNorm = row.type.toLowerCase().trim();
  if (!MUSIC_SUBCATEGORIES.has(typeNorm)) return null;
  if (!row.title && !row.creator) return null;
  const query = encodeURIComponent([row.title, row.creator].filter(Boolean).join(" "));
  const whereNorm = (row.where || "").toLowerCase();
  const service = MUSIC_SERVICES.find((s) => whereNorm.includes(s.match))
    ?? MUSIC_SERVICES.find((s) => s.match === "youtube")!;
  return { label: service.label, url: service.buildUrl(query) };
}

function detectSource(row: MediaRow, cachedVideoUrl: string | null): SourceDescriptor {
  if (typeof row.spotifyId === "string" && row.spotifyId) {
    return { kind: "spotify", trackId: row.spotifyId };
  }
  if (cachedVideoUrl) {
    const platform = detectPlatformFromUrl(row.url);
    if (platform === "tiktok") return { kind: "tiktok", videoUrl: cachedVideoUrl };
    if (platform === "twitter") return { kind: "x-post", videoUrl: cachedVideoUrl };
  }
  return null;
}

function renderWatchableChip(cell: HTMLElement, row: MediaRow): void {
  const target = watchableUrl({
    subcategory: row.type,
    title: row.title,
    year: row.year,
    tmdbId: row.tmdbId,
    tmdbType: row.tmdbType,
    anilistId: row.anilistId,
  });
  if (!target) return;

  cell.addClass("roost-watchable-cell");
  if (row.where) {
    cell.createSpan({ cls: "roost-watchable-where", text: row.where });
    cell.createSpan({ cls: "roost-watchable-sep", text: " · " });
  }

  const isAnime = row.type.toLowerCase().trim() === "anime";
  const destLabel = isAnime ? "AniList" : "Letterboxd";

  const chip = cell.createEl("a", {
    cls: `roost-watchable-chip roost-watchable-chip--${isAnime ? "anilist" : "letterboxd"} roost-watchable-chip--${target.kind}`,
    href: target.url,
    attr: {
      target: "_blank",
      rel: "noopener noreferrer",
      title: target.kind === "search"
        ? `Search ${destLabel} for "${row.title}"`
        : `${destLabel}: ${row.title}`,
    },
  });

  if (target.kind === "search") {
    chip.createSpan({ cls: "roost-watchable-chip-icon", text: "🔍" });
    chip.createSpan({ cls: "roost-watchable-chip-label", text: `Search ${destLabel}` });
  } else {
    chip.createSpan({ cls: "roost-watchable-chip-icon", text: "▶" });
    chip.createSpan({ cls: "roost-watchable-chip-label", text: destLabel });
  }
  chip.createSpan({ cls: "roost-watchable-chip-ext", text: " ↗" });

  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.open(target.url, "_blank");
  });
}

function renderInlinePlayCell(
  cell: HTMLElement,
  row: MediaRow,
  source: NonNullable<SourceDescriptor>,
  coverUrl: string | null,
): void {
  cell.addClass("roost-inline-play-cell");

  if (source.kind === "spotify") {
    cell.addClass("roost-inline-play-cell--card");
    const iframe = cell.createEl("iframe", { cls: "roost-spotify-embed-iframe" });
    iframe.src = `https://open.spotify.com/embed/track/${source.trackId}?utm_source=roost`;
    iframe.setAttr("frameborder", "0");
    iframe.setAttr("allow", "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture");
    iframe.setAttr("loading", "lazy");
    iframe.setAttr("title", `Spotify player for "${row.title}"`);
    return;
  }

  cell.addClass("roost-inline-play-cell--card");
  mountTikTokMusicPlayer(cell, {
    videoUrl: source.videoUrl,
    title: row.title,
    creator: row.creator,
    coverUrl,
  });
}

/** Render the Where column for one media table row. */
export function renderMediaWhereCell(
  cell: HTMLElement,
  row: MediaRow,
  opts: {
    cachedVideoUrl: string | null;
    coverUrl: string | null;
  },
): void {
  const playbackSource = isPlayableMusicRow(row)
    ? detectSource(row, opts.cachedVideoUrl)
    : null;

  if (playbackSource) {
    renderInlinePlayCell(cell, row, playbackSource, opts.coverUrl);
  } else if (isPlayableMusicRow(row)) {
    const playLink = musicPlayLink(row);
    if (playLink) {
      const link = cell.createEl("a", {
        href: playLink.url,
        cls: "roost-media-list-play-link",
        text: `▶ ${playLink.label}`,
      });
      link.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(playLink.url, "_blank");
      });
    } else if (row.where) {
      cell.setText(row.where);
    } else {
      cell.createSpan({ cls: "roost-media-list-empty-cell", text: "—" });
    }
  } else if (isWatchableRow(row)) {
    renderWatchableChip(cell, row);
  } else if (row.where) {
    cell.setText(row.where);
  } else {
    cell.createSpan({ cls: "roost-media-list-empty-cell", text: "—" });
  }
}
