/**
 * Fetch cover images for entries in the active Bases view.
 */
import { Notice, type App } from "obsidian";
import type { BasesEntry } from "obsidian";
import { fetchCoversForEntries } from "@/sync/cover-fetcher";

export async function fetchCoversCommand(
  app: App,
  omdbApiKey: string | undefined,
): Promise<void> {
  const view = app.workspace.activeLeaf?.view as {
    currentView?: { data?: { data?: BasesEntry[] } };
  };
  const baseView = view?.currentView;
  if (!baseView?.data?.data) {
    new Notice("Open a Base view first");
    return;
  }
  const notice = new Notice("Fetching covers...", 0);
  const result = await fetchCoversForEntries(
    app,
    baseView.data.data,
    (cur, total, title) => {
      notice.setMessage(`Fetching covers: ${cur}/${total} — ${title}`);
    },
    { omdbApiKey },
  );
  notice.hide();
  new Notice(`Covers: ${result.fetched} fetched, ${result.failed} failed`);
}
