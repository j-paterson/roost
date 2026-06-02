/**
 * Webview manager — creates and manages <webview> elements for TikTok/X login and sync.
 */
import type { ElectronWebview, Platform } from "@/types/sync";

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Result of an auth-cookie probe. "unknown" means we couldn't determine it
 *  (webview not ready, or Electron session APIs unavailable e.g. in tests) —
 *  callers should treat it as "don't change what we already believe". */
export type AuthStatus = "connected" | "logged-out" | "unknown";

/** Cookie names whose presence (with a non-empty value) indicates a logged-in
 *  session. These are httpOnly, so document.cookie can't see them — we read
 *  them via the partition's Electron session instead. */
const AUTH_COOKIES: Record<Platform, string[]> = {
  tiktok: ["sessionid", "sessionid_ss"],
  twitter: ["auth_token"],
};

const PLATFORM_ORIGIN: Record<Platform, string> = {
  tiktok: "https://www.tiktok.com",
  twitter: "https://x.com",
};

interface ElectronSession {
  cookies: { get(filter: { url: string }): Promise<Array<{ name: string; value: string }>> };
  clearStorageData(): Promise<void>;
}

/** Lazily require @electron/remote; null when unavailable (tests, web). */
function loadRemote(): {
  webContents: { fromId(id: number): { session: ElectronSession } | null };
  session?: { fromPartition(p: string): ElectronSession };
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("@electron/remote");
  } catch {
    return null;
  }
}

interface ManagedWebview {
  element: ElectronWebview;
  webContentsId: number | null;
}

export class WebviewManager {
  private webviews: Map<Platform, ManagedWebview> = new Map();
  private container: HTMLElement;
  private onLog: (msg: string) => void;

  constructor(container: HTMLElement, onLog: (msg: string) => void) {
    this.container = container;
    this.onLog = onLog;
  }

  /**
   * Create a webview for a platform. Reuses existing if already created.
   */
  create(platform: Platform): ElectronWebview {
    const existing = this.webviews.get(platform);
    if (existing) return existing.element;

    const url = platform === "tiktok" ? "https://www.tiktok.com/" : "https://x.com/";
    // <webview> is an Electron custom element — not in standard DOM types.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const webview = document.createElement("webview") as unknown as ElectronWebview;
    webview.setAttribute("src", url);
    webview.setAttribute("partition", `persist:roost-${platform}`);
    webview.setAttribute("allowpopups", "");
    webview.setAttribute("useragent", CHROME_UA);
    // Start hidden but with real dimensions so Electron initializes the renderer process
    webview.style.cssText = "flex: 1; width: 100%; height: 100%; border: none; position: absolute; visibility: hidden;";

    const managed: ManagedWebview = { element: webview, webContentsId: null };

    webview.addEventListener("dom-ready", () => {
      try {
        managed.webContentsId = webview.getWebContentsId();
        webview.setAudioMuted(true);
      } catch { /* ignore */ }
    });

    // Electron webview events carry extra properties not in standard DOM Event types.
    webview.addEventListener("did-fail-load", (e) => {
      this.onLog(`[${platform}] Load failed: ${(e as Event & { errorDescription?: string }).errorDescription}`);
    });

    webview.addEventListener("console-message", (e) => {
      const msg = (e as Event & { message?: string }).message;
      if (msg?.includes("[Roost")) {
        this.onLog(`[${platform}] ${msg}`);
      }
    });

    this.container.appendChild(webview);
    this.webviews.set(platform, managed);
    return webview;
  }

  /**
   * Get the webview element for a platform (supports executeJavaScript()).
   * Returns null until dom-ready has fired.
   */
  getWebContents(platform: Platform): ElectronWebview | null {
    const managed = this.webviews.get(platform);
    if (!managed) return null;
    if (!managed.webContentsId) return null;
    return managed.element;
  }

  /**
   * Load a URL in the platform's webview.
   */
  loadURL(platform: Platform, url: string): void {
    const managed = this.webviews.get(platform);
    if (!managed) return;
    managed.element.loadURL(url);
  }

