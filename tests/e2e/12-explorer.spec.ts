/**
 * Explorer — general file Base view (roost-explorer)
 *
 * Opens Bookmarks/Explorer.base, verifies the card grid hydrates, folder
 * filter narrows results, and single-click expands a card in place.
 */

import { browser } from "@wdio/globals";
import {
  applyExplorerFolderFilter,
  countExplorerCards,
  openExplorerBase,
  waitForExplorerGrid,
} from "./explorer-e2e-helpers";

const TIMEOUT = 20_000;

describe("Explorer — file grid", function () {
  before(async function () {
    await browser.executeObsidianCommand("roost:open");
    const sidebarEl = await $(".roost-root");
    await sidebarEl.waitForDisplayed({ timeout: 30_000 });
    await openExplorerBase();
  });

  it("renders hydrated cards in the explorer grid", async function () {
    await waitForExplorerGrid(5);
    const count = await countExplorerCards();
    expect(count).toBeGreaterThanOrEqual(5);
  });

  it("folder filter reduces visible cards", async function () {
    const allCount = await countExplorerCards();
    expect(allCount).toBeGreaterThan(3);

    await applyExplorerFolderFilter("Bookmarks/e2e-sub", 2);
    const filtered = await countExplorerCards();
    expect(filtered).toBe(2);
    expect(filtered).toBeLessThan(allCount);

    const pathsOk = await browser.executeObsidian(() => {
      const grid = document.querySelector(".workspace-leaf.mod-active .roost-bases-grid");
      if (!grid) return false;
      const cards = grid.querySelectorAll(".roost-card[data-path]");
      if (cards.length !== 2) return false;
      return [...cards].every((el) => {
        const path = (el as HTMLElement).dataset.path ?? "";
        return path.includes("/e2e-sub/");
      });
    });
    expect(pathsOk).toBe(true);
  });

  it("clicking a card expands in place", async function () {
    await applyExplorerFolderFilter("Bookmarks/e2e-sub", 2);

    const cardPath = await browser.executeObsidian(({ app }) => {
      const basePath = "Bookmarks/Explorer.base";
      const leaf = app.workspace.getLeavesOfType("base").find((l) => {
        const view = l.view as { file?: { path?: string } };
        return view?.file?.path === basePath;
      });
      if (leaf) app.workspace.revealLeaf(leaf);
      const grid = document.querySelector(".workspace-leaf.mod-active .roost-bases-grid");
      const card = grid?.querySelector(".roost-card[data-path]") as HTMLElement | undefined;
      return card?.dataset.path ?? null;
    });

    expect(cardPath).toBeTruthy();
    const card = await $(`.workspace-leaf.mod-active .roost-card[data-path="${cardPath}"]`);
    await card.waitForExist({ timeout: TIMEOUT });
    await browser.execute((el) => (el as HTMLElement).click(), card);
    await browser.pause(400);

    await browser.waitUntil(
      async () => {
        const expanded = await browser.executeObsidian(() =>
          document.querySelector(".roost-card.roost-expanded") != null,
        );
        return expanded as boolean;
      },
      { timeout: TIMEOUT, timeoutMsg: "explorer card did not expand in place" },
    );

    const hasTitle = await browser.executeObsidian(() => {
      const title = document.querySelector(
        ".roost-card.roost-expanded .roost-expanded-title",
      );
      return (title?.textContent?.length ?? 0) > 0;
    });
    expect(hasTitle).toBe(true);
  });
});
