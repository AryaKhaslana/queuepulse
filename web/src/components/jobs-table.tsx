import { cn, formatDurationMs, formatRelativeTime } from "@/lib/utils";
import type { Job, JobStatus } from "@/lib/types";
import { JobStatusBadge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select } from "./ui/input";
import { IconPlus, IconRetry } from "./icons";

export type StatusTab = "all" | "active" | "queued" | "completed" | "dead_letter";
export type SortMode = "default" | "newest" | "oldest" | "priority" | "duration";

interface JobsTableProps {
  jobs: Job[];
  activeTab: StatusTab;
  onTabChange: (tab: StatusTab) => void;
  queueFilter: string;
  onQueueFilterChange: (queue: string) => void;
  availableQueues: string[];
  sortMode: SortMode;
  onSortChange: (sort: SortMode) => void;
  counts: {
    all: number;
    active: number;
    queued: number;
    completed: number;
    dead_letter: number;
  };
  showTabs?: boolean;
  maxRows?: number;
  onViewAll?: () => void;
  onInspect: (jobId: string) => void;
  onRetry: (job: Job) => void;
  onCancel: (job: Job) => void;
  onRequestDelete: (job: Job) => void;
  onOpenEnqueue: () => void;
  onSpawnDemo: () => void;
  busyJobId: string | null;
}

const TABS: Array<{ id: StatusTab; label: string }> = [
  { id: "all", label: "All jobs" },
  { id: "active", label: "Running & retrying" },
  { id: "queued", label: "Queued" },
  { id: "completed", label: "Completed" },
  { id: "dead_letter", label: "Dead-letter" },
];

