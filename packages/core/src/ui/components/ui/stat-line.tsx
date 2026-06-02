import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * StatLine — horizontal row of dot-separated metrics.
 * Wrap each metric in a `<Stat>` child.
 *
 * ```tsx
 * <StatLine>
 *   <Stat>64 items</Stat>
 *   <Stat highlight>LOO 3%</Stat>
 *   <Stat>cohesion 0.81</Stat>
 * </StatLine>
 * ```
 */
function StatLine({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="stat-line"
      className={cn("flex flex-wrap items-center text-muted-foreground", className)}
      style={{ fontSize: 11 }}
      {...props}
    />
  )
}

const SEP = <span aria-hidden style={{ opacity: 0.35, margin: "0 4px" }}>·</span>

function Stat({
  highlight,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  /** Renders with normal text color and medium weight — use for key diagnostics */
  highlight?: boolean
}) {
  return (
    <>
      {SEP}
      <span
        data-slot="stat"
        className={cn(highlight && "text-foreground font-medium", className)}
        {...props}
      >
        {children}
      </span>
    </>
  )
}

/**
 * First stat in a line (no leading separator).
 * Use for the primary metric like item count.
 */
function StatFirst({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="stat"
      className={cn(className)}
      {...props}
    />
  )
}

export { StatLine, Stat, StatFirst }
