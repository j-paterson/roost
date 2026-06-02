import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * StatusBadge — a tinted pill badge that auto-generates a translucent
 * background from the given color. Use for inline status indicators
 * like "polluted", "confused", "overlap", etc.
 *
 * The `color` prop accepts any CSS color value. The background is derived
 * by appending alpha hex digits to create a tint effect.
 */
function StatusBadge({
  label,
  color,
  className,
  ...props
}: {
  label: string
  color: string
} & Omit<React.ComponentProps<"span">, "children">) {
  return (
    <span
      data-slot="status-badge"
      className={cn(
        "inline-flex shrink-0 items-center rounded px-1.5 py-px font-semibold uppercase",
        className,
      )}
      style={{
        color,
        fontSize: 9,
        letterSpacing: "0.04em",
        lineHeight: "16px",
        background: color + "18",
        border: `1px solid ${color}40`,
      }}
      {...props}
    >
      {label}
    </span>
  )
}

export { StatusBadge }
