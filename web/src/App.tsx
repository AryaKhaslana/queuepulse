import * as React from "react";
import { queueClient } from "@/lib/client";
import { formatDurationMs } from "@/lib/utils";
import type {
  EnqueueInput,
  Job,
  JobDetail,
  RuntimeMode,
  Snapshot,
} from "@/lib/types";
import { Shell, type NavSection } from "@/components/shell";
import { WorkerStrip } from "@/components/worker-strip";
import { ThroughputChart } from "@/components/throughput-chart";
import {
  JobsTable,
  type SortMode,
  type StatusTab,
} from "@/components/jobs-table";
import { JobDrawer } from "@/components/job-drawer";
import { EnqueueDialog } from "@/components/enqueue-dialog";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconRetry } from "@/components/icons";

interface Notice {
  id: number;
  tone: "info" | "positive" | "negative";
  text: string;
}

export function App() {
  const [snapshot, setSnapshot] = React.useState<Snapshot | null>(null);
  const [runtimeMode, setRuntimeMode] = React.useState<RuntimeMode>("browser-sandbox");
  const [loadingInit, setLoadingInit] = React.useState(true);
  const [initError, setInitError] = React.useState<string | null>(null);

  const [activeNav, setActiveNav] = React.useState<NavSection>("overview");
  const [statusTab, setStatusTab] = React.useState<StatusTab>("all");
  const [queueFilter, setQueueFilter] = React.useState("");
  const [sortMode, setSortMode] = React.useState<SortMode>("default");
  const [searchQuery, setSearchQuery] = React.useState("");

  const [enqueueOpen, setEnqueueOpen] = React.useState(false);
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null);
  const [jobDetail, setJobDetail] = React.useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [detailError, setDetailError] = React.useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = React.useState<Job | null>(null);
  const [purgeConfirmOpen, setPurgeConfirmOpen] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState(false);
  const [busyJobId, setBusyJobId] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const [darkMode, setDarkMode] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem("queuepulse_theme") === "dark";
    } catch {
      return false;
    }
  });

  const searchInputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    try {
      window.localStorage.setItem("queuepulse_theme", darkMode ? "dark" : "light");
    } catch {
      // Ignore storage failures.
    }
  }, [darkMode]);

  const showNotice = React.useCallback((tone: Notice["tone"], text: string) => {
    const id = Date.now();
    setNotice({ id, tone, text });
    window.setTimeout(() => {
      setNotice((curr) => (curr && curr.id === id ? null : curr));
    }, 3600);
  }, []);

  const bootClient = React.useCallback(async () => {
    setLoadingInit(true);
    setInitError(null);
    try {
      const res = await queueClient.init();
      setRuntimeMode(res.mode);
      setSnapshot(res.snapshot);
    } catch (err) {
      setInitError(
        err instanceof Error ? err.message : "Failed to initialize QueuePulse engine."
      );
    } finally {
      setLoadingInit(false);
    }
  }, []);

  React.useEffect(() => {
    void bootClient();
    const unsub = queueClient.subscribe((snap, mode) => {
      setSnapshot(snap);
      setRuntimeMode(mode);
    });
    return () => {
      unsub();
      queueClient.destroy();
    };
  }, [bootClient]);

  // Refresh selected job detail whenever live snapshot changes
  React.useEffect(() => {
    if (!selectedJobId) {
      setJobDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    queueClient
      .getJobDetail(selectedJobId)
      .then((d) => {
        if (!cancelled) setJobDetail(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setDetailError(err instanceof Error ? err.message : "Could not load job logs");
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedJobId, snapshot?.updatedAt]);

  // Keyboard shortcuts: "/" focuses search, "n" opens enqueue dialog
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inInput =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (inInput) return;
      if (e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "n" && !enqueueOpen && !selectedJobId) {
        e.preventDefault();
        setEnqueueOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enqueueOpen, selectedJobId]);

  const allJobs = snapshot?.jobs ?? [];
  const metrics = snapshot?.metrics;
  const pool = snapshot?.pool;

  // Derived filtered + sorted jobs list
  const filteredJobs = React.useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const effectiveTab: StatusTab = activeNav === "dlq" ? "dead_letter" : statusTab;

    const list = allJobs.filter((job) => {
      if (effectiveTab === "active" && job.status !== "running" && job.status !== "retrying") {
        return false;
      }
      if (effectiveTab === "queued" && job.status !== "queued") return false;
      if (effectiveTab === "completed" && job.status !== "completed") return false;
      if (effectiveTab === "dead_letter" && job.status !== "dead_letter") return false;
      if (queueFilter && job.queue !== queueFilter) return false;
      if (q) {
        const hay = `${job.name} ${job.id} ${job.queue} ${job.type} ${job.lastError || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (sortMode === "newest") {
      return [...list].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
    }
    if (sortMode === "oldest") {
      return [...list].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }
    if (sortMode === "priority") {
      return [...list].sort((a, b) => b.priority - a.priority);
    }
    if (sortMode === "duration") {
      return [...list].sort((a, b) => b.durationMs - a.durationMs);
    }
    return list;
  }, [allJobs, activeNav, statusTab, queueFilter, searchQuery, sortMode]);

  const tabCounts = React.useMemo(() => {
    let active = 0;
    let queued = 0;
    let completed = 0;
    let dead_letter = 0;
    for (const j of allJobs) {
      if (j.status === "running" || j.status === "retrying") active++;
      else if (j.status === "queued") queued++;
      else if (j.status === "completed") completed++;
      else if (j.status === "dead_letter") dead_letter++;
    }
    return {
      all: allJobs.length,
      active,
      queued,
      completed,
      dead_letter,
    };
  }, [allJobs]);

  const handleEnqueue = async (input: EnqueueInput) => {
    const res = await queueClient.enqueue(input);
    if (res.replay) {
      showNotice("info", `Idempotency key matched existing job ${res.job.id}.`);
    } else {
      showNotice("positive", `Enqueued "${res.job.name}" (${res.job.id}).`);
    }
  };

  const handleSpawnDemo = async () => {
    setBusyAction(true);
    try {
      const created = await queueClient.spawnDemoBatch();
      showNotice("positive", `Spawned ${created.length} demo jobs across 4 queues.`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Failed to spawn demo batch.");
    } finally {
      setBusyAction(false);
    }
  };

  const handleTogglePause = async () => {
    if (!pool) return;
    setBusyAction(true);
    try {
      const next = await queueClient.setPaused(!pool.paused);
      showNotice("info", next.paused ? "Worker pool paused." : "Worker pool resumed.");
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Could not update pool state.");
    } finally {
      setBusyAction(false);
    }
  };

  const handleChangeConcurrency = async (next: number) => {
    setBusyAction(true);
    try {
      const st = await queueClient.setConcurrency(next);
      showNotice("info", `Worker concurrency updated to ${st.concurrency} slots.`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Could not change concurrency.");
    } finally {
      setBusyAction(false);
    }
  };

  const handleRetryJob = async (job: Job) => {
    setBusyJobId(job.id);
    try {
      await queueClient.retryJob(job.id);
      showNotice("positive", `Re-queued "${job.name}".`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Failed to re-queue job.");
    } finally {
      setBusyJobId(null);
    }
  };

  const handleRetryAllDLQ = async () => {
    setBusyAction(true);
    try {
      const n = await queueClient.retryAllDeadLetters();
      showNotice(
        n > 0 ? "positive" : "info",
        n > 0 ? `Re-queued ${n} dead-letter jobs.` : "Dead-letter queue is already empty."
      );
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Bulk replay failed.");
    } finally {
      setBusyAction(false);
    }
  };

  const handleCancelJob = async (job: Job) => {
    setBusyJobId(job.id);
    try {
      await queueClient.cancelJob(job.id);
      showNotice("info", `Cancelled "${job.name}".`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Failed to cancel job.");
    } finally {
      setBusyJobId(null);
    }
  };

  const handleDeleteJob = async (job: Job) => {
    setBusyJobId(job.id);
    try {
      await queueClient.deleteJob(job.id);
      setDeleteTarget(null);
      if (selectedJobId === job.id) setSelectedJobId(null);
      showNotice("info", `Deleted ${job.id}.`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Failed to delete job.");
    } finally {
      setBusyJobId(null);
    }
  };

  const handlePurgeCompleted = async () => {
    setBusyAction(true);
    try {
      const n = await queueClient.purgeCompleted();
      setPurgeConfirmOpen(false);
      showNotice("info", `Purged ${n} completed and cancelled jobs.`);
    } catch (err) {
      showNotice("negative", err instanceof Error ? err.message : "Purge failed.");
    } finally {
      setBusyAction(false);
    }
  };

  // Single most important live finding for the screen's one question
  const liveFinding: {
    tone: "negative" | "warning" | "neutral" | "positive";
    headline: string;
    detail: string;
    actionLabel: string;
    onAction: () => void;
  } | null = (() => {
    if (!metrics || !pool) return null;
    if (metrics.deadLetter > 0) {
      return {
        tone: "negative",
        headline: `${metrics.deadLetter} ${metrics.deadLetter === 1 ? "job requires" : "jobs require"} attention in Dead-Letter Queue`,
        detail: "Retries exhausted after exponential backoff. Inspect failure logs or replay the batch.",
        actionLabel: "Open dead-letter queue",
        onAction: () => {
          setActiveNav("dlq");
        },
      };
    }
    if (pool.paused) {
      return {
        tone: "warning",
        headline: `Worker pool is paused with ${metrics.queued + metrics.retrying} pending jobs`,
        detail: "No jobs will be claimed until you resume the pool.",
        actionLabel: "Resume pool",
        onAction: () => {
          void handleTogglePause();
        },
      };
    }
    if (metrics.total === 0) {
      return {
        tone: "neutral",
        headline: "Queue is idle with zero jobs persisted",
        detail: "Spawn a demo batch or enqueue a local webhook, media probe, or simulated task.",
        actionLabel: "Spawn 6 demo jobs",
        onAction: () => {
          void handleSpawnDemo();
        },
      };
    }
    return {
      tone: "positive",
      headline:
        metrics.running > 0
          ? `Draining smoothly: ${metrics.running} running, ${metrics.queued + metrics.retrying} pending`
          : `All ${metrics.completed} jobs completed with zero dead letters`,
      detail:
        metrics.avgDurationMs > 0
          ? `Average completion time is ${formatDurationMs(metrics.avgDurationMs)} across ${pool.concurrency} worker slots.`
          : `Ready across ${pool.concurrency} configured worker slots.`,
      actionLabel: "Enqueue job",
      onAction: () => {
        setEnqueueOpen(true);
      },
    };
  })();

  return (
    <Shell
      activeNav={activeNav}
      onSelectNav={(nav) => {
        setActiveNav(nav);
        if (nav === "jobs") setStatusTab("all");
      }}
      deadLetterCount={metrics?.deadLetter ?? 0}
      activeCount={(metrics?.running ?? 0) + (metrics?.queued ?? 0) + (metrics?.retrying ?? 0)}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      searchInputRef={searchInputRef}
      runtimeMode={runtimeMode}
      darkMode={darkMode}
      onToggleTheme={() => setDarkMode((d) => !d)}
    >
      {/* Inline status notice toast */}
      {notice && (
        <div
          role="status"
          aria-live="polite"
          className={`mb-4 flex items-center justify-between gap-3 rounded-[6px] border px-3.5 py-2 text-[13px] ${
            notice.tone === "negative"
              ? "border-[var(--negative)]/35 bg-[var(--pill-negative-bg)] text-[var(--pill-negative-ink)]"
              : notice.tone === "positive"
                ? "border-[var(--positive)]/35 bg-[var(--pill-positive-bg)] text-[var(--pill-positive-ink)]"
                : "border-[var(--border)] bg-[var(--raised)] text-[var(--text)]"
          }`}
        >
          <span>{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-[12px] underline opacity-80 hover:opacity-100 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Initial loading / error states */}
      {loadingInit && !snapshot ? (
        <div className="py-16 text-center">
          <p className="text-[14px] font-medium text-[var(--text)]">
            Connecting to QueuePulse engine...
          </p>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Probing local Go server and initializing worker pool state.
          </p>
        </div>
      ) : initError || !snapshot || !metrics || !pool ? (
        <div className="rounded-[8px] border border-[var(--negative)]/35 bg-[var(--pill-negative-bg)] p-5">
          <h1 className="text-[16px] font-semibold text-[var(--pill-negative-ink)]">
            Could not start QueuePulse dashboard
          </h1>
          <p className="mt-1 text-[13px] text-[var(--pill-negative-ink)]">
            {initError || "Unexpected initialization failure."}
          </p>
          <Button variant="outline" size="md" className="mt-3" onClick={() => void bootClient()}>
            Retry connection
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {/* OVERVIEW SCREEN */}
          {activeNav === "overview" && (
            <>
              {/* Title row + one finding + primary actions */}
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h1 className="text-[22px] font-semibold tracking-[-0.02em] leading-tight">
                      QueuePulse
                    </h1>
                    <Badge
                      tone={
                        metrics.deadLetter > 0
                          ? "negative"
                          : pool.paused
                            ? "warning"
                            : "positive"
                      }
                    >
                      {metrics.deadLetter > 0
                        ? "Degraded"
                        : pool.paused
                          ? "Paused"
                          : "Healthy"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-[13px] text-[var(--muted)]">
                    {liveFinding?.headline}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="lg"
                    disabled={busyAction}
                    onClick={() => void handleSpawnDemo()}
                  >
                    Spawn 6 demo jobs
                  </Button>
                  <Button
                    variant="primary"
                    size="lg"
                    onClick={() => setEnqueueOpen(true)}
                  >
                    <IconPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    Enqueue job
                  </Button>
                </div>
              </div>

              {/* Signature element: Live Worker Slot Strip */}
              <WorkerStrip
                pool={pool}
                busyAction={busyAction}
                onTogglePause={() => void handleTogglePause()}
                onChangeConcurrency={(n) => void handleChangeConcurrency(n)}
                onInspectJob={(id) => setSelectedJobId(id)}
              />

              {/* Divided Health KPI strip: flat, type-first, real reconciled totals */}
              <section
                aria-label="Queue health summary"
                className="grid grid-cols-2 divide-y divide-[var(--rule)] rounded-[8px] border border-[var(--border)] bg-[var(--surface)] sm:grid-cols-4 sm:divide-x sm:divide-y-0"
              >
                <div className="px-4 py-3.5">
                  <div className="text-[12px] font-medium text-[var(--muted)]">
                    Active &amp; pending
                  </div>
                  <div className="mt-1 text-[28px] font-normal leading-none tabular-nums text-[var(--text)]">
                    {metrics.running + metrics.queued + metrics.retrying}
                  </div>
                  <div className="mt-1.5 text-[12px] tabular-nums text-[var(--muted)]">
                    {metrics.running} running · {metrics.retrying} retrying
                  </div>
                </div>

                <div className="px-4 py-3.5">
                  <div className="text-[12px] font-medium text-[var(--muted)]">
                    Completed
                  </div>
                  <div className="mt-1 text-[28px] font-normal leading-none tabular-nums text-[var(--text)]">
                    {metrics.completed}
                  </div>
                  <div className="mt-1.5 text-[12px] tabular-nums text-[var(--muted)]">
                    of {metrics.total} total jobs
                  </div>
                </div>

                <div className="px-4 py-3.5">
                  <div className="text-[12px] font-medium text-[var(--muted)]">
                    Dead-letter queue
                  </div>
                  <div
                    className={`mt-1 text-[28px] font-normal leading-none tabular-nums ${
                      metrics.deadLetter > 0 ? "text-[var(--negative)]" : "text-[var(--text)]"
                    }`}
                  >
                    {metrics.deadLetter}
                  </div>
                  <div className="mt-1.5 text-[12px] text-[var(--muted)]">
                    {metrics.deadLetter > 0 ? "Needs manual replay" : "Zero failed batches"}
                  </div>
                </div>

                <div className="px-4 py-3.5">
                  <div className="text-[12px] font-medium text-[var(--muted)]">
                    Success rate
                  </div>
                  <div className="mt-1 text-[28px] font-normal leading-none tabular-nums text-[var(--text)]">
                    {metrics.successRatePct !== null ? `${metrics.successRatePct.toFixed(1)}%` : "-"}
                  </div>
                  <div className="mt-1.5 text-[12px] tabular-nums text-[var(--muted)]">
                    Avg {formatDurationMs(metrics.avgDurationMs)}
                  </div>
                </div>
              </section>

              {/* Two-column row: 2/3 throughput chart + 1/3 diagnostic finding card */}
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <ThroughputChart points={metrics.throughput} />
                </div>

                <div className="flex flex-col justify-between rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-4">
                  <div>
                    <div className="text-[12px] font-medium text-[var(--muted)]">
                      Operational signal
                    </div>
                    <h2 className="mt-1 text-[15px] font-semibold leading-snug text-[var(--text)]">
                      {liveFinding?.headline}
                    </h2>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--muted)]">
                      {liveFinding?.detail}
                    </p>
                  </div>

                  <div className="mt-4 pt-3 border-t border-[var(--rule)] flex flex-wrap items-center gap-2">
                    {liveFinding && (
                      <Button
                        variant={liveFinding.tone === "negative" ? "danger" : "outline"}
                        size="sm"
                        onClick={liveFinding.onAction}
                      >
                        {liveFinding.actionLabel}
                      </Button>
                    )}
                    {metrics.deadLetter > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyAction}
                        onClick={() => void handleRetryAllDLQ()}
                      >
                        <IconRetry className="h-3 w-3" aria-hidden="true" />
                        Replay all DLQ
                      </Button>
                    )}
                  </div>
                </div>
              </div>

              {/* Recent Jobs Table (capped at 6 rows on Overview) */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <h2 className="text-[16px] font-semibold">Recent jobs</h2>
                </div>
                <JobsTable
                  jobs={filteredJobs}
                  activeTab={statusTab}
                  onTabChange={setStatusTab}
                  queueFilter={queueFilter}
                  onQueueFilterChange={setQueueFilter}
                  availableQueues={metrics.activeQueues}
                  sortMode={sortMode}
                  onSortChange={setSortMode}
                  counts={tabCounts}
                  maxRows={6}
                  onViewAll={() => setActiveNav("jobs")}
                  onInspect={(id) => setSelectedJobId(id)}
                  onRetry={(j) => void handleRetryJob(j)}
                  onCancel={(j) => void handleCancelJob(j)}
                  onRequestDelete={(j) => setDeleteTarget(j)}
                  onOpenEnqueue={() => setEnqueueOpen(true)}
                  onSpawnDemo={() => void handleSpawnDemo()}
                  busyJobId={busyJobId}
                />
              </div>
            </>
          )}

          {/* FULL JOBS QUEUE SCREEN */}
          {activeNav === "jobs" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                    Jobs queue
                  </h1>
                  <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                    Inspect logs, retry failed runs, or cancel queued work in real time.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {metrics.completed + metrics.cancelled > 0 && (
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => setPurgeConfirmOpen(true)}
                    >
                      Purge finished ({metrics.completed + metrics.cancelled})
                    </Button>
                  )}
                  <Button variant="primary" size="md" onClick={() => setEnqueueOpen(true)}>
                    <IconPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    Enqueue job
                  </Button>
                </div>
              </div>

              <JobsTable
                jobs={filteredJobs}
                activeTab={statusTab}
                onTabChange={setStatusTab}
                queueFilter={queueFilter}
                onQueueFilterChange={setQueueFilter}
                availableQueues={metrics.activeQueues}
                sortMode={sortMode}
                onSortChange={setSortMode}
                counts={tabCounts}
                onInspect={(id) => setSelectedJobId(id)}
                onRetry={(j) => void handleRetryJob(j)}
                onCancel={(j) => void handleCancelJob(j)}
                onRequestDelete={(j) => setDeleteTarget(j)}
                onOpenEnqueue={() => setEnqueueOpen(true)}
                onSpawnDemo={() => void handleSpawnDemo()}
                busyJobId={busyJobId}
              />
            </>
          )}

          {/* DEAD-LETTER QUEUE SCREEN */}
          {activeNav === "dlq" && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                    Dead-letter queue
                  </h1>
                  <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                    Jobs that exhausted all retry attempts stay quarantined here until replayed or deleted.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="accent"
                    size="md"
                    disabled={busyAction || metrics.deadLetter === 0}
                    onClick={() => void handleRetryAllDLQ()}
                  >
                    <IconRetry className="h-3.5 w-3.5" aria-hidden="true" />
                    Replay all ({metrics.deadLetter})
                  </Button>
                </div>
              </div>

              <JobsTable
                jobs={filteredJobs}
                activeTab="dead_letter"
                onTabChange={() => {}}
                queueFilter={queueFilter}
                onQueueFilterChange={setQueueFilter}
                availableQueues={metrics.activeQueues}
                sortMode={sortMode}
                onSortChange={setSortMode}
                counts={tabCounts}
                showTabs={false}
                onInspect={(id) => setSelectedJobId(id)}
                onRetry={(j) => void handleRetryJob(j)}
                onCancel={(j) => void handleCancelJob(j)}
                onRequestDelete={(j) => setDeleteTarget(j)}
                onOpenEnqueue={() => setEnqueueOpen(true)}
                onSpawnDemo={() => void handleSpawnDemo()}
                busyJobId={busyJobId}
              />
            </>
          )}

          {/* POOL & RUNTIME SETTINGS SCREEN */}
          {activeNav === "settings" && (
            <div className="space-y-6 max-w-[760px]">
              <div>
                <h1 className="text-[22px] font-semibold tracking-[-0.02em]">
                  Pool &amp; runtime
                </h1>
                <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                  Manage local Go server connectivity, worker concurrency, and queue retention.
                </p>
              </div>

              <div className="rounded-[8px] border border-[var(--border)] divide-y divide-[var(--rule)]">
                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <div className="text-[14px] font-semibold">Active execution runtime</div>
                    <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                      {pool.runtime}.{" "}
                      {runtimeMode === "go-api"
                        ? "Live Server-Sent Events stream is connected."
                        : "Start the local Go binary to switch from Browser Sandbox to SQLite WAL."}
                    </p>
                  </div>
                  <Button variant="outline" size="md" onClick={() => void bootClient()}>
                    Probe Go API
                  </Button>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <div className="text-[14px] font-semibold">Worker concurrency</div>
                    <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                      Limit simultaneous tasks to keep CPU and thermal load predictable (1 to 8 slots).
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction || pool.concurrency <= pool.minWorkers}
                      onClick={() => void handleChangeConcurrency(pool.concurrency - 1)}
                    >
                      -
                    </Button>
                    <span className="min-w-[64px] text-center font-mono text-[13px] tabular-nums">
                      {pool.concurrency} slots
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyAction || pool.concurrency >= pool.maxWorkers}
                      onClick={() => void handleChangeConcurrency(pool.concurrency + 1)}
                    >
                      +
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-4 p-4">
                  <div>
                    <div className="text-[14px] font-semibold">Purge finished jobs</div>
                    <p className="mt-0.5 text-[13px] text-[var(--muted)]">
                      Remove {metrics.completed + metrics.cancelled} completed and cancelled jobs while keeping queued and dead-letter records intact.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="md"
                    disabled={busyAction || metrics.completed + metrics.cancelled === 0}
                    onClick={() => setPurgeConfirmOpen(true)}
                  >
                    Purge finished
                  </Button>
                </div>
              </div>

              {/* Local self-hosting guide */}
              <div className="rounded-[8px] border border-[var(--border)] bg-[var(--raised)]/60 p-4">
                <h2 className="text-[14px] font-semibold">Run native Go + SQLite engine locally</h2>
                <p className="mt-1 text-[13px] text-[var(--muted)]">
                  Clone the repository to execute real ffprobe media inspection, native HTTP webhooks without browser CORS limits, and SQLite WAL durability in a single binary.
                </p>
                <pre className="mt-3 overflow-x-auto rounded-[6px] border border-[var(--border)] bg-[var(--surface)] p-3 font-mono text-[12px] text-[var(--text)]">
{`git clone https://github.com/AryaKhaslana/queuepulse.git
cd queuepulse
make run   # serves Go API + embedded React UI at http://localhost:8080`}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Enqueue Modal */}
      <EnqueueDialog
        open={enqueueOpen}
        onClose={() => setEnqueueOpen(false)}
        onSubmit={handleEnqueue}
      />

      {/* Slide-over Job Detail Inspector */}
      <JobDrawer
        jobId={selectedJobId}
        detail={jobDetail}
        loading={detailLoading}
        error={detailError}
        onClose={() => setSelectedJobId(null)}
        onRetry={(j) => void handleRetryJob(j)}
        onCancel={(j) => void handleCancelJob(j)}
        onDeleteConfirmed={(j) => void handleDeleteJob(j)}
        busy={busyJobId === selectedJobId}
      />

      {/* Destructive confirmation modal for table delete */}
      <Dialog
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Delete job permanently"
        description={
          deleteTarget
            ? `This removes "${deleteTarget.name}" (${deleteTarget.id}) and its execution logs.`
            : undefined
        }
        maxWidthClass="max-w-[420px]"
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="md" onClick={() => setDeleteTarget(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={Boolean(deleteTarget && busyJobId === deleteTarget.id)}
            onClick={() => deleteTarget && void handleDeleteJob(deleteTarget)}
          >
            Delete permanently
          </Button>
        </div>
      </Dialog>

      {/* Destructive confirmation modal for bulk purge */}
      <Dialog
        open={purgeConfirmOpen}
        onClose={() => setPurgeConfirmOpen(false)}
        title="Purge finished jobs"
        description={`Remove ${(metrics?.completed ?? 0) + (metrics?.cancelled ?? 0)} completed and cancelled jobs permanently. Queued, running, retrying, and dead-letter jobs are preserved.`}
        maxWidthClass="max-w-[440px]"
      >
        <div className="flex items-center justify-end gap-2 pt-2">
          <Button variant="outline" size="md" onClick={() => setPurgeConfirmOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="md"
            disabled={busyAction}
            onClick={() => void handlePurgeCompleted()}
          >
            Purge finished jobs
          </Button>
        </div>
      </Dialog>
    </Shell>
  );
}
