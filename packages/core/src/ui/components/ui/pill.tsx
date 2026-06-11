import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const pillVariants = cva(
  "inline-flex items-center rounded-full whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-secondary text-secondary-foreground",
        success: "bg-green-600 text-white",
        active: "bg-primary/20 text-primary font-medium",
        muted: "text-muted-foreground",
        destructive: "bg-destructive text-white",
        info: "bg-blue-600/20 text-blue-400",
      },
      size: {
        xs: "px-1.5 py-px text-[9px]",
        sm: "px-2 py-0.5 text-xs",
        default: "px-2.5 py-1 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

function Pill({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof pillVariants>) {
  return (
    <span
      data-slot="pill"
      data-variant={variant}
      data-size={size}
      className={cn(pillVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Pill }
