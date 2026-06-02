/**
 * Gallery media URL helpers — thin bridge to feed/card-helpers.
 */
import type { App, BasesEntry } from "obsidian";
import {
  resolveImageUrl,
  resolveVideoUrl,
  hasMultipleImages,
  resolveAllImages,
} from "@/views/feed/card-helpers";
import type { EntryMediaResolvers } from "@/views/entry-to-expanded-card";
import type { GalleryCardConfig } from "@/views/gallery-cards";

export function galleryMediaResolvers(
  app: App,
  cfg: GalleryCardConfig,
): EntryMediaResolvers {
  return {
    imagePropId: cfg.imagePropId,
    resolveImageUrl: (entry, propId) => resolveImageUrl(app, entry, propId),
    resolveVideoUrl: (entry) => resolveVideoUrl(app, entry),
    resolveAllImages: (entry) => resolveAllImages(app, entry),
  };
}

export function galleryResolveImageUrl(
  app: App,
  entry: BasesEntry,
  propId: string,
): string | null {
  return resolveImageUrl(app, entry, propId);
}

export function galleryResolveVideoUrl(app: App, entry: BasesEntry): string | null {
  return resolveVideoUrl(app, entry);
}

export function galleryHasMultipleImages(app: App, entry: BasesEntry): boolean {
  return hasMultipleImages(app, entry);
}

export function galleryResolveAllImages(app: App, entry: BasesEntry): string[] {
  return resolveAllImages(app, entry);
}
