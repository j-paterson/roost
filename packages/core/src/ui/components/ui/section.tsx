import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Section — a collapsible, visually separated group with an uppercase label
 * header, optional step badge, count, and trailing extra content.
 *
 * Sections after the first get a top border divider.
 * Click the header to expand/collapse the child content.
 *
 * ```tsx
 * <Section step={1} total={5} label="Merge duplicates" count={3} defaultOpen>
 *   <Card>...</Card>
 * </Section>
 * ```
 */
function Section({
  step,
  total,
  label,
  count,
  extra,
  isFirst,
  defaultOpen = false,
  gap = "gap-2.5",
  className,
  children,
}: {
  step: number
  total: number
  label: string
  count: number | string
  extra?: React.ReactNode
  isFirst?: boolean
  /** Whether the section starts expanded. Default: false */
  defaultOpen?: boolean
  /** Tailwind gap class for spacing between child cards. Default: "gap-2.5" */
  gap?: string
  className?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)

  return (
    <section className={cn(!isFirst && "pt-4 border-t border-border/30", className)}>
      <div
        className="mb-2.5 flex items-center gap-2 cursor-pointer select-none"
        style={{
          color: "var(--text-muted)",
          textTransform: "uppercase",
          fontSize: 10,
          letterSpacing: "0.05em",
        }}
        onClick={() => setOpen(o => !o)}
      >
        <span
          className="inline-flex items-center justify-center transition-transform"
          style={{
            fontSize: 8,
            opacity: 0.5,
            width: 10,
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
          }}
          aria-hidden
        >
          ▶
        </span>
        <span
          className="rounded px-1 py-px"
          style={{
            background: "var(--background-modifier-hover, rgba(255,255,255,0.06))",
            fontSize: 9,
            opacity: 0.7,
          }}
        >
          {step}/{total}
        </span>
        <span className="font-medium">{label}</span>
        <span style={{ opacity: 0.5 }}>({count})</span>
        {extra && <><div className="flex-1" /><span onClick={e => e.stopPropagation()}>{extra}</span></>}
      </div>
      {open && <div className={cn("flex flex-col", gap)}>{children}</div>}
    </section>
  )
}

export { Section }
