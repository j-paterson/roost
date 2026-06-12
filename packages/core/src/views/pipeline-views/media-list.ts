/**
 * Media list — sortable table that substitutes for the gallery card grid
 * when the active filter is Media (or a Media subcategory). Reads the
 * media_* frontmatter the Media pipeline writes onto source bookmarks.
 *
 * Registered with the pipeline-view registry at module load. Sort state
 * lives at module scope so a re-render preserves the user's chosen
 * column.
 */
import type { BasesEntry } from "obsidian";
import { getRoostId, safeGetValue } from "@/lib/bases-entry";
import { MEDIA_FIELDS } from "@/pipeline/media-pipeline";
import { attachColumnWidthDrag } from "@/ui/horizontal-drag-resize";
import {
  registerPipelineGalleryView,
  type PipelineGalleryView,
  type GalleryRenderContext,
} from "./registry";
import { stopAllInlinePlayers } from "./inline-audio-player";
import { type MediaRow, renderMediaWhereCell } from "./media-where-cell";

type SortKey = "title" | "creator" | "type" | "genre" | "rating" | "where";
type SortDir = "asc" | "desc";

let sort: { key: SortKey; dir: SortDir } = { key: "title", dir: "asc" };

/** Session-scoped column widths (px). null = let the browser auto-size.
 *  Persists across re-renders within the session via module scope; resets
 *  on plugin reload. Tracked per sort key to mirror what the user dragged. */
const columnWidths: Partial<Record<SortKey, number>> = {};

/** Default widths applied when the user hasn't manually resized the
 *  column. Used to give music-heavy columns (Where) extra room for the
 *  inline 320px+ player cards without squeezing title/creator. */
const COLUMN_DEFAULT_WIDTHS: Partial<Record<SortKey, number>> = {
  where: 400,
};

/** Minimum width so a user can't drag a column down to zero and
 *  lose the resize handle. */
const MIN_COL_PX = 60;

/** Coerce a frontmatter value to a display string. Strips noise that
 *  shouldn't appear in a user-facing table:
 *    - JS null/undefined → ""
 *    - "null" / "undefined" string literals → "" (YAML null sometimes
 *      serializes back through Obsidian's frontmatter parser as a literal
 *      "null" string; older migration paths also stamped string-null)
 *    - "Unknown" → "" (the LLM's placeholder when extraction can't
 *      identify a creator/genre; showing the literal word is uglier
 *      than showing an em-dash in the rendered table) */
function asNullableString(v: unknown): string | null {
  const s = asString(v);
  return s ? s : null;
}

function asTmdbType(v: unknown): "movie" | "tv" | null {
  return v === "movie" || v === "tv" ? v : null;
}

function asNullableNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : String(v);
  const trimmed = s.trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined" || lower === "unknown") return "";
  return s;
}

/** Parse an id-style frontmatter value. `undefined` = key absent
 *  (pipeline never ran); `null` = key present as YAML null (pipeline
 *  tried and didn't match); string = resolved value. */
function parseNullableId(fm: Record<string, unknown> | undefined, key: string): string | null | undefined {
  if (!fm || !(key in fm)) return undefined;
  const raw = fm[key];
  if (raw == null) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

function entryFrontmatter(
  app: import("obsidian").App,
  entry: BasesEntry,
): Record<string, unknown> | undefined {
  return app.metadataCache.getCache(entry.file.path)?.frontmatter as
    | Record<string, unknown>
    | undefined;
}

/** Bases property schema can lag behind metadataCache for pipeline fields. */
function fieldFromEntry(
  app: import("obsidian").App,
  entry: BasesEntry,
  basesKey: string,
  fmKey: string,
): string {
  const fromBases = asString(safeGetValue(entry, basesKey));
  if (fromBases) return fromBases;
  return asString(entryFrontmatter(app, entry)?.[fmKey]);
}

function buildRows(app: import("obsidian").App, entries: BasesEntry[]): MediaRow[] {
  const rows: MediaRow[] = [];
  for (const entry of entries) {
    const title = fieldFromEntry(app, entry, "note.media_title", "media_title");
    if (!title) continue;
    const fm = entryFrontmatter(app, entry);
    rows.push({
      filePath: entry.file.path,
      title,
      creator: fieldFromEntry(app, entry, "note.media_creator", "media_creator"),
      type: fieldFromEntry(app, entry, "note.roost_subcategory", "roost_subcategory"),
      genre: fieldFromEntry(app, entry, "note.media_genre", "media_genre"),
      rating: fieldFromEntry(app, entry, "note.media_rating", "media_rating"),
      where: fieldFromEntry(app, entry, "note.media_where", "media_where"),
      url: asString(safeGetValue(entry, "note.url")),
      spotifyId: parseNullableId(fm, MEDIA_FIELDS.spotifyId),
      tmdbId: asNullableString(safeGetValue(entry, "note.media_tmdb_id")),
      tmdbType: asTmdbType(safeGetValue(entry, "note.media_tmdb_type")),
      anilistId: asNullableString(safeGetValue(entry, "note.media_anilist_id")),
      year: asNullableNumber(safeGetValue(entry, "note.media_year")),
    });
  }
  return rows;
}

function sortRows(rows: MediaRow[]): void {
  const fieldFor: Record<SortKey, keyof MediaRow> = {
    title: "title", creator: "creator", type: "type",
    genre: "genre", rating: "rating", where: "where",
  };
  const field = fieldFor[sort.key];
  const sign = sort.dir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = String(a[field] ?? "").toLowerCase();
    const bv = String(b[field] ?? "").toLowerCase();
    if (!av && bv) return 1;   // empty values sort to bottom regardless of dir
    if (av && !bv) return -1;
    return av.localeCompare(bv) * sign;
  });
}

