/**
 * Gallery bulk-write overlay — dims grid and shows progress during batch frontmatter writes.
 */
import type { IRoostPlugin } from "@/types/plugin";
import { traceEvent } from "@/lib/render-trace";

export interface GalleryBulkWriteHost {
  containerEl: HTMLElement;
  scrollEl: HTMLElement;
  getRoostPlugin(): IRoostPlugin | null;
}

export class GalleryBulkWriteController {
  private unsubscribe: (() => void) | null = null;
  private overlayEl: HTMLElement | null = null;

  constructor(private readonly host: GalleryBulkWriteHost) {}

  tryAttach(): void {
    if (this.unsubscribe) return;
    const plugin = this.host.getRoostPlugin();
    if (!plugin) return;

    this.unsubscribe = plugin.onBulkWriteChange((active) => {
      traceEvent("bulkWriteListener", { active });
      this.host.containerEl?.classList.toggle("roost-bulk-write-active", active);
      this.toggleOverlay(active);
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.toggleOverlay(false);
  }

  private toggleOverlay(active: boolean): void {
    if (active && !this.overlayEl && this.host.scrollEl) {
      const el = this.host.scrollEl.createDiv({ cls: "roost-bulk-write-overlay" });
      el.createDiv({ cls: "roost-bulk-write-spinner" });
      el.createSpan({ cls: "roost-bulk-write-label", text: "Updating items…" });
      this.overlayEl = el;
    } else if (!active && this.overlayEl) {
      this.overlayEl.remove();
      this.overlayEl = null;
    }
  }
}
