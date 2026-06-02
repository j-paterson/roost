/**
 * Gallery filter navigation history — back/forward through filter stack.
 */
import type { RoostFilter } from "@/types/roost";
import type { IRoostPlugin } from "@/types/plugin";

export interface GalleryFilterHistoryHost {
  getRoostPlugin(): IRoostPlugin | null;
  onHistoryChanged(): void;
}

export class GalleryFilterHistoryController {
  private history: RoostFilter[] = [];
  private index = -1;
  private navigating = false;

  constructor(private readonly host: GalleryFilterHistoryHost) {}

  getIndex(): number {
    return this.index;
  }

  getLength(): number {
    return this.history.length;
  }

  isNavigating(): boolean {
    return this.navigating;
  }

  push(filter: RoostFilter): void {
    if (this.navigating) return;
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(filter);
    this.index = this.history.length - 1;
    this.host.onHistoryChanged();
  }

  navigateBack(): void {
    if (this.index <= 0) return;
    this.index--;
    this.navigating = true;
    this.host.getRoostPlugin()?.setFilter(this.history[this.index] ?? null);
    this.navigating = false;
    this.host.onHistoryChanged();
  }

  navigateForward(): void {
    if (this.index >= this.history.length - 1) return;
    this.index++;
    this.navigating = true;
    this.host.getRoostPlugin()?.setFilter(this.history[this.index] ?? null);
    this.navigating = false;
    this.host.onHistoryChanged();
  }
}
