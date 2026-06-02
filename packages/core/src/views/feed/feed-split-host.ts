/**
 * Feed-mode split layout — moves the gallery innerScroll into a left pane
 * and reserves a right pane for the feed scroller.
 */
import { attachFlexRatioDrag } from "@/ui/horizontal-drag-resize";

export interface FeedSplitMount {
  /** Outer flex host (sibling anchor for pipeline "above" views). */
  hostEl: HTMLElement;
  leftPane: HTMLElement;
  dividerEl: HTMLElement;
  rightPane: HTMLElement;
  /** Restore innerScroll to outerScrollEl and remove the split host. */
  teardown: () => void;
}

export function mountFeedSplit(
  outerScrollEl: HTMLElement,
  innerScroll: HTMLElement,
  opts: {
    defaultRatio: number;
    minPanePx: number;
    onRatioChange: (ratio: number) => void;
  },
): FeedSplitMount {
  const hostEl = outerScrollEl.createDiv({ cls: "roost-feed-host" });
  hostEl.style.display = "flex";
  hostEl.style.flexDirection = "row";
  hostEl.style.flex = "1 1 0";
  hostEl.style.minHeight = "0";

  const leftPane = hostEl.createDiv({ cls: "roost-feed-pane-left" });
  const dividerEl = hostEl.createDiv({ cls: "roost-feed-divider" });
  dividerEl.setAttr("title", "Drag to resize");
  const rightPane = hostEl.createDiv({ cls: "roost-feed-pane-right" });

  leftPane.style.flex = `0 0 ${opts.defaultRatio * 100}%`;
  rightPane.style.flex = "1 1 0";

  leftPane.appendChild(innerScroll);

  attachFlexRatioDrag({
    dividerEl,
    splitEl: hostEl,
    leftPane,
    rightPane: rightPane,
    minPanePx: opts.minPanePx,
    onRatioChange: opts.onRatioChange,
  });

  return {
    hostEl,
    leftPane,
    dividerEl,
    rightPane,
    teardown: () => {
      if (hostEl.parentElement && innerScroll) {
        hostEl.parentElement.appendChild(innerScroll);
      }
      hostEl.remove();
    },
  };
}