const mediaListView: PipelineGalleryView = {
  mode: "substitute",
  render(container, ctx: GalleryRenderContext) {
    container.empty();
    container.addClass("roost-media-list-host");

    // The table takes the full pipeline-view container width. The right-side
    // detail preview is handled by the gallery's feed pane (ctx.setFeedActive).
    const wrap = container.createDiv({ cls: "roost-media-list-root" });

    let selectedRow: HTMLElement | null = null;

    const rows = buildRows(ctx.app, ctx.entries);

    if (rows.length === 0) {
      wrap.createDiv({
        cls: "roost-media-list-empty",
        text: "No media-enriched bookmarks here. Click the play button on the Media row in the sidebar to run the pipeline.",
      });
      return {
        dispose: () => {
          stopAllInlinePlayers();
          // Remove ONLY our own root: dispatch() disposes after the standard
          // grid has reconciled cards into this container, so a
          // container.empty() here would delete them. (The old "next render
          // empties the container" contract died when grid renders became
          // reconciling — gallery-grid-render.ts.)
          wrap.remove();
          container.removeClass("roost-media-list-host");
        },
      };
    }

    sortRows(rows);

    const table = wrap.createEl("table", { cls: "roost-media-list-table" });
    const thead = table.createEl("thead");
    const headerRow = thead.createEl("tr");
    const headers: Array<[SortKey, string]> = [
      ["title", "Title"], ["creator", "Creator"], ["type", "Type"],
      ["genre", "Genre"], ["rating", "Rating"], ["where", "Where"],
    ];
    for (const [key, label] of headers) {
      const th = headerRow.createEl("th", { cls: "roost-media-list-header" });
      th.setText(label);
      const width = columnWidths[key] ?? COLUMN_DEFAULT_WIDTHS[key];
      if (width != null) {
        th.style.width = `${width}px`;
      }
      if (sort.key === key) {
        th.addClass("is-sorted");
        th.createSpan({ cls: "roost-media-list-sort-arrow", text: sort.dir === "asc" ? " ▲" : " ▼" });
      }
      th.addEventListener("click", () => {
        if (sort.key === key) {
          sort = { key, dir: sort.dir === "asc" ? "desc" : "asc" };
        } else {
          sort = { key, dir: "asc" };
        }
        ctx.rerender();
      });

      // Column resize handle — a thin strip on the right edge. mousedown
      // starts a drag, mousemove updates the th width directly (cells
      // below inherit via table-layout: fixed). stopPropagation prevents
      // the drag's underlying mousedown/click from firing the sort
      // handler attached to the th.
      const handle = th.createSpan({ cls: "roost-media-list-resize-handle" });
      handle.setAttr("title", "Drag to resize column");
      handle.addEventListener("click", (e) => e.stopPropagation());
      attachColumnWidthDrag({
        handleEl: handle,
        targetEl: th,
        minWidthPx: MIN_COL_PX,
        onWidthChange: (newW) => { columnWidths[key] = newW; },
      });
    }

    // Render the empty-cell placeholder as an em-dash with muted styling so
    // the table reads as a clean grid even when fields are sparse (Type
    // is often the only thing set on items the user has manually
    // subcategorized but the pipeline hasn't enriched yet).
    const cell = (parent: HTMLElement, value: string, extraCls?: string): HTMLElement => {
      const td = parent.createEl("td", { cls: extraCls });
      if (value) td.setText(value);
      else td.createSpan({ cls: "roost-media-list-empty-cell", text: "—" });
      return td;
    };

    const tbody = table.createEl("tbody");
    // Map row → entry so the click handler can resolve the BasesEntry
    // without iterating ctx.entries every time.
    const entryByPath = new Map<string, typeof ctx.entries[number]>();
    for (const e of ctx.entries) entryByPath.set(e.file.path, e);

    for (const row of rows) {
      const tr = tbody.createEl("tr", { cls: "roost-media-list-row" });
      tr.addEventListener("click", () => {
        // Drive the gallery's feed pane to this item. Resolve roost_id via
        // the BasesEntry the same way the gallery indexes its feed slots
        // (entry.getValue("note.roost_id")?.toString()) — the prior path
        // through metadataCache + strict typeof === "string" was failing
        // silently when the cache hadn't normalized the field to a string.
        if (selectedRow) selectedRow.removeClass("is-selected");
        tr.addClass("is-selected");
        selectedRow = tr;

        const entry = entryByPath.get(row.filePath);
        if (entry && ctx.setFeedActive) {
          ctx.setFeedActive(getRoostId(entry));
        }
      });
      cell(tr, row.title, "roost-media-list-title");
      cell(tr, row.creator);
      cell(tr, row.type);
      cell(tr, row.genre);
      cell(tr, row.rating);
      const whereCell = tr.createEl("td");
      const entry = entryByPath.get(row.filePath);
      const cachedVideoUrl = entry ? ctx.resolveVideoUrl(entry) : null;
      const coverUrl = entry ? ctx.resolveImageUrl(entry) : null;
      renderMediaWhereCell(whereCell, row, { cachedVideoUrl, coverUrl });
    }

    wrap.createDiv({
      cls: "roost-media-list-footer",
      text: `${rows.length} item${rows.length === 1 ? "" : "s"}`,
    });

    return {
      dispose: () => {
        stopAllInlinePlayers();
        // Remove ONLY our own root: dispatch() disposes after the standard
        // grid has reconciled cards into this container, so a
        // container.empty() here would delete them. (The old "next render
        // empties the container" contract died when grid renders became
        // reconciling — gallery-grid-render.ts.)
        wrap.remove();
        container.removeClass("roost-media-list-host");
      },
    };
  },
};

registerPipelineGalleryView("Media", mediaListView);
