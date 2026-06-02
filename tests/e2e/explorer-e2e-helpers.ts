/**
 * Shared E2E helpers for the general file explorer Bases view.
 */
import { browser } from "@wdio/globals";

export const EXPLORER_OPEN_TIMEOUT = 30_000;

function activeExplorerGridScript(minCards: number): number {
  const grid = document.querySelector(".workspace-leaf.mod-active .roost-bases-grid");
  if (!grid) return 0;
  const hydrated = grid.querySelectorAll(".roost-card[data-path]").length;
  if (hydrated >= minCards) return hydrated;
  return grid.querySelectorAll(".roost-card").length;
}

/** Open Explorer.base, focus its leaf, and wait for the explorer grid to hydrate. */
export async function openExplorerBase(minCards = 3): Promise<void> {
  await browser.executeObsidian(async ({ app }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["roost"] as {
      openExplorerBase(): Promise<void>;
      settings: { syncFolder: string };
    } | undefined;
    if (!plugin?.openExplorerBase) {
      throw new Error("roost plugin openExplorerBase not available");
    }
    await plugin.openExplorerBase();
    const basePath = `${plugin.settings.syncFolder}/Explorer.base`;
    const leaf = app.workspace.getLeavesOfType("base").find((l) => {
      const view = l.view as { file?: { path?: string } };
      return view?.file?.path === basePath;
    });
    if (leaf) {
      app.workspace.revealLeaf(leaf);
      // revealLeaf doesn't always make the leaf mod-active fast enough for
      // our grid-scoped selectors; force it active.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (app.workspace as any).setActiveLeaf?.(leaf, { focus: true });
    }
  });
  await waitForExplorerGrid(minCards);
  await browser.waitUntil(
    async () => {
      const ok = await browser.executeObsidian(() => {
        const grid = document.querySelector(".workspace-leaf.mod-active .roost-bases-grid");
        return grid?.querySelector("[data-content-type]") != null;
      });
      return ok as boolean;
    },
    {
      timeout: EXPLORER_OPEN_TIMEOUT,
      timeoutMsg: "active grid is not roost-explorer (missing data-content-type)",
    },
  );
}

export async function waitForExplorerGrid(minCards = 3): Promise<void> {
  await browser.waitUntil(
    async () => {
      const n = await browser.executeObsidian(activeExplorerGridScript, minCards);
      return (n as number) >= minCards;
    },
    {
      timeout: EXPLORER_OPEN_TIMEOUT,
      timeoutMsg: "explorer grid did not hydrate",
    },
  );
}

/** Apply an explorer folder filter via plugin.setFilter (sidebar uses the same path). */
export async function applyExplorerFolderFilter(
  folderPath: string,
  expectedCount: number,
): Promise<void> {
  await openExplorerBase(expectedCount);
  await browser.executeObsidian(async ({ app }, folder: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plugin = (app as any).plugins.plugins["roost"] as {
      setFilter(filter: { folder: string } | null): void;
    } | undefined;
    if (!plugin?.setFilter) throw new Error("roost setFilter missing");
    plugin.setFilter(null);
    plugin.setFilter({ folder });
  }, folderPath);
  await browser.waitUntil(
    async () => (await countExplorerCards()) === expectedCount,
    {
      timeout: EXPLORER_OPEN_TIMEOUT,
      timeoutMsg: `explorer folder filter did not narrow to ${expectedCount} cards (${folderPath})`,
    },
  );
}

export async function countExplorerCards(): Promise<number> {
  return (await browser.executeObsidian(activeExplorerGridScript, 0)) as number;
}
