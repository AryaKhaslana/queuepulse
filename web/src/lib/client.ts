import { BrowserSandboxEngine } from "./sandbox-engine";
import {
  ApiValidationError,
  type EnqueueInput,
  type FieldError,
  type Job,
  type JobDetail,
  type PoolStatus,
  type RuntimeMode,
  type Snapshot,
} from "./types";

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
  error?: {
    code: string;
    message: string;
    details?: FieldError[];
  };
}

export class QueuePulseClient {
  private mode: RuntimeMode = "browser-sandbox";
  private sandbox: BrowserSandboxEngine | null = null;
  private eventSource: EventSource | null = null;
  private latestSnapshot: Snapshot | null = null;
  private listeners = new Set<(snap: Snapshot, mode: RuntimeMode) => void>();
  private unsubSandbox: (() => void) | null = null;

  getMode(): RuntimeMode {
    return this.mode;
  }

  async init(): Promise<{ mode: RuntimeMode; snapshot: Snapshot }> {
    const goOnline = await this.probeGoApi();
    if (goOnline) {
      this.mode = "go-api";
      this.stopSandbox();
      const snapshot = await this.fetchGo<Snapshot>("/api/v1/snapshot");
      this.latestSnapshot = snapshot;
      this.connectSSE();
      this.notifyAll();
      return { mode: this.mode, snapshot };
    }

    this.mode = "browser-sandbox";
    this.disconnectSSE();
    if (!this.sandbox) {
      this.sandbox = new BrowserSandboxEngine();
    }
    this.sandbox.start();
    if (this.unsubSandbox) this.unsubSandbox();
    this.unsubSandbox = this.sandbox.subscribe((snap) => {
      this.latestSnapshot = snap;
      this.notifyAll();
    });
    return { mode: this.mode, snapshot: this.sandbox.getSnapshot() };
  }

  subscribe(fn: (snap: Snapshot, mode: RuntimeMode) => void): () => void {
    this.listeners.add(fn);
    if (this.latestSnapshot) {
      fn(this.latestSnapshot, this.mode);
    }
    return () => {
      this.listeners.delete(fn);
    };
  }

  destroy() {
    this.disconnectSSE();
    this.stopSandbox();
    this.listeners.clear();
  }

  private notifyAll() {
    if (!this.latestSnapshot) return;
    for (const fn of this.listeners) {
      fn(this.latestSnapshot, this.mode);
    }
  }

  private stopSandbox() {
    if (this.unsubSandbox) {
      this.unsubSandbox();
      this.unsubSandbox = null;
    }
    if (this.sandbox) {
      this.sandbox.stop();
    }
  }

