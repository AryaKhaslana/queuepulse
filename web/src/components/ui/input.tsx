import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-8 w-full rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)] placeholder:text-[var(--muted)]/80 transition-colors focus:border-[var(--accent)] focus:outline-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Input.displayName = "Input";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      "h-8 w-full rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 text-[13px] text-[var(--text)] transition-colors focus:border-[var(--accent)] focus:outline-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Select.displayName = "Select";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(
      "w-full rounded-[6px] border border-[var(--control)] bg-[var(--surface)] px-2.5 py-2 text-[13px] text-[var(--text)] placeholder:text-[var(--muted)]/80 transition-colors focus:border-[var(--accent)] focus:outline-none disabled:opacity-50",
      className
    )}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export function Label({
  className,
  ...props
}: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("block text-[12px] font-medium text-[var(--text)] mb-1", className)}
      {...props}
    />
  );
}
