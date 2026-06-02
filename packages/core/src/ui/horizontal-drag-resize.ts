/**
 * Shared mouse-drag helpers for horizontal flex splits and column widths.
 */

/** Drag a vertical divider to resize left/right flex panes as a ratio of total width. */
export function attachFlexRatioDrag(opts: {
  dividerEl: HTMLElement;
  splitEl: HTMLElement;
  leftPane: HTMLElement;
  rightPane: HTMLElement;
  minPanePx: number;
  onRatioChange: (ratio: number) => void;
}): void {
  const { dividerEl, splitEl, leftPane, rightPane, minPanePx, onRatioChange } = opts;
  dividerEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const rect = splitEl.getBoundingClientRect();
    const startX = e.clientX;
    const startLeftW = leftPane.getBoundingClientRect().width;
    const totalW = rect.width;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const raw = Math.max(minPanePx, Math.min(totalW - minPanePx, startLeftW + dx));
      const r = raw / totalW;
      onRatioChange(r);
      leftPane.style.flex = `0 0 ${r * 100}%`;
      rightPane.style.flex = "1 1 0";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

/** Drag a column resize handle to set an element's width in pixels. */
export function attachColumnWidthDrag(opts: {
  handleEl: HTMLElement;
  targetEl: HTMLElement;
  minWidthPx: number;
  onWidthChange: (widthPx: number) => void;
}): void {
  const { handleEl, targetEl, minWidthPx, onWidthChange } = opts;
  handleEl.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = targetEl.getBoundingClientRect().width;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const newW = Math.max(minWidthPx, startW + dx);
      onWidthChange(newW);
      targetEl.style.width = `${newW}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
