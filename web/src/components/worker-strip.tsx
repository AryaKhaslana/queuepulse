import { cn, formatUptime } from "@/lib/utils";
import type { PoolStatus } from "@/lib/types";
import { Button } from "./ui/button";
import { IconPause, IconPlay } from "./icons";

interface WorkerStripProps {
  pool: PoolStatus;
  busyAction: boolean;
  onTogglePause: () => void;
  onChangeConcurrency: (next: number) => void;
  onInspectJob: (jobId: string) => void;
}

/**
 * QueuePulse signature element: live worker slot strip with direct concurrency
 * and pause controls so operators see exactly which goroutine owns each job.
 */
export function WorkerStrip({
  pool,
  busyAction,
  onTogglePause,
  onChangeConcurrency,
  onInspectJob,
}: WorkerStripProps) {
  return (
    <section
      aria-label="Worker pool slots"
      className="rounded-[8px] border border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="text-[14px] font-semibold text-[var(--text)]">
            Worker pool
          </h2>
          <span className="font-mono text-[12px] tabular-nums text-[var(--muted)]">
            {pool.busyWorkers}/{pool.concurrency} busy
          </span>
          <span className="text-[12px] text-[var(--muted)]">
            · Uptime {formatUptime(pool.uptimeSec)}
          </span>
          {pool.paused && (
            <span className="rounded-[4px] bg-[var(--pill-warning-bg)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--pill-warning-ink)]">
              Paused
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div
            className="inline-flex items-center rounded-[6px] border border-[var(--control)] bg-[var(--surface)]"
            role="group"
            aria-label="Worker concurrency"
          >
            <button
              type="button"
              disabled={busyAction || pool.concurrency <= pool.minWorkers}
              onClick={() => onChangeConcurrency(pool.concurrency - 1)}
              aria-label="Decrease worker slots"
              className="flex h-7 w-7 items-center justify-center text-[14px] font-medium text-[var(--text)] hover:bg-[var(--raised)] disabled:opacity-35 cursor-pointer"
            >
              -
            </button>
            <span className="min-w-[68px] border-x border-[var(--rule)] px-2 text-center font-mono text-[12px] tabular-nums text-[var(--text)]">
              {pool.concurrency} {pool.concurrency === 1 ? "slot" : "slots"}
            </span>
            <button
              type="button"
              disabled={busyAction || pool.concurrency >= pool.maxWorkers}
              onClick={() => onChangeConcurrency(pool.concurrency + 1)}
              aria-label="Increase worker slots"
              className="flex h-7 w-7 items-center justify-center text-[14px] font-medium text-[var(--text)] hover:bg-[var(--raised)] disabled:opacity-35 cursor-pointer"
            >
              +
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            disabled={busyAction}
            onClick={onTogglePause}
          >
            {pool.paused ? (
              <>
                <IconPlay className="h-3.5 w-3.5" aria-hidden="true" />
                Resume pool
              </>
            ) : (
              <>
                <IconPause className="h-3.5 w-3.5" aria-hidden="true" />
                Pause pool
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Horizontal grid of individual worker slots */}
      <div className="grid grid-cols-1 divide-y divide-[var(--rule)] sm:grid-cols-2 sm:divide-y-0 sm:gap-px sm:bg-[var(--rule)] lg:grid-cols-3 xl:grid-cols-4">
        {pool.slots.map((slot) => {
          const isBusy = slot.state === "busy" && slot.jobId;
          return (
            <div
              key={slot.id}
              className={cn(
                "relative flex flex-col justify-between bg-[var(--surface)] px-4 py-3 min-h-[82px]",
                isBusy && "bg-[var(--accent-soft)]/35"
              )}
            >
              {isBusy && (
                <div
                  className="absolute inset-x-0 top-0 h-[2px] bg-[var(--accent)]"
                  aria-hidden="true"
                />
              )}

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] font-medium text-[var(--text)]">
                    {slot.id}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] font-medium",
                      slot.state === "busy"
                        ? "text-[var(--accent)]"
                        : slot.state === "paused"
                          ? "text-[var(--warning)]"
                          : "text-[var(--muted)]"
                    )}
                  >
                    {slot.state === "busy"
                      ? "running"
                      : slot.state === "paused"
                        ? "paused"
                        : "idle"}
                  </span>
                </div>

                <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                  {slot.processed} ok{slot.failed > 0 ? ` · ${slot.failed} err` : ""}
                </span>
              </div>

              {isBusy ? (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => slot.jobId && onInspectJob(slot.jobId)}
                    className="block max-w-full truncate text-left text-[12px] font-medium text-[var(--text)] hover:text-[var(--accent)] cursor-pointer"
                    title={slot.jobName}
                  >
                    {slot.jobName}
                  </button>
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                      <div
                        className="h-full bg-[var(--accent)] transition-[width] duration-200"
                        style={{ width: `${Math.max(4, slot.progress)}%` }}
                      />
                    </div>
                    <span className="font-mono text-[11px] tabular-nums text-[var(--muted)]">
                      {slot.progress}%
                    </span>
                  </div>
                </div>
              ) : (
                <div className="mt-2 text-[12px] text-[var(--muted)]">
                  {slot.state === "paused"
                    ? "Waiting for pool resume"
                    : "Ready for next queued job"}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
