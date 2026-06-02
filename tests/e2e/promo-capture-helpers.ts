/**
 * Save PNGs for social / marketing from E2E-driven Obsidian states.
 * Output: docs/promo/screenshots/ (repo root relative).
 */
import { browser } from "@wdio/globals";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROMO_OUT_DIR = path.resolve(__dirname, "../../docs/promo/screenshots");
export const PROMO_BURST_DIR = path.resolve(__dirname, "../../docs/promo/bursts");

/** Obsidian outer window for promo captures (default 2× prior 1024×800). */
export const PROMO_WINDOW_WIDTH = Number(process.env.PROMO_WINDOW_WIDTH ?? 2048);
export const PROMO_WINDOW_HEIGHT = Number(process.env.PROMO_WINDOW_HEIGHT ?? 1600);

/** Resize Obsidian outer window (WebDriver setWindowSize is unsupported on Electron). */
export async function resizePromoWindow(): Promise<void> {
  const resized = await browser.execute((w, h) => {
    try {
      const req = (globalThis as { require?: (id: string) => unknown }).require;
      const remote = req?.("@electron/remote") as {
        getCurrentWindow?: () => { setSize: (width: number, height: number) => void };
      };
      remote?.getCurrentWindow?.()?.setSize(w, h);
      return !!remote?.getCurrentWindow;
    } catch {
      return false;
    }
  }, PROMO_WINDOW_WIDTH, PROMO_WINDOW_HEIGHT);
  if (!resized) {
    console.warn(
      "[promo] @electron/remote resize unavailable — using default Obsidian window size",
    );
  }
  await browser.pause(800);
}

/** Extra pause before each shot when recording video (PROMO_SLOW=1). */
export function promoPause(ms = 400): Promise<void> {
  const slow = process.env["PROMO_SLOW"] === "1";
  return browser.pause(slow ? Math.max(ms, 2_500) : ms);
}

export function ensurePromoOutDir(): void {
  fs.mkdirSync(PROMO_OUT_DIR, { recursive: true });
}

/** Full-window PNG. Slug: `01-sidebar-library`. */
export async function savePromoShot(slug: string): Promise<string> {
  ensurePromoOutDir();
  const file = path.join(PROMO_OUT_DIR, `${slug}.png`);
  await browser.saveScreenshot(file);
  return file;
}

/** Crop to a single element (sidebar, gallery leaf, etc.). */
/** Frame sequence for ffmpeg burst clips (experiment C). */
export async function savePromoBurst(
  slug: string,
  opts?: { frames?: number; intervalMs?: number },
): Promise<string[]> {
  const frames = opts?.frames ?? Number(process.env.PROMO_BURST_FRAMES ?? 24);
  const intervalMs =
    opts?.intervalMs ?? Number(process.env.PROMO_BURST_INTERVAL_MS ?? 150);
  const dir = path.join(PROMO_BURST_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < frames; i++) {
    const file = path.join(dir, `frame-${String(i).padStart(4, "0")}.png`);
    await browser.saveScreenshot(file);
    paths.push(file);
    if (i < frames - 1) await browser.pause(intervalMs);
  }
  return paths;
}

export async function savePromoElement(
  selector: string,
  slug: string,
): Promise<string | null> {
  ensurePromoOutDir();
  const el = await $(selector);
  const exists = await el.isExisting();
  if (!exists) return null;
  await el.waitForDisplayed({ timeout: 15_000 });
  const file = path.join(PROMO_OUT_DIR, `${slug}.png`);
  await el.saveScreenshot(file);
  return file;
}

export async function openRoostSidebar(): Promise<void> {
  await resizePromoWindow();
  await browser.executeObsidianCommand("roost:open");
  const sidebarEl = await $(".roost-root");
  await sidebarEl.waitForDisplayed({ timeout: 30_000 });
  await promoPause(2_000);
}

/** Restore fixture snapshot into staging (no Ollama). */
export async function replayFixtureSnapshot(): Promise<void> {
  const smartAssignBtn = await $("button=Smart Assign");
  const alreadySync = await smartAssignBtn.isDisplayed().catch(() => false);
  if (!alreadySync) {
    await browser.execute(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const cancelBtn = buttons.find((b) => b.textContent?.trim() === "✕") as
        | HTMLElement
        | undefined;
      if (cancelBtn) cancelBtn.click();
    });
    await promoPause(1_500);
    await smartAssignBtn.waitForDisplayed({ timeout: 15_000 });
  }

  const replayBtn = await $("button*=Replay");
  await replayBtn.waitForDisplayed({ timeout: 10_000 });
  await browser.execute((el) => (el as HTMLElement).click(), replayBtn);

  const firstItem = await $(".roost-dropdown-item");
  await firstItem.waitForDisplayed({ timeout: 5_000 });
  await browser.execute((el) => (el as HTMLElement).click(), firstItem);

  const stagingTree = await $(".nav-folder-children");
  await stagingTree.waitForDisplayed({ timeout: 30_000 });
  await promoPause(1_000);
}
