/** Bases view configuration options for the general file explorer. */
export function explorerViewOptions() {
  return [
    { type: "slider" as const, key: "cardSize", displayName: "Card size", min: 120, max: 400, step: 10, default: 200 },
    { type: "slider" as const, key: "imageRatio", displayName: "Image aspect ratio", min: 50, max: 200, step: 5, default: 75 },
    { type: "dropdown" as const, key: "imageFit", displayName: "Image fit", default: "cover", options: { cover: "Cover", contain: "Contain" } },
    { type: "property" as const, key: "imageProperty", displayName: "Image property" },
    { type: "toggle" as const, key: "showPath", displayName: "Show file path", default: false },
  ];
}

export const EXPLORER_RICH_FIELDS = [
  { id: "note.description", kind: "text" as const },
  { id: "note.recommendation", kind: "text" as const },
  { id: "note.relevance_note", kind: "text" as const },
  { id: "note.reader_quote", kind: "quote" as const },
] as const;

export const EXPLORER_SKIP_PROPS = new Set([
  "note.title", "note.cover", "note.tags", "note.url",
  ...EXPLORER_RICH_FIELDS.map(f => f.id),
]);
