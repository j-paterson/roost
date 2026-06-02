/**
 * Marketing / social screenshots — fixture vault only, no network.
 *
 * Run:  npm run capture:promo
 * Slow: npm run capture:promo:slow   (longer pauses for screen recording)
 *
 * PNGs → docs/promo/screenshots/
 */

import { browser } from "@wdio/globals";
import {
  applyGalleryCategoryFilter,
  scrollGalleryCardsIntoView,
  waitForMediaFeedSplit,
} from "./gallery-e2e-helpers";
import {
  openExplorerBase,
  waitForExplorerGrid,
} from "./explorer-e2e-helpers";
import {
  openRoostSidebar,
  promoPause,
  replayFixtureSnapshot,
  savePromoElement,
  savePromoShot,
} from "./promo-capture-helpers";

const TIMEOUT = 20_000;

describe("Promo capture — social assets", function () {
  this.timeout(180_000);

  before(async function () {
    await openRoostSidebar();
    await savePromoShot("01-sidebar-library");
    await savePromoElement(".roost-root", "01b-sidebar-crop");
  });

  it("02 gallery — Recipes chips + grid", async function () {
    await applyGalleryCategoryFilter("Recipes");
    await scrollGalleryCardsIntoView();
    await promoPause(600);
    await savePromoShot("02-gallery-recipes-grid");
    await savePromoElement(".workspace-leaf.mod-active", "02b-gallery-leaf");
  });

  it("03 gallery — Recipes expanded card", async function () {
    await applyGalleryCategoryFilter("Recipes");
    const card = await $('.roost-card[data-roost-id="bm_0"]');
    await card.waitForDisplayed({ timeout: TIMEOUT });
    await browser.execute((el) => (el as HTMLElement).click(), card);
    await promoPause(800);
    await savePromoShot("03-gallery-recipes-expanded");
  });

  it("04 gallery — Places map + cards", async function () {
    const places = await $(`.tree-item-self[data-category="Places"]`);
    await places.waitForExist({ timeout: TIMEOUT });
    await browser.execute((el) => (el as HTMLElement).click(), places);
    await promoPause(2_500);
    const map = await $(".roost-places-map");
    await map.waitForDisplayed({ timeout: TIMEOUT });
    await savePromoShot("04-places-map-grid");
  });

  it("05 gallery — Media list + feed split", async function () {
    await waitForMediaFeedSplit();
    await promoPause(1_000);
    await savePromoShot("05-media-feed-split");
  });

  it("06 Smart Assign — staging tree (replay snapshot)", async function () {
    await replayFixtureSnapshot();
    await savePromoShot("06-smart-assign-staging");
    await savePromoElement(".nav-folder-children", "06b-staging-tree");
  });

  it("07 Explorer — file grid", async function () {
    await openExplorerBase();
    await waitForExplorerGrid(5);
    await promoPause(800);
    await savePromoShot("07-explorer-grid");
  });

  it("08 Roost Hub — operations dashboard", async function () {
    await browser.executeObsidianCommand("roost:open-hub");
    await promoPause(2_000);
    const hub = await $(".roost-hub-body");
    const hubVisible = await hub.isDisplayed().catch(() => false);
    if (hubVisible) {
      await savePromoShot("08-roost-hub");
    } else {
      await savePromoShot("08-roost-hub-fallback-window");
    }
  });

  after(async function () {
    console.log("\nPromo PNGs written to docs/promo/screenshots/\n");
    await promoPause(3_000);
  });
});
