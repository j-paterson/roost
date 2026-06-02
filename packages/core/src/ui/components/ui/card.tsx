import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const cardVariants = cva(
  "rounded-md border flex flex-col",
  {
    variants: {
      variant: {
        default: "border-border/60 bg-card shadow-sm",
        elevated: "border-border/60 bg-card shadow-md",
        flat: "border-border/40 bg-card",
      },
      padding: {
        default: "px-3 py-2.5 gap-1.5",
        compact: "px-2.5 py-2 gap-1",
        loose: "px-4 py-3 gap-2",
      },
    },
    defaultVariants: {
      variant: "default",
      padding: "default",
    },
  }
)

function Card({
  className,
  variant,
  padding,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return (
    <div
      data-slot="card"
      className={cn(cardVariants({ variant, padding }), className)}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn("flex items-center gap-2", className)}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="card-title"
      className={cn("font-medium truncate flex-1", className)}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn(className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn("flex items-center gap-2 pt-0.5", className)}
      {...props}
    />
  )
}

export { Card, CardHeader, CardTitle, CardContent, CardFooter }
