/**
 * Shared types for sync and pipeline operations.
 */

/** The two supported sync platforms. */
export type Platform = "tiktok" | "twitter";

/** Cancellation signal passed through sync/pipeline operations */
export interface StopSignal {
  stopped: boolean;
  stop: () => void;
}

/** Progress update from platform sync operations (TikTok, Twitter).
 *  Named SyncPhaseProgress to distinguish from the UI ProgressState shape
 *  in progress-header.tsx, which tracks written/skipped/resynced counts. */
export interface SyncPhaseProgress {
  phase: string;
  count: number;
  total: number;
  done: boolean;
}

/**
 * Electron <webview> element interface — the custom Electron element that
 * extends HTMLElement with methods for JS injection and navigation.
 * No public type exists in Obsidian or DOM types; this documents the minimal
 * surface used by the sync probes.
 */
export interface ElectronWebview extends HTMLElement {
  // Returns the evaluated expression from the webview — can be any JSON-serializable value.
  executeJavaScript(code: string): Promise<any>;
  loadURL(url: string): void;
  reload(): void;
  sendInputEvent(event: {
    type: "mouseDown" | "mouseUp" | "keyDown" | "keyUp" | "char";
    x?: number;
    y?: number;
    button?: "left" | "right" | "middle";
    clickCount?: number;
    keyCode?: string;
  }): void;
  getWebContentsId(): number;
  setAudioMuted(muted: boolean): void;
}
