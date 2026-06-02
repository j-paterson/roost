/**
 * Shared E2E helpers for gallery / bookmarks Bases view tests.
 */
import { browser } from "@wdio/globals";

export const GALLERY_OPEN_TIMEOUT = 30_000;

/** Apply a category filter without toggling off when the tree item is already active. */
export async function applyGalleryCategoryFilter(category: string): Promise<void> {
  await browser.executeObsidian(async ({ app }, cat: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["roost"] as {
      openBookmarksBase(): Promise<void>;
      setFilter(filter: { category: string }): void;
    } | undefined;
    if (!plugin?.openBookmarksBase || !plugin.setFilter) {
      throw new Error("roost plugin not loaded");
    }
    await plugin.openBookmarksBase();
    plugin.setFilter({ category: cat });
  }, category);
  await waitForGallerySurface();
}

/** Wait until the bookmarks Bases grid (or Media substitute table) is in the DOM. */
export async function waitForGallerySurface(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const n = await browser.executeObsidian(() => {
        const grid = document.querySelector(".roost-bases-grid");
        if (!grid) return 0;
        return (
          grid.querySelectorAll(".roost-card").length +
          (grid.querySelector(".roost-media-list-table") ? 1 : 0)
        );
      });
      return (n as number) > 0;
    },
    {
      timeout: GALLERY_OPEN_TIMEOUT,
      timeoutMsg: "gallery grid did not mount after category filter",
    },
  );
}

/** Media list + feed split: left table and right feed scroller. */
export async function waitForMediaFeedSplit(): Promise<void> {
  await applyGalleryCategoryFilter("Media");
  await browser.waitUntil(
    async () => {
      const ready = await browser.executeObsidian(() => {
        const tableRows = document.querySelectorAll(
          ".roost-media-list-table tbody .roost-media-list-row",
        ).length;
        const feedScroller = document.querySelector(
          ".roost-feed-pane-right.roost-feed-scroller",
        );
        const titles = [...document.querySelectorAll(".roost-media-list-title")].map(
          (el) => (el.textContent ?? "").trim(),
        );
        return tableRows >= 2 && feedScroller != null && titles.length >= 2;
      });
      return ready as boolean;
    },
    {
      timeout: GALLERY_OPEN_TIMEOUT,
      timeoutMsg: "media feed split or table did not mount",
    },
  );
}

export async function scrollGalleryCardsIntoView(): Promise<void> {
  await browser.executeObsidian(() => {
    const grid = document.querySelector(".roost-bases-grid");
    const scroll = grid?.parentElement;
    if (scroll) scroll.scrollTop = 0;
    grid?.querySelectorAll(".roost-card").forEach(el => {
      el.scrollIntoView({ block: "center" });
    });
  });
  await browser.pause(400);
}

/** Click a media list row by title text (CSS has no *= operator). */
export async function clickMediaListTitle(titleSubstring: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const found = await browser.executeObsidian((_ctx, search: string) => {
        const cells = [...document.querySelectorAll(".roost-media-list-title")];
        return cells.some((c) => c.textContent?.includes(search));
      }, titleSubstring);
      return found as boolean;
    },
    {
      timeout: GALLERY_OPEN_TIMEOUT,
      timeoutMsg: `media list title not ready: ${titleSubstring}`,
    },
  );

  const clicked = await browser.executeObsidian((_ctx, search: string) => {
    const row = [...document.querySelectorAll(".roost-media-list-row")].find((r) =>
      r.textContent?.includes(search),
    );
    if (!row) return false;
    (row as HTMLElement).click();
    return true;
  }, titleSubstring);
  if (!clicked) {
    throw new Error(`media list row not found: ${titleSubstring}`);
  }
}