  private async probeGoApi(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), 1400);
    try {
      const resp = await fetch("/api/v1/health", {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) return false;
      const body = (await resp.json()) as ApiEnvelope<{ status?: string }>;
      return Boolean(body.success && body.data?.status === "ok");
    } catch {
      return false;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private connectSSE() {
    this.disconnectSSE();
    const es = new EventSource("/api/v1/stream");
    this.eventSource = es;

    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as { type: string; data: unknown };
        if (parsed.type === "snapshot") {
          this.latestSnapshot = parsed.data as Snapshot;
          this.notifyAll();
          return;
        }
        if (!this.latestSnapshot) return;

        if (parsed.type === "pool.updated") {
          this.latestSnapshot = {
            ...this.latestSnapshot,
            pool: parsed.data as PoolStatus,
            updatedAt: new Date().toISOString(),
          };
          this.notifyAll();
        } else if (parsed.type === "metrics.updated") {
          this.latestSnapshot = {
            ...this.latestSnapshot,
            metrics: parsed.data as Snapshot["metrics"],
            updatedAt: new Date().toISOString(),
          };
          this.notifyAll();
        } else if (parsed.type === "job.updated") {
          const updated = parsed.data as Job;
          const exists = this.latestSnapshot.jobs.some((j) => j.id === updated.id);
          const jobs = exists
            ? this.latestSnapshot.jobs.map((j) => (j.id === updated.id ? updated : j))
            : [updated, ...this.latestSnapshot.jobs];
          this.latestSnapshot = {
            ...this.latestSnapshot,
            jobs,
            updatedAt: new Date().toISOString(),
          };
          this.notifyAll();
        } else if (parsed.type === "job.progress") {
          const prog = parsed.data as { jobId: string; workerId: string; progress: number };
          this.latestSnapshot = {
            ...this.latestSnapshot,
            jobs: this.latestSnapshot.jobs.map((j) =>
              j.id === prog.jobId ? { ...j, progress: prog.progress } : j
            ),
            pool: {
              ...this.latestSnapshot.pool,
              slots: this.latestSnapshot.pool.slots.map((s) =>
                s.id === prog.workerId ? { ...s, progress: prog.progress } : s
              ),
            },
          };
          this.notifyAll();
        } else if (parsed.type === "job.deleted") {
          const del = parsed.data as { id: string };
          this.latestSnapshot = {
            ...this.latestSnapshot,
            jobs: this.latestSnapshot.jobs.filter((j) => j.id !== del.id),
            updatedAt: new Date().toISOString(),
          };
          this.notifyAll();
        }
      } catch {
        // Ignore malformed SSE frames.
      }
    };
  }

  private disconnectSSE() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  private async fetchGo<T>(url: string, init?: RequestInit): Promise<T> {
    const resp = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
    if (resp.status === 204) {
      return undefined as T;
    }
    const body = (await resp.json()) as ApiEnvelope<T>;
    if (!resp.ok || !body.success) {
      if (resp.status === 422 && body.error?.details) {
        throw new ApiValidationError(body.error.message, body.error.details);
      }
      throw new Error(body.error?.message || `Request failed (${resp.status})`);
    }
    return body.data as T;
  }

  async enqueue(input: EnqueueInput): Promise<{ job: Job; replay: boolean }> {
    if (this.mode === "go-api") {
      const resp = await fetch("/api/v1/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await resp.json()) as ApiEnvelope<Job>;
      if (!resp.ok || !body.success) {
        if (resp.status === 422 && body.error?.details) {
          throw new ApiValidationError(body.error.message, body.error.details);
        }
        throw new Error(body.error?.message || "Failed to enqueue job");
      }
      return {
        job: body.data as Job,
        replay: resp.headers.get("X-Idempotent-Replay") === "true",
      };
    }
    return this.sandbox!.enqueue(input);
  }

  async spawnDemoBatch(): Promise<Job[]> {
    if (this.mode === "go-api") {
      return this.fetchGo<Job[]>("/api/v1/jobs/demo", { method: "POST" });
    }
    return this.sandbox!.spawnDemoBatch();
  }

  async getJobDetail(id: string): Promise<JobDetail> {
    if (this.mode === "go-api") {
      return this.fetchGo<JobDetail>(`/api/v1/jobs/${encodeURIComponent(id)}`);
    }
    return this.sandbox!.getJobDetail(id);
  }

  async retryJob(id: string): Promise<Job> {
    if (this.mode === "go-api") {
      return this.fetchGo<Job>(`/api/v1/jobs/${encodeURIComponent(id)}/retry`, {
        method: "POST",
      });
    }
    return this.sandbox!.retryJob(id);
  }

  async retryAllDeadLetters(): Promise<number> {
    if (this.mode === "go-api") {
      const res = await this.fetchGo<{ requeued: number }>(
        "/api/v1/jobs/retry-dead-letters",
        { method: "POST" }
      );
      return res.requeued;
    }
    return this.sandbox!.retryAllDeadLetters();
  }

  async cancelJob(id: string): Promise<Job> {
    if (this.mode === "go-api") {
      return this.fetchGo<Job>(`/api/v1/jobs/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      });
    }
    return this.sandbox!.cancelJob(id);
  }

  async deleteJob(id: string): Promise<void> {
    if (this.mode === "go-api") {
      await this.fetchGo<void>(`/api/v1/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return;
    }
    this.sandbox!.deleteJob(id);
  }

  async purgeCompleted(): Promise<number> {
    if (this.mode === "go-api") {
      const res = await this.fetchGo<{ purged: number }>("/api/v1/jobs/completed", {
        method: "DELETE",
      });
      return res.purged;
    }
    return this.sandbox!.purgeCompleted();
  }

  async setPaused(paused: boolean): Promise<PoolStatus> {
    if (this.mode === "go-api") {
      return this.fetchGo<PoolStatus>(
        paused ? "/api/v1/pool/pause" : "/api/v1/pool/resume",
        { method: "POST" }
      );
    }
    return this.sandbox!.setPaused(paused);
  }

  async setConcurrency(concurrency: number): Promise<PoolStatus> {
    if (this.mode === "go-api") {
      return this.fetchGo<PoolStatus>("/api/v1/pool/concurrency", {
        method: "PATCH",
        body: JSON.stringify({ concurrency }),
      });
    }
    return this.sandbox!.setConcurrency(concurrency);
  }
}

export const queueClient = new QueuePulseClient();
