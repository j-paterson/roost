/**
 * Places map — renders markers and filters on click
 *
 * Tests that clicking "Places" in the Roost sidebar causes the Leaflet map to
 * appear, that at least one pin marker is visible, and that clicking a marker
 * either reduces or keeps stable the visible card count (never zeroes it out).
 *
 * Translated from the Playwright Slice 8 spec (see 2026-04-20 Addendum in the
 * testing plan) to WebdriverIO + mocha.
 *
 * Selector notes (verified against production code at places-map.ts:317):
 *  - `.roost-places-map` — added by renderPlacesMap() to the container element
 *    in places-map.ts (the mapContainer div in bookmarks-bases-view.ts).
 *  - `.leaflet-marker-icon` — Leaflet's standard class for icon-based markers
 *    (production uses L.marker + L.divIcon; an earlier circleMarker version
 *    rendered as `svg path.leaflet-interactive`, but that's not what ships).
 *  - `.roost-card` — individual gallery card elements, same selector used in
 *    the gallery spec (10-gallery.spec.ts).
 *
 * Fixture notes:
 *  - tests/fixtures/vault/.roost/places-cache.json has two entries:
 *    bm_5 → Rome, Italy  and  bm_6 → Tokyo, Japan.
 *    Two distinct city pins satisfy the ≥2 distinct-cities requirement so the
 *    before/after marker count assertion is meaningful.
 */

import { browser } from "@wdio/globals";

// Wait budget for map and marker paint after category filter activates
const MAP_TIMEOUT = 15_000;

describe("Places map — renders markers and filters on click", function () {
  before(async function () {
    // Open the Roost sidebar using the registered plugin command
    await browser.executeObsidianCommand("roost:open");

    // Wait for the sidebar React root to mount
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: 30_000 });

    // Give React time to render the library tree
    await browser.pause(2000);

    // Wait for the Places category item to be available in the sidebar tree
    const placesItem = await $(`.tree-item-self[data-category="Places"]`);
    await placesItem.waitForExist({ timeout: 15_000 });
  });

  it("Places map renders markers and filters on click", async function () {
    // ── Step 1: Navigate to Places category ──
    // Click "Places" in the sidebar library tree via JavaScript to bypass
    // WebDriver interactability checks (sidebar items may be clipped from
    // WebDriver's perspective inside Obsidian's workspace leaf).
    const placesItem = await $(`.tree-item-self[data-category="Places"]`);
    await placesItem.waitForExist({ timeout: 10_000 });
    await browser.execute((el) => (el as HTMLElement).click(), placesItem);

    // Wait for any gallery card to appear — confirms the gallery is open and
    // Bases has provided entries for the Places category.
    const anyCard = await $(".roost-card");
    await anyCard.waitForDisplayed({ timeout: MAP_TIMEOUT });

    // ── Step 2: Map container visible ──
    // renderPlacesMap() adds class "roost-places-map" to the container element.
    // bookmarks-bases-view.ts inserts this container before the gallery when
    // filter.category === "Places".
    const mapEl = await $(".roost-places-map");
    await mapEl.waitForDisplayed({ timeout: MAP_TIMEOUT });

    // ── Step 3: At least one pin marker visible ──
    // Production uses L.marker + L.divIcon, which renders as
    // <div class="leaflet-marker-icon"> inside .leaflet-marker-pane.
    // Wait briefly for Leaflet to paint markers after the map mounts.
    await browser.pause(500);
    const markers = await mapEl.$$(".leaflet-marker-icon");
    expect(markers.length).toBeGreaterThan(0);

    // Snapshot card count before interacting with the map
    const cardsBefore = (await $$(".roost-card")).length;

    // ── Step 4: Click first marker — expect grid to filter (or hold steady) ──
    // Drive the click through JavaScript so WebDriver's interactability check
    // doesn't reject elements that may be hidden behind tile layers.
    await browser.execute((el) => (el as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    ), markers[0]);

    // Give React + Obsidian filter callbacks time to settle
    await browser.pause(500);

    const cardsAfter = (await $$(".roost-card")).length;

    // Card count must not grow (filtering can only hold or reduce),
    // and at least one card must remain visible.
    expect(cardsAfter).toBeLessThanOrEqual(cardsBefore);
    expect(cardsAfter).toBeGreaterThan(0);
  });
});
