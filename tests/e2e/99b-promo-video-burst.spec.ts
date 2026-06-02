/**
 * Experiment C — burst PNG sequences per scene (WDIO screenshots → ffmpeg MP4).
 *
 * Run:  npm run capture:promo:burst
 * Then: npm run promo:bursts:encode
 */

import { browser } from "@wdio/globals";
import {
  applyGalleryCategoryFilter,
  scrollGalleryCardsIntoView,
} from "./gallery-e2e-helpers";
import {
  openRoostSidebar,
  promoPause,
  replayFixtureSnapshot,
  savePromoBurst,
} from "./promo-capture-helpers";

const TIMEOUT = 20_000;

describe("Promo capture — video bursts", function () {
  this.timeout(180_000);

  before(async function () {
    await openRoostSidebar();
  });

  it("burst: Recipes gallery grid", async function () {
    await applyGalleryCategoryFilter("Recipes");
    await scrollGalleryCardsIntoView();
    await promoPause(500);
    await savePromoBurst("02-gallery-recipes-grid");
  });

  it("burst: Places map + cards", async function () {
    const places = await $(`.tree-item-self[data-category="Places"]`);
    await places.waitForExist({ timeout: TIMEOUT });
    await browser.execute((el) => (el as HTMLElement).click(), places);
    await promoPause(2_500);
    await $(".roost-places-map").waitForDisplayed({ timeout: TIMEOUT });
    await savePromoBurst("04-places-map-grid");
  });

  it("burst: Smart Assign staging", async function () {
    await replayFixtureSnapshot();
    await savePromoBurst("06-smart-assign-staging");
  });
});
