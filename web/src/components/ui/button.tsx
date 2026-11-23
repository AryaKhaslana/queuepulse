import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] text-[13px] font-medium transition-colors cursor-pointer disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--text)] text-[var(--surface)] hover:opacity-90 border border-transparent",
        accent:
          "bg-[var(--accent)] text-[var(--accent-fg)] hover:opacity-92 border border-transparent",
        outline:
          "bg-[var(--surface)] text-[var(--text)] border border-[var(--control)] hover:bg-[var(--raised)]",
        ghost:
          "bg-transparent text-[var(--muted)] hover:text-[var(--text)] hover:bg-[var(--active)] border border-transparent",
        danger:
          "bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)] border border-[var(--negative)]/30 hover:opacity-90",
      },
      size: {
        sm: "h-7 px-2.5 text-[12px]",
        md: "h-8 px-3",
        lg: "h-9 px-3.5 text-[13px]",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "md",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";