  /**
   * Show a platform's webview, hide others.
   */
  show(platform: Platform): void {
    for (const [p, m] of this.webviews) {
      if (p === platform) {
        m.element.style.cssText = "flex: 1; width: 100%; height: 100%; border: none;";
      } else {
        m.element.style.cssText = "flex: 1; width: 100%; height: 100%; border: none; position: absolute; visibility: hidden;";
      }
    }
  }

  hideAll(): void {
    for (const m of this.webviews.values()) {
      m.element.style.cssText = "flex: 1; width: 100%; height: 100%; border: none; position: absolute; visibility: hidden;";
    }
  }

  /**
   * Mount a platform's webview into a specific DOM target (e.g. a hub card's
   * expansion area). The webview stays a child of `target` until `unmount`
   * is called, at which point it returns to the manager's hidden container.
   * Supports multiple webviews mounted in different targets simultaneously.
   */
  mount(platform: Platform, target: HTMLElement): void {
    const managed = this.webviews.get(platform);
    if (!managed) return;
    target.appendChild(managed.element);
    managed.element.style.cssText = "flex: 1; width: 100%; height: 100%; border: none;";
  }

  /**
   * Unmount a platform's webview from wherever it currently lives and return
   * it to the manager's hidden container. Safe to call even if it was never
   * mounted via `mount`.
   */
  unmount(platform: Platform): void {
    const managed = this.webviews.get(platform);
    if (!managed) return;
    this.container.appendChild(managed.element);
    managed.element.style.cssText = "flex: 1; width: 100%; height: 100%; border: none; position: absolute; visibility: hidden;";
  }

  /**
   * Get the raw webview element for event listening.
   */
  getElement(platform: Platform): ElectronWebview | null {
    return this.webviews.get(platform)?.element ?? null;
  }

  /** Get the container element (for re-parenting into views) */
  getContainer(): HTMLElement {
    return this.container;
  }

  /**
   * Probe whether the platform's persistent session currently holds an auth
   * cookie. This is the real "are we logged in?" signal — independent of
   * whether a sync has ever run. Returns "unknown" if the webview isn't ready
   * yet or Electron session APIs aren't reachable, so callers can fall back
   * to whatever they already knew rather than wrongly showing "logged out".
   */
  async probeAuth(platform: Platform): Promise<AuthStatus> {
    const managed = this.webviews.get(platform);
    if (!managed?.webContentsId) return "unknown";
    const remote = loadRemote();
    if (!remote) return "unknown";
    try {
      const wc = remote.webContents.fromId(managed.webContentsId);
      if (!wc) return "unknown";
      const cookies = await wc.session.cookies.get({ url: PLATFORM_ORIGIN[platform] });
      const names = AUTH_COOKIES[platform];
      const found = cookies.some((c) => names.includes(c.name) && c.value.length > 0);
      return found ? "connected" : "logged-out";
    } catch {
      return "unknown";
    }
  }

  /**
   * Clear a platform's persistent session (cookies + storage) so the next
   * open starts logged out, then reload the login page so the embedded view
   * reflects the disconnected state. Used by the hub's Disconnect action.
   */
  async clearSession(platform: Platform): Promise<void> {
    const managed = this.webviews.get(platform);
    const remote = loadRemote();
    try {
      let session: ElectronSession | null = null;
      if (remote && managed?.webContentsId) {
        session = remote.webContents.fromId(managed.webContentsId)?.session ?? null;
      }
      if (!session && remote?.session) {
        session = remote.session.fromPartition(`persist:roost-${platform}`);
      }
      if (session) await session.clearStorageData();
    } catch { /* ignore */ }
    // Reload the login page regardless, so a still-open pane shows logged-out.
    try {
      managed?.element.loadURL(`${PLATFORM_ORIGIN[platform]}/`);
    } catch { /* ignore */ }
  }

  /**
   * Clean up all webviews.
   */
  destroy(): void {
    for (const m of this.webviews.values()) {
      m.element.remove();
    }
    this.webviews.clear();
  }
}
