/**
 * Vault semantic search modal — calls vault-search CLI via subprocess.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { App, MarkdownView, Notice, SuggestModal } from "obsidian";
import type { IRoostPlugin } from "@/types/plugin";

function execFileAsync(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function findNode(overridePath: string): string {
  if (overridePath && existsSync(overridePath)) return overridePath;
  const home = process.env.HOME ?? "";
  const candidates = [
    `${home}/.local/share/fnm/aliases/default/bin/node`,
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    `${home}/.nvm/current/bin/node`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return "node";
}

interface VaultSearchResult {
  filePath: string;
  title: string;
  tags: string[];
  heading: string | null;
  snippet: string;
  score: number;
  scores: { bm25?: number; vector?: number };
}

const HIDDEN_TAG_PREFIXES = ["dashboard", "the-library", "media-vault"];

export class VaultSearchModal extends SuggestModal<VaultSearchResult> {
  private results: VaultSearchResult[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastQuery = "";
  private searchGeneration = 0;
  private configNoticeShown = false;

  constructor(
    app: App,
    private readonly plugin: IRoostPlugin,
  ) {
    super(app);
    this.setPlaceholder("Search vault semantically...");
    this.setInstructions([
      { command: "↑↓", purpose: "navigate" },
      { command: "↵", purpose: "open note" },
      { command: "esc", purpose: "dismiss" },
    ]);
  }

  getSuggestions(query: string): VaultSearchResult[] {
    if (!query || query.length < 2) return [];

    if (query !== this.lastQuery) {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.runSearch(query), 300);
    }

    return this.results;
  }

  private async runSearch(query: string) {
    const cliPath = this.plugin.settings.vaultSearchCliPath.trim();
    if (!cliPath) {
      if (!this.configNoticeShown) {
        this.configNoticeShown = true;
        new Notice("Set Vault search CLI path in Roost settings", 5000);
      }
      this.results = [];
      this.refreshSuggestions();
      return;
    }
    if (!existsSync(cliPath)) {
      new Notice(`Vault search CLI not found: ${cliPath}`, 5000);
      this.results = [];
      this.refreshSuggestions();
      return;
    }

    const generation = ++this.searchGeneration;
    this.lastQuery = query;

    try {
      const nodePath = findNode(this.plugin.settings.vaultSearchNodePath.trim());
      const adapter = this.app.vault.adapter as { basePath?: string };
      const { stdout } = await execFileAsync(
        nodePath,
        [cliPath, "search", query, "--limit=15"],
        {
          timeout: 10000,
          env: { ...process.env, VAULT_PATH: adapter.basePath ?? "" },
        },
      );
      if (generation !== this.searchGeneration) return;
      this.results = JSON.parse(stdout) as VaultSearchResult[];
    } catch (err: unknown) {
      if (generation !== this.searchGeneration) return;
      const msg = err instanceof Error ? err.message : String(err);
      console.error("vault-search error:", msg);
      new Notice(`Vault search failed: ${msg}`, 5000);
      this.results = [];
    }

    this.refreshSuggestions();
  }

  private refreshSuggestions() {
    this.inputEl.dispatchEvent(new Event("input"));
  }

  renderSuggestion(result: VaultSearchResult, el: HTMLElement): void {
    const container = el.createDiv({ cls: "vault-search-result" });

    const titleRow = container.createDiv({ cls: "vault-search-title-row" });
    titleRow.createSpan({ cls: "vault-search-title", text: result.title });

    const scoreBadge = titleRow.createSpan({ cls: "vault-search-score" });
    scoreBadge.textContent = String(Math.round(result.score * 1000));

    const pathParts = result.filePath.split("/");
    const pathText = pathParts.length > 2
      ? pathParts.slice(0, -1).join(" › ")
      : result.filePath;
    container.createDiv({ cls: "vault-search-path", text: pathText });

    if (result.heading) {
      container.createDiv({ cls: "vault-search-heading", text: `§ ${result.heading}` });
    }

    if (result.snippet && result.snippet !== "...") {
      const snippetEl = container.createDiv({ cls: "vault-search-snippet" });
      snippetEl.textContent = result.snippet.slice(0, 150);
    }

    if (result.tags.length > 0) {
      const tagsEl = container.createDiv({ cls: "vault-search-tags" });
      for (const tag of result.tags.slice(0, 4)) {
        if (tag && !HIDDEN_TAG_PREFIXES.some(p => tag.startsWith(p))) {
          tagsEl.createSpan({ cls: "vault-search-tag", text: `#${tag}` });
        }
      }
    }
  }

  onChooseSuggestion(result: VaultSearchResult): void {
    void this.app.workspace.openLinkText(result.filePath, "", false);

    if (!result.heading) return;

    window.setTimeout(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) return;
      const content = view.editor.getValue();
      const headingRegex = new RegExp(`^#{1,3}\\s+${escapeRegex(result.heading!)}`, "m");
      const match = content.match(headingRegex);
      if (match?.index === undefined) return;
      const line = content.slice(0, match.index).split("\n").length - 1;
      view.editor.setCursor(line, 0);
      view.editor.scrollIntoView(
        { from: { line, ch: 0 }, to: { line, ch: 0 } },
        true,
      );
    }, 200);
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