export function JobsTable({
  jobs,
  activeTab,
  onTabChange,
  queueFilter,
  onQueueFilterChange,
  availableQueues,
  sortMode,
  onSortChange,
  counts,
  showTabs = true,
  maxRows,
  onViewAll,
  onInspect,
  onRetry,
  onCancel,
  onRequestDelete,
  onOpenEnqueue,
  onSpawnDemo,
  busyJobId,
}: JobsTableProps) {
  const visible = typeof maxRows === "number" ? jobs.slice(0, maxRows) : jobs;

  const canRetry = (status: JobStatus) =>
    status === "dead_letter" || status === "cancelled" || status === "completed";
  const canCancel = (status: JobStatus) =>
    status === "queued" || status === "retrying" || status === "running";

  return (
    <section aria-label="Jobs list">
      {showTabs && (
        <div
          className="flex items-center gap-5 overflow-x-auto border-b border-[var(--border)]"
          role="tablist"
          aria-label="Filter jobs by status"
        >
          {TABS.map((tab) => {
            const selected = activeTab === tab.id;
            const n = counts[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => onTabChange(tab.id)}
                className={cn(
                  "relative shrink-0 pb-2.5 pt-1 text-[13px] transition-colors cursor-pointer",
                  selected
                    ? "font-semibold text-[var(--text)]"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                )}
              >
                <span>{tab.label}</span>
                <span className="ml-1.5 font-mono text-[11px] tabular-nums text-[var(--muted)]">
                  {n}
                </span>
                {selected && (
                  <span
                    className="absolute inset-x-0 bottom-0 h-[2px] bg-[var(--accent)]"
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select
            aria-label="Filter by queue"
            value={queueFilter}
            onChange={(e) => onQueueFilterChange(e.target.value)}
            className="w-[150px]"
          >
            <option value="">All queues</option>
            {availableQueues.map((q) => (
              <option key={q} value={q}>
                {q}
              </option>
            ))}
          </Select>

          <Select
            aria-label="Sort jobs"
            value={sortMode}
            onChange={(e) => onSortChange(e.target.value as SortMode)}
            className="w-[165px]"
          >
            <option value="default">Sort: active first</option>
            <option value="newest">Sort: newest first</option>
            <option value="oldest">Sort: oldest first</option>
            <option value="priority">Sort: highest priority</option>
            <option value="duration">Sort: longest duration</option>
          </Select>
        </div>

        <span className="font-mono text-[12px] tabular-nums text-[var(--muted)]">
          {jobs.length} {jobs.length === 1 ? "job" : "jobs"}
        </span>
      </div>

      {/* Empty state with guided starter actions */}
      {visible.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--control)] px-6 py-10 text-center">
          <p className="text-[14px] font-medium text-[var(--text)]">
            No matching jobs found
          </p>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Enqueue a task manually or spawn a 6-job demo batch to test retries and dead-letter recovery.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button variant="primary" size="md" onClick={onOpenEnqueue}>
              <IconPlus className="h-3.5 w-3.5" aria-hidden="true" />
              Enqueue job
            </Button>
            <Button variant="outline" size="md" onClick={onSpawnDemo}>
              Spawn 6 demo jobs
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* Desktop table: flat rules, no zebra striping, right-aligned tabular figures */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="text-[12px] font-normal text-[var(--muted)]">
                  <th className="py-2 pr-4 font-normal">Job</th>
                  <th className="py-2 px-3 font-normal">Queue</th>
                  <th className="py-2 px-3 font-normal">Status</th>
                  <th className="py-2 px-3 text-right font-normal">Attempts</th>
                  <th className="py-2 px-3 text-right font-normal">Duration</th>
                  <th className="py-2 px-3 text-right font-normal">Updated</th>
                  <th className="py-2 pl-3 text-right font-normal">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--rule)] border-t border-[var(--rule)]">
                {visible.map((job) => {
                  const rowBusy = busyJobId === job.id;
                  return (
                    <tr
                      key={job.id}
                      className="h-[52px] transition-colors hover:bg-[var(--raised)]/65"
                    >
                      <td className="py-2.5 pr-4 max-w-[340px]">
                        <button
                          type="button"
                          onClick={() => onInspect(job.id)}
                          className="block max-w-full text-left cursor-pointer group"
                        >
                          <div className="truncate text-[13px] font-medium text-[var(--text)] group-hover:text-[var(--accent)]">
                            {job.name}
                          </div>
                          <div className="mt-0.5 flex items-center gap-2 font-mono text-[11px] text-[var(--muted)]">
                            <span>{job.id}</span>
                            <span>·</span>
                            <span>{job.type}</span>
                            {job.status === "running" && (
                              <>
                                <span>·</span>
                                <span className="text-[var(--accent)] tabular-nums">
                                  {job.workerId} ({job.progress}%)
                                </span>
                              </>
                            )}
                          </div>
                          {job.lastError && job.status === "dead_letter" && (
                            <div className="mt-0.5 truncate text-[11px] text-[var(--negative)]">
                              {job.lastError}
                            </div>
                          )}
                        </button>
                      </td>

                      <td className="py-2.5 px-3">
                        <span className="font-mono text-[12px] text-[var(--muted)]">
                          {job.queue}
                        </span>
                      </td>

                      <td className="py-2.5 px-3">
                        <JobStatusBadge status={job.status} />
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-[12px] tabular-nums text-[var(--text)]">
                        {job.attempts}
                        <span className="text-[var(--muted)]">/{job.maxAttempts}</span>
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-[12px] tabular-nums text-[var(--muted)]">
                        {formatDurationMs(job.durationMs)}
                      </td>

                      <td className="py-2.5 px-3 text-right font-mono text-[12px] tabular-nums text-[var(--muted)] whitespace-nowrap">
                        {formatRelativeTime(job.updatedAt)}
                      </td>

                      <td className="py-2.5 pl-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onInspect(job.id)}
                          >
                            Logs
                          </Button>
                          {canRetry(job.status) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={rowBusy}
                              onClick={() => onRetry(job)}
                            >
                              <IconRetry className="h-3 w-3" aria-hidden="true" />
                              Retry
                            </Button>
                          )}
                          {canCancel(job.status) && (
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={rowBusy}
                              onClick={() => onCancel(job)}
                            >
                              Cancel
                            </Button>
                          )}
                          {job.status !== "running" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={rowBusy}
                              onClick={() => onRequestDelete(job)}
                              className="text-[var(--muted)] hover:text-[var(--negative)]"
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile responsive two-line rows (zero horizontal overflow) */}
          <div className="divide-y divide-[var(--rule)] border-t border-[var(--rule)] md:hidden">
            {visible.map((job) => {
              const rowBusy = busyJobId === job.id;
              return (
                <div key={job.id} className="py-3">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onInspect(job.id)}
                      className="min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <div className="truncate text-[13px] font-medium text-[var(--text)]">
                        {job.name}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-[var(--muted)]">
                        <span>{job.id}</span>
                        <span>· {job.queue}</span>
                        <span>
                          · {job.attempts}/{job.maxAttempts}
                        </span>
                        <span>· {formatDurationMs(job.durationMs)}</span>
                      </div>
                    </button>
                    <JobStatusBadge status={job.status} />
                  </div>

                  {job.lastError && job.status === "dead_letter" && (
                    <p className="mt-1.5 text-[12px] text-[var(--negative)] break-words">
                      {job.lastError}
                    </p>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => onInspect(job.id)}>
                      Inspect logs
                    </Button>
                    {canRetry(job.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => onRetry(job)}
                      >
                        Retry
                      </Button>
                    )}
                    {canCancel(job.status) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => onCancel(job)}
                      >
                        Cancel
                      </Button>
                    )}
                    {job.status !== "running" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={rowBusy}
                        onClick={() => onRequestDelete(job)}
                        className="text-[var(--negative)]"
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {typeof maxRows === "number" && jobs.length > maxRows && onViewAll && (
            <div className="mt-3 flex justify-end border-t border-[var(--rule)] pt-3">
              <Button variant="outline" size="sm" onClick={onViewAll}>
                View all {jobs.length} jobs
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
