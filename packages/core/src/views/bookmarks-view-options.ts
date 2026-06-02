/** Bases view configuration options for the bookmarks gallery. */
export function bookmarksViewOptions() {
  return [
    {
      type: "slider" as const,
      key: "cardSize",
      displayName: "Card size",
      min: 120, max: 400, step: 10, default: 180,
    },
    {
      type: "slider" as const,
      key: "imageRatio",
      displayName: "Image aspect ratio",
      min: 50, max: 200, step: 5, default: 75,
    },
    {
      type: "dropdown" as const,
      key: "imageFit",
      displayName: "Image fit",
      default: "cover",
      options: { cover: "Cover", contain: "Contain" },
    },
    {
      type: "property" as const,
      key: "imageProperty",
      displayName: "Image property",
    },
    {
      type: "toggle" as const,
      key: "showPlatform",
      displayName: "Show platform badge",
      default: true,
    },
    {
      type: "toggle" as const,
      key: "showAuthor",
      displayName: "Show author",
      default: true,
    },
    {
      type: "toggle" as const,
      key: "showTags",
      displayName: "Show tags",
      default: false,
    },
  ];
}
