/**
 * Places + feed mode — grid cards and map survive mode toggle and category switching.
 *
 * Regression test for the bug where navigating to Places with feed mode on
 * caused the card grid to vanish (or the map to disappear on toggle).
 *
 * Tests are ordered to build on each other — each starts from the state
 * the previous test left.
 */

import { browser } from "@wdio/globals";

const TIMEOUT = 15_000;

async function selectCategory(name: string): Promise<void> {
  const item = await $(`.tree-item-self[data-category="${name}"]`);
  await item.waitForExist({ timeout: TIMEOUT });
  await browser.execute((el) => (el as HTMLElement).click(), item);
  await browser.pause(2_000);
}

async function isFeedMode(): Promise<boolean> {
  return (await $$(".roost-feed-host")).length > 0;
}

async function toggleFeed(): Promise<void> {
  const btn = await $(".roost-mode-btn");
  await btn.waitForExist({ timeout: TIMEOUT });
  await browser.execute((el) => (el as HTMLElement).click(), btn);
  await browser.pause(1_000);
}

async function cardCount(): Promise<number> {
  return (await $$(".roost-card")).length;
}

async function dumpState(label: string): Promise<void> {
  const diag = await browser.execute(() => {
    const mapWrap = document.querySelector(".roost-places-map-wrap") as HTMLElement | null;
    return {
      mapExists: !!mapWrap,
      mapParent: mapWrap?.parentElement?.className ?? "gone",
      cardCount: document.querySelectorAll(".roost-card").length,
      feedHost: !!document.querySelector(".roost-feed-host"),
    };
  });
  console.log(`[DIAG ${label}]`, JSON.stringify(diag));
}

describe("Places + feed mode", function () {
  before(async function () {
    await browser.executeObsidianCommand("roost:open");
    const sidebar = await $(".roost-root");
    await sidebar.waitForDisplayed({ timeout: 30_000 });
    await browser.pause(2_000);
  });

  it("1: Places in grid mode — map + cards render", async function () {
    // Ensure grid mode
    if (await isFeedMode()) await toggleFeed();

    await selectCategory("Places");

    const map = await $(".roost-places-map");
    await map.waitForDisplayed({ timeout: TIMEOUT });

    const cards = await cardCount();
    expect(cards).toBeGreaterThan(0);
    await dumpState("after grid Places");
  });

  it("2: toggle feed ON while on Places — map + cards persist", async function () {
    // We're already on Places from test 1. Do NOT re-click the category.
    await dumpState("before toggle ON");

    await toggleFeed();
    expect(await isFeedMode()).toBe(true);
    await browser.pause(2_000);

    await dumpState("after toggle ON");

    const cards = await cardCount();
    expect(cards).toBeGreaterThan(0);

    const map = await $(".roost-places-map");
    await map.waitForDisplayed({ timeout: TIMEOUT });
  });

  it("3: toggle feed OFF — map + cards persist", async function () {
    // We're on Places in feed mode from test 2.
    await toggleFeed();
    expect(await isFeedMode()).toBe(false);
    await browser.pause(2_000);

    await dumpState("after toggle OFF");

    const cards = await cardCount();
    expect(cards).toBeGreaterThan(0);

    const map = await $(".roost-places-map");
    await map.waitForDisplayed({ timeout: TIMEOUT });
  });

  it("4: Media → Places with feed auto-on — map + cards render", async function () {
    // Start fresh: go to a non-pipeline category first
    await selectCategory("Recipes");
    await browser.pause(1_000);

    // Go to Media — forces feed mode on
    await selectCategory("Media");
    await browser.pause(2_000);
    expect(await isFeedMode()).toBe(true);

    // Switch to Places — feed mode stays on
    await selectCategory("Places");
    await browser.pause(3_000);

    await dumpState("after Media→Places");

    const map = await $(".roost-places-map");
    await map.waitForDisplayed({ timeout: TIMEOUT });

    const cards = await cardCount();
    expect(cards).toBeGreaterThan(0);
  });
});
