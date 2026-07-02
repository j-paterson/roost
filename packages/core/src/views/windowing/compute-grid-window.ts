/**
 * Pure geometry for a row-windowed CSS grid: given the scroll viewport and a
 * uniform row height, return which item indices to materialize and how tall the
 * top/bottom spacers must be to preserve total scroll height.
 *
 * The grid analogue of feed-panel's computeMountWindow. Windows around the
 * scroll viewport (not an active index) because the gallery is free-scroll.
 */

export interface GridWindowArgs {
  total: number;
  columns: number;
  rowHeight: number;      // px per row incl. gap; guarded to > 0
  scrollTop: number;
  viewportHeight: number;
  bufferRows: number;     // extra rows above & below the viewport to pre-mount
}

export interface GridWindow {
  windowStart: number;    // first materialized index (row-aligned)
  windowEnd: number;      // exclusive
  topSpacerPx: number;
  bottomSpacerPx: number;
}

export function computeGridWindow(args: GridWindowArgs): GridWindow {
  const { total, scrollTop, viewportHeight, bufferRows } = args;
  const columns = Math.max(1, Math.floor(args.columns));
  const rowHeight = args.rowHeight > 0 ? args.rowHeight : 1;

  if (total <= 0) {
    return { windowStart: 0, windowEnd: 0, topSpacerPx: 0, bottomSpacerPx: 0 };
  }

  const totalRows = Math.ceil(total / columns);
  const firstVisibleRow = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
  const lastVisibleRow = Math.min(
    totalRows - 1,
    Math.ceil((scrollTop + viewportHeight) / rowHeight) + bufferRows,
  );

  const windowStart = Math.min(total, firstVisibleRow * columns);
  const windowEnd = Math.min(total, (lastVisibleRow + 1) * columns);
  const topSpacerPx = firstVisibleRow * rowHeight;
  const bottomSpacerPx = (totalRows - 1 - lastVisibleRow) * rowHeight;

  return { windowStart, windowEnd, topSpacerPx, bottomSpacerPx };
}

/**
 * Count column tracks in a *computed* `grid-template-columns` value. Browsers
 * resolve `repeat(auto-fill, minmax(...))` to an explicit px track list, so we
 * count whitespace-separated tokens. Returns `fallback` for empty / "none"
 * (before first layout, or in a non-layout test environment).
 */
export function parseColumnCount(gridTemplateColumns: string, fallback = 1): number {
  const v = gridTemplateColumns?.trim();
  if (!v || v === "none") return fallback;
  const tracks = v.split(/\s+/).filter(Boolean).length;
  return tracks > 0 ? tracks : fallback;
}
