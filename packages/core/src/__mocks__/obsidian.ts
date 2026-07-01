/**
 * Minimal stubs for the obsidian package — just enough for unit tests
 * that import modules referencing obsidian types and functions.
 */
export class Vault {}
export class App {}
export class FileSystemAdapter {
  basePath: string = "";
  getBasePath(): string { return this.basePath; }
}
export class TFile {}
export class TFolder {}
export class Modal {}
export class SuggestModal<T> extends Modal {
  getSuggestions(_query: string): T[] { return []; }
  renderSuggestion(_item: T, _el: HTMLElement): void {}
  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class WorkspaceLeaf {}
export class Setting {}
export class Menu {}
export class QueryController {}

/** No-op stub — DOM icon rendering is not testable in happy-dom. */
export function setIcon(_el: HTMLElement, _iconId: string): void {}

export type RequestUrlParam = { url: string; method?: string; headers?: Record<string, string>; body?: string };
export type RequestUrlResponse = { status: number; headers: Record<string, string>; json: unknown; text: string; arrayBuffer: ArrayBuffer };

let _impl: (req: RequestUrlParam) => Promise<RequestUrlResponse> = () => {
  throw new Error("requestUrl is not available in tests — call __setRequestUrlImpl(fn) first");
};

export function requestUrl(req: RequestUrlParam): Promise<RequestUrlResponse> {
  return _impl(req);
}

/** Test-only hook — call from beforeEach to provide a stub implementation. */
export function __setRequestUrlImpl(impl: (req: RequestUrlParam) => Promise<RequestUrlResponse>): void {
  _impl = impl;
}

/** Test-only hook — restore the throwing default. */
export function __resetRequestUrlImpl(): void {
  _impl = () => {
    throw new Error("requestUrl is not available in tests — call __setRequestUrlImpl(fn) first");
  };
}
