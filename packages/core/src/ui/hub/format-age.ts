/** Relative-time formatter for hub status surfaces.
 *  Returns "never" for null/0 timestamps; otherwise "just now", "Xm ago",
 *  "Xh ago", or "Xd ago". Used by StatusStrip and PlatformCard. */
export function formatAge(ts: number | null | undefined): string {
  if (!ts) return "never";
  const minutes = Math.floor((Date.now() - ts) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
