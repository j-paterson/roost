import { ItemView, type App, type WorkspaceLeaf } from "obsidian";
import { domainFromUrl } from "@/lib/link-card";

export const VIEW_TYPE_ROOST_LINK = "roost-link";

/** Pure, happy-dom-testable: appends a header bar into `host`. */
export function buildLinkViewHeader(host: HTMLElement, url: string): void {
  const bar = host.appendChild(document.createElement("div"));
  bar.className = "roost-linkview-bar";

  const dom = bar.appendChild(document.createElement("span"));
  dom.className = "roost-linkview-domain";
  dom.textContent = domainFromUrl(url) ?? url;

  const open = bar.appendChild(document.createElement("a"));
  open.className = "roost-linkview-open";
  open.textContent = "↗ Open in browser";
  open.setAttribute("href", url);
}

export class RoostLinkView extends ItemView {
  private url = "";

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType() { return VIEW_TYPE_ROOST_LINK; }
  getDisplayText() { return this.url ? (domainFromUrl(this.url) ?? "Link") : "Link"; }
  getIcon() { return "link"; }

  async setState(state: { url?: string }, result: unknown): Promise<void> {
    this.url = state?.url ?? "";
    this.render();
    return super.setState(state as never, result as never);
  }

  getState(): { url: string } {
    return { url: this.url };
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.url) return;
    buildLinkViewHeader(c, this.url);
    const wv = document.createElement("webview") as HTMLElement;
    wv.setAttribute("src", this.url);
    wv.setAttribute("partition", "persist:roost-link");
    wv.addClass("roost-linkview-webview");
    c.appendChild(wv);
  }
}

/** Open a new RoostLinkView tab for `url`. */
export async function openLinkInView(app: App, url: string): Promise<void> {
  const leaf = app.workspace.getLeaf("tab");
  await leaf.setViewState({ type: VIEW_TYPE_ROOST_LINK, active: true, state: { url } });
  app.workspace.revealLeaf(leaf);
}
