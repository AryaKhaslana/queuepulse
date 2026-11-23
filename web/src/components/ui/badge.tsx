import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { JobStatus } from "@/lib/types";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-[12px] font-medium leading-tight whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "bg-[var(--pill-neutral-bg)] text-[var(--pill-neutral-ink)]",
        positive: "bg-[var(--pill-positive-bg)] text-[var(--pill-positive-ink)]",
        negative: "bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]",
        warning: "bg-[var(--pill-warning-bg)] text-[var(--pill-warning-ink)]",
        accent: "bg-[var(--pill-accent-bg)] text-[var(--pill-accent-ink)]",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const STATUS_META: Record<
  JobStatus,
  { label: string; tone: NonNullable<BadgeProps["tone"]>; dot?: boolean }
> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "accent", dot: true },
  retrying: { label: "Retrying", tone: "warning" },
  completed: { label: "Completed", tone: "positive" },
  dead_letter: { label: "Dead Letter", tone: "negative" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "neutral" as const };
  return (
    <Badge tone={meta.tone}>
      {meta.dot && (
        <span
          className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
          aria-hidden="true"
        />
      )}
      {meta.label}
    </Badge>
  );
}
