/**
 * Media list view E2E — substitute table + gallery feed pane.
 *
 * Fixtures: bm_11–bm_13 media fields in tests/fixtures/build-fixture-vault.mjs
 */

import { browser, expect } from "@wdio/globals";
import {
  applyGalleryCategoryFilter,
  clickMediaListTitle,
  waitForMediaFeedSplit,
} from "./gallery-e2e-helpers";

const FIND_TIMEOUT = 15_000;

async function openRoost(): Promise<void> {
  await browser.executeObsidianCommand("roost:open");
  const sidebar = await $(".roost-root");
  await sidebar.waitForDisplayed({ timeout: 30_000 });
  await browser.pause(1500);
}

describe("Media list view — substitute table + feed pane detail", function () {
  before(async function () {
    await openRoost();
    const mediaRow = await $(`.tree-item-self[data-category="Media"]`);
    await mediaRow.waitForExist({ timeout: FIND_TIMEOUT });
  });

  it("renders feed split with media table in the left pane", async function () {
    await waitForMediaFeedSplit();
  });

  it("renders one row per media-enriched fixture with the expected columns", async function () {
    await waitForMediaFeedSplit();
    const headerTexts = await browser.executeObsidian(() =>
      [...document.querySelectorAll("thead .roost-media-list-header")].map(
        (th) => (th.textContent ?? "").replace(/[▲▼]\s*/g, "").trim(),
      ),
    );
    expect(headerTexts).toEqual([
      "Title", "Creator", "Type", "Genre", "Rating", "Where",
    ]);

    const rows = await $$(".roost-media-list-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const rowTitles = await browser.executeObsidian(() =>
      [...document.querySelectorAll(".roost-media-list-title")].map(
        (el) => (el.textContent ?? "").trim().toLowerCase(),
      ),
    );
    expect(rowTitles.some((t) => t.includes("phoebe bridgers"))).toBe(true);
    expect(rowTitles.some((t) => t.includes("mr brightside"))).toBe(true);
  });

  it("clicking a row shows expanded card in the feed pane (no note navigation)", async function () {
    await waitForMediaFeedSplit();
    const leafPathBefore = await browser.executeObsidian(({ app }) => {
      const file = app.workspace.getActiveFile();
      return file?.path ?? null;
    });

    await clickMediaListTitle("Phoebe Bridgers");

    await browser.waitUntil(
      async () => {
        const text = await browser.executeObsidian(() =>
          document.querySelector(".roost-feed-pane-right")?.textContent ?? "",
        );
        return (text as string).toLowerCase().includes("phoebe bridgers");
      },
      { timeout: FIND_TIMEOUT, timeoutMsg: "feed pane did not show Phoebe Bridgers detail" },
    );

    const selectedHasTitle = await browser.executeObsidian(() => {
      const row = document.querySelector(".roost-media-list-row.is-selected");
      return row?.textContent?.toLowerCase().includes("phoebe bridgers") ?? false;
    });
    expect(selectedHasTitle).toBe(true);

    const leafPathAfter = await browser.executeObsidian(({ app }) => {
      const file = app.workspace.getActiveFile();
      return file?.path ?? null;
    });
    expect(leafPathAfter).toBe(leafPathBefore);
  });

  it("clicking a different row swaps the feed-pane detail", async function () {
    await waitForMediaFeedSplit();
    await clickMediaListTitle("Mr Brightside");

    await browser.waitUntil(
      async () => {
        const text = await browser.executeObsidian(() =>
          document.querySelector(".roost-feed-pane-right")?.textContent ?? "",
        );
        return (text as string).toLowerCase().includes("mr brightside");
      },
      { timeout: FIND_TIMEOUT, timeoutMsg: "feed pane did not show Mr Brightside detail" },
    );

    const selectedCount = await browser.executeObsidian(() =>
      document.querySelectorAll(".roost-media-list-row.is-selected").length,
    );
    expect(selectedCount).toBe(1);
    const selectedHasTitle = await browser.executeObsidian(() => {
      const row = document.querySelector(".roost-media-list-row.is-selected");
      return row?.textContent?.toLowerCase().includes("mr brightside") ?? false;
    });
    expect(selectedHasTitle).toBe(true);
  });

  it("renders feed divider + column resize handles", async function () {
    const stillMedia = await $$(".roost-feed-host");
    if (stillMedia.length === 0) {
      await waitForMediaFeedSplit();
    }

    const divider = await $(".roost-feed-divider");
    await divider.waitForExist({ timeout: FIND_TIMEOUT });

    const handles = await $$(".roost-media-list-resize-handle");
    expect(handles.length).toBe(6);
  });

  it("dragging the feed pane divider resizes the left pane", async function () {
    const left = await $(".roost-feed-pane-left");
    const widthBefore = await browser.execute(
      (el) => (el as HTMLElement).getBoundingClientRect().width, left,
    );

    await browser.execute(() => {
      const divider = document.querySelector(".roost-feed-divider") as HTMLElement;
      const rect = divider.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      divider.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0,
      }));
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: startX + 150, clientY: startY, button: 0,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, cancelable: true, clientX: startX + 150, clientY: startY, button: 0,
      }));
    });

    const widthAfter = await browser.execute(
      (el) => (el as HTMLElement).getBoundingClientRect().width, left,
    );
    expect(widthAfter).toBeGreaterThan(widthBefore + 50);
  });

  it("dragging a column resize handle widens the column", async function () {
    const titleHeader = await $(".roost-media-list-header");
    const widthBefore = await browser.execute(
      (el) => (el as HTMLElement).getBoundingClientRect().width, titleHeader,
    );

    await browser.execute(() => {
      const handles = document.querySelectorAll(".roost-media-list-resize-handle");
      const handle = handles[0] as HTMLElement;
      const rect = handle.getBoundingClientRect();
      const startX = rect.left + rect.width / 2;
      const startY = rect.top + rect.height / 2;
      handle.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, clientX: startX, clientY: startY, button: 0,
      }));
      document.dispatchEvent(new MouseEvent("mousemove", {
        bubbles: true, cancelable: true, clientX: startX + 120, clientY: startY, button: 0,
      }));
      document.dispatchEvent(new MouseEvent("mouseup", {
        bubbles: true, cancelable: true, clientX: startX + 120, clientY: startY, button: 0,
      }));
    });

    const widthAfter = await browser.execute(
      (el) => (el as HTMLElement).getBoundingClientRect().width, titleHeader,
    );
    expect(widthAfter).toBeGreaterThan(widthBefore + 50);
  });

  it("music rows with a Spotify track ID render an embed iframe", async function () {
    await waitForMediaFeedSplit();
    await clickMediaListTitle("Wake Me Up When September Ends");

    const iframe = await $(".roost-spotify-embed-iframe");
    await iframe.waitForDisplayed({ timeout: FIND_TIMEOUT });

    const src = await iframe.getAttribute("src");
    expect(src).toContain("open.spotify.com/embed/track/");
  });

  it("non-music rows do not render a play affordance", async function () {
    const hasPlay = await browser.executeObsidian(() => {
      const cells = [...document.querySelectorAll(".roost-media-list-title")];
      const row = cells.find(c => c.textContent?.includes("Phoebe Bridgers"));
      if (!row) return null;
      const tr = row.closest("tr");
      return tr ? tr.querySelectorAll(".roost-media-list-play-link").length : null;
    });
    expect(hasPlay).toBe(0);
  });

  it("filtering away from Media tears down the table and feed split", async function () {
    await browser.executeObsidian(async ({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugin = (app as any).plugins.plugins["roost"];
      await plugin.openBookmarksBase();
      plugin.setFilter(null);
    });
    await browser.pause(500);
    const hostStill = await $$(".roost-bases-grid.roost-media-list-host");
    expect(hostStill.length).toBe(0);
    const feedStill = await $$(".roost-feed-host");
    expect(feedStill.length).toBe(0);
  });
});
