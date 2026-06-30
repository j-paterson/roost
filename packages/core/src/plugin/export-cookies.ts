/**
 * Export a platform's session cookies from its login webview for live e2e tests.
 * Generic over any registered platform — reads the webview session keyed by the
 * platform's descriptor origin, copies the cookies to the clipboard, and tells
 * the user which tests/e2e/.<short>-cookies.json file to paste them into.
 */
import { Notice } from "obsidian";
import type { Platform } from "@/types/sync";
import { getPlatform } from "@/platforms/registry";
import type { WebviewManager } from "@/sync/webview-manager";

interface RawCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
}

export interface ExportCookie {
  url: string;
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  expirationDate?: number;
}

/** Per-platform e2e cookie-file basename + a human label for the Notice. */
const COOKIE_TARGETS: Partial<Record<Platform, { file: string; label: string }>> = {
  twitter: { file: "tests/e2e/.x-cookies.json", label: "X" },
  instagram: { file: "tests/e2e/.ig-cookies.json", label: "Instagram" },
};

/**
 * Pure mapping from raw Electron cookies to the e2e export shape. Host and the
 * default cookie domain are derived from the platform origin, so the same logic
 * serves every platform (x.com, www.instagram.com, …).
 */
export function toExportCookies(rawCookies: RawCookie[], origin: string): ExportCookie[] {
  const host = new URL(origin).host; // "x.com" | "www.instagram.com"
  const defaultDomain = "." + host.replace(/^www\./, ""); // ".x.com" | ".instagram.com"
  return rawCookies.map((c) => ({
    url: `https://${c.domain?.startsWith(".") ? host : c.domain ?? host}`,
    name: c.name,
    value: c.value,
    domain: c.domain ?? defaultDomain,
    path: c.path ?? "/",
    secure: c.secure ?? true,
    httpOnly: c.httpOnly ?? false,
    sameSite: c.sameSite ?? "no_restriction",
    ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
  }));
}

export async function exportCookies(
  platform: Platform,
  getWebviewManager: () => WebviewManager,
): Promise<void> {
  const desc = getPlatform(platform);
  const target = COOKIE_TARGETS[platform] ?? {
    file: `tests/e2e/.${platform}-cookies.json`,
    label: desc.displayName,
  };

  const wm = getWebviewManager();
  const wv = wm.getElement(platform);
  if (!wv) {
    new Notice(
      `${target.label} webview not initialized — open the ${target.label} view first ` +
        `(Cmd+P → Open ${target.label} login), wait for the page to load, then retry.`,
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
      `Could not load @electron/remote: ${String(e)}.\n` +
        `Fallback: open DevTools (Ctrl+Shift+I) → Application → Cookies → ${new URL(desc.origin).host}, ` +
        `export ${desc.authCookies.join(", ")} manually into ${target.file}.`,
    );
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wvEl = wv as any;
  let wcId: number;
  try {
    wcId = wvEl.getWebContentsId();
  } catch {
    new Notice(`${target.label} webview is not ready — wait for the page to finish loading, then retry.`);
    return;
  }

  const webContents = remote.webContents.fromId(wcId);
  if (!webContents) {
    new Notice(`Could not get WebContents for ${target.label} webview. Navigate to the site in the pane first.`);
    return;
  }

  let rawCookies: RawCookie[];
  try {
    rawCookies = await webContents.session.cookies.get({ url: desc.origin });
  } catch (e) {
    new Notice(`Failed to read ${target.label} cookies: ${String(e)}`);
    return;
  }

  const exported = toExportCookies(rawCookies, desc.origin);

  if (exported.length === 0) {
    new Notice(
      `No ${target.label} cookies found. Make sure you are logged in to ${new URL(desc.origin).host} ` +
        `in the ${target.label} webview before running this command.`,
    );
    return;
  }

  const json = JSON.stringify(exported, null, 2);

  // Preferred: write the cookie file straight into the repo's tests/e2e dir.
  // The plugin runs against the VAULT, not the repo, so the repo root comes
  // from ROOST_REPO (set alongside ROOST_DEV_COMMANDS when developing). On
  // success we're done — no clipboard step.
  const repoDir =
    typeof process !== "undefined" ? process.env?.ROOST_REPO?.trim() : undefined;
  if (repoDir) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require("fs");
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodePath = require("path");
      const outPath = nodePath.isAbsolute(target.file)
        ? target.file
        : nodePath.join(repoDir, target.file);
      fs.mkdirSync(nodePath.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, json, "utf8");
      new Notice(
        `${target.label} cookies written to ${outPath} (${exported.length} cookies).\n\n` +
          `SECURITY: it's gitignored — do NOT commit it.`,
        12000,
      );
      return;
    } catch (e) {
      new Notice(
        `Could not write ${target.file} (${String(e)}). Falling back to clipboard.`,
        8000,
      );
    }
  }

  // Fallback: clipboard (ROOST_REPO unset, or the file write failed above).
  try {
    await navigator.clipboard.writeText(json);
  } catch (e) {
    new Notice(
      `Clipboard write failed (${String(e)}).\n\n` +
        `Cookies were NOT logged anywhere. Manual export: open DevTools ` +
        `(Ctrl+Shift+I) → Application → Cookies → ${new URL(desc.origin).host} and copy ` +
        `${desc.authCookies.join(", ")} into ${target.file} yourself.`,
      12000,
    );
    return;
  }

  new Notice(
    `${target.label} cookies copied to clipboard (${exported.length} cookies).\n\n` +
      `Paste into  ${target.file}  in the project repo to enable live tests.\n\n` +
      `(Set ROOST_REPO=<repo path> to have this command write the file directly.)\n\n` +
      `SECURITY: Cookies are session credentials — do NOT commit that file. It is in .gitignore.`,
    12000,
  );
}
