import * as React from "react";
import { cn, formatClock, formatDurationMs } from "@/lib/utils";
import type { Job, JobDetail } from "@/lib/types";
import { JobStatusBadge } from "./ui/badge";
import { Button } from "./ui/button";
import { IconClose, IconRetry, IconTrash } from "./icons";

interface JobDrawerProps {
  jobId: string | null;
  detail: JobDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRetry: (job: Job) => void;
  onCancel: (job: Job) => void;
  onDeleteConfirmed: (job: Job) => void;
  busy: boolean;
}

export function JobDrawer({
  jobId,
  detail,
  loading,
  error,
  onClose,
  onRetry,
  onCancel,
  onDeleteConfirmed,
  busy,
}: JobDrawerProps) {
  const [confirmDelete, setConfirmDelete] = React.useState(false);

  React.useEffect(() => {
    setConfirmDelete(false);
  }, [jobId]);

  React.useEffect(() => {
    if (!jobId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [jobId, onClose]);

  if (!jobId) return null;

  const job = detail?.job;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-label="Job execution inspector"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-[540px] flex-col border-l border-[var(--border)] bg-[var(--surface)] text-[var(--text)]">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--rule)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-[var(--muted)]">{jobId}</span>
              {job && <JobStatusBadge status={job.status} />}
            </div>
            <h2 className="mt-1 truncate text-[16px] font-semibold">
              {job ? job.name : "Loading job details..."}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close job inspector"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] text-[var(--muted)] hover:bg-[var(--active)] hover:text-[var(--text)] cursor-pointer"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading && !detail && (
            <p className="text-[13px] text-[var(--muted)]">
              Loading execution timeline and payload...
            </p>
          )}

          {error && (
            <div className="rounded-[6px] border border-[var(--negative)]/30 bg-[var(--pill-negative-bg)] px-3.5 py-2.5 text-[13px] text-[var(--pill-negative-ink)]">
              {error}
            </div>
          )}

          {job && (
            <>
              {/* Last Error banner if present */}
              {job.lastError && (
                <div className="rounded-[6px] border border-[var(--negative)]/35 bg-[var(--pill-negative-bg)] p-3.5">
                  <div className="text-[12px] font-semibold text-[var(--pill-negative-ink)]">
                    Last failure reason
                  </div>
                  <p className="mt-1 font-mono text-[12px] text-[var(--pill-negative-ink)] break-words">
                    {job.lastError}
                  </p>
                </div>
              )}

              {/* Metadata Grid */}
              <div className="grid grid-cols-2 gap-3 rounded-[8px] border border-[var(--border)] bg-[var(--raised)]/60 p-3.5 text-[12px] sm:grid-cols-3">
                <div>
                  <div className="text-[var(--muted)]">Queue</div>
                  <div className="mt-0.5 font-mono font-medium">{job.queue}</div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Executor</div>
                  <div className="mt-0.5 font-mono font-medium">{job.type}</div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Attempts</div>
                  <div className="mt-0.5 font-mono font-medium tabular-nums">
                    {job.attempts} / {job.maxAttempts}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Priority</div>
                  <div className="mt-0.5 font-mono font-medium tabular-nums">{job.priority}</div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Duration</div>
                  <div className="mt-0.5 font-mono font-medium tabular-nums">
                    {formatDurationMs(job.durationMs)}
                  </div>
                </div>
                <div>
                  <div className="text-[var(--muted)]">Created</div>
                  <div className="mt-0.5 font-mono font-medium tabular-nums">
                    {formatClock(job.createdAt)}
                  </div>
                </div>
              </div>

              {job.idempotencyKey && (
                <div className="text-[12px]">
                  <span className="text-[var(--muted)]">Idempotency key: </span>
                  <code className="rounded bg-[var(--raised)] px-1.5 py-0.5 font-mono text-[12px]">
                    {job.idempotencyKey}
                  </code>
                </div>
              )}

              {/* Execution log timeline */}
              <div>
                <h3 className="text-[13px] font-semibold mb-2">Execution logs</h3>
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--raised)]/40 divide-y divide-[var(--rule)]">
                  {detail.logs.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-[var(--muted)]">
                      No log entries recorded yet.
                    </div>
                  ) : (
                    detail.logs.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2.5 px-3 py-2 text-[12px]"
                      >
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--muted)]">
                          {formatClock(entry.createdAt)}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 font-mono text-[11px] uppercase w-[52px]",
                            entry.level === "error"
                              ? "text-[var(--negative)] font-medium"
                              : entry.level === "warn"
                                ? "text-[var(--warning)] font-medium"
                                : entry.level === "success"
                                  ? "text-[var(--positive)] font-medium"
                                  : "text-[var(--muted)]"
                          )}
                        >
                          {entry.level}
                        </span>
                        <span className="min-w-0 flex-1 break-words text-[var(--text)]">
                          {entry.message}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Payload & Result JSON */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-[13px] font-semibold mb-1.5">Payload</h3>
                  <pre className="overflow-x-auto rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3 font-mono text-[12px] leading-relaxed">
                    {JSON.stringify(job.payload ?? {}, null, 2)}
                  </pre>
                </div>

                {job.result && Object.keys(job.result).length > 0 && (
                  <div>
                    <h3 className="text-[13px] font-semibold mb-1.5">Result</h3>
                    <pre className="overflow-x-auto rounded-[8px] border border-[var(--border)] bg-[var(--raised)] p-3 font-mono text-[12px] leading-relaxed">
                      {JSON.stringify(job.result, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer actions */}
        {job && (
          <div className="border-t border-[var(--rule)] px-5 py-3.5">
            {confirmDelete ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-[var(--negative)] font-medium">
                  Delete {job.id} permanently?
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Keep job
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDeleteConfirmed(job)}
                  >
                    Delete permanently
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  {job.status !== "running" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setConfirmDelete(true)}
                      className="text-[var(--negative)]"
                    >
                      <IconTrash className="h-3.5 w-3.5" aria-hidden="true" />
                      Delete job
                    </Button>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {(job.status === "queued" ||
                    job.status === "retrying" ||
                    job.status === "running") && (
                    <Button
                      variant="outline"
                      size="md"
                      disabled={busy}
                      onClick={() => onCancel(job)}
                    >
                      Cancel job
                    </Button>
                  )}
                  {(job.status === "dead_letter" ||
                    job.status === "cancelled" ||
                    job.status === "completed") && (
                    <Button
                      variant="accent"
                      size="md"
                      disabled={busy}
                      onClick={() => onRetry(job)}
                    >
                      <IconRetry className="h-3.5 w-3.5" aria-hidden="true" />
                      Re-queue job
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
