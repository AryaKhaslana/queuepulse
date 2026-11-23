import * as React from "react";
import { cn } from "@/lib/utils";
import { IconClose } from "@/components/icons";

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  maxWidthClass?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  maxWidthClass = "max-w-[540px]",
}: DialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="qp-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "w-full rounded-[12px] border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] max-h-[90vh] flex flex-col overflow-hidden",
          maxWidthClass
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--rule)] px-5 py-4">
          <div>
            <h2 id="qp-dialog-title" className="text-[16px] font-semibold leading-snug">
              {title}
            </h2>
            {description && (
              <p className="mt-0.5 text-[13px] text-[var(--muted)]">{description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-7 w-7 items-center justify-center rounded-[6px] text-[var(--muted)] hover:bg-[var(--active)] hover:text-[var(--text)] cursor-pointer"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
