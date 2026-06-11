/**
 * Export X session cookies from the login webview for live e2e tests.
 */
import { Notice } from "obsidian";
import type { WebviewManager } from "@/sync/webview-manager";

export async function exportXCookies(getWebviewManager: () => WebviewManager): Promise<void> {
  const wm = getWebviewManager();
  const wv = wm.getElement("twitter");
  if (!wv) {
    new Notice(
      "X webview not initialized — open the X view first (Cmd+P → Sync X/Twitter), wait for the page to load, then retry.",
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let remote: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    remote = require("@electron/remote");
  } catch (e) {
    new Notice(
      `Could not load @electron/remote: ${String(e)}.\nFallback: open DevTools (Ctrl+Shift+I) → Application → Cookies → x.com, export auth_token and ct0 manually.`,
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wvEl = wv as any;
  let wcId: number;
  try {
    wcId = wvEl.getWebContentsId();
  } catch {
    new Notice("X webview is not ready — wait for x.com to finish loading, then retry.");
    return;
  }

  const webContents = remote.webContents.fromId(wcId);
  if (!webContents) {
    new Notice("Could not get WebContents for X webview. Try navigating to x.com in the X pane first.");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawCookies: any[];
  try {
    rawCookies = await webContents.session.cookies.get({ url: "https://x.com" });
  } catch (e) {
    new Notice(`Failed to read X cookies: ${String(e)}`);
    return;
  }

  const exportCookies = rawCookies.map((c) => ({
    url: `https://${c.domain?.startsWith(".") ? "x.com" : c.domain ?? "x.com"}`,
    name: c.name,
    value: c.value,
    domain: c.domain ?? ".x.com",
    path: c.path ?? "/",
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: (c.sameSite ?? "no_restriction") as string,
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
  }));

  if (exportCookies.length === 0) {
    new Notice(
      "No X cookies found. Make sure you are logged in to x.com in the X webview before running this command.",
    );
    return;
  }

  const json = JSON.stringify(exportCookies, null, 2);
  try {
    await navigator.clipboard.writeText(json);
  } catch (e) {
    new Notice(
      `Clipboard write failed (${String(e)}).\n\n` +
        `Cookies were NOT logged anywhere. Manual export: open DevTools ` +
        `(Ctrl+Shift+I) → Application → Cookies → x.com and copy auth_token ` +
        `and ct0 into tests/e2e/.x-cookies.json yourself.`,
      12000,
    );
    return;
  }

  new Notice(
    `X cookies copied to clipboard (${exportCookies.length} cookies).\n\n` +
      `Paste into  tests/e2e/.x-cookies.json  in the project repo to enable live tests.\n\n` +
      `SECURITY: Cookies are session credentials — do NOT commit that file. It is in .gitignore.`,
    12000,
  );
}
