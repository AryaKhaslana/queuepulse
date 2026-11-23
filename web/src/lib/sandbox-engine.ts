import {
  ApiValidationError,
  type EnqueueInput,
  type FieldError,
  type Job,
  type JobDetail,
  type JobLog,
  type JobStatus,
  type JobType,
  type PoolStatus,
  type QueueMetrics,
  type Snapshot,
  type ThroughputPoint,
  type WorkerSlot,
} from "./types";

const STORAGE_KEY = "queuepulse_sandbox_v1";
const MIN_WORKERS = 1;
const MAX_WORKERS = 8;

interface PersistedState {
  initialized: boolean;
  concurrency: number;
  paused: boolean;
  jobs: Job[];
  logs: Record<string, JobLog[]>;
  buckets: Record<number, { completed: number; failed: number }>;
  nextLogId: number;
}

type Listener = (snapshot: Snapshot) => void;

function nowISO(): string {
  return new Date().toISOString();
}

function minuteBucket(ms = Date.now()): number {
  return Math.floor(ms / 60000) * 60;
}

function makeJobId(): string {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return (
    "job_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

const VALID_TYPES: JobType[] = [
  "simulate_work",
  "http_webhook",
  "media_probe",
  "system_check",
];

export function validateEnqueueInput(input: EnqueueInput): EnqueueInput {
  const errors: FieldError[] = [];
  const name = (input.name ?? "").trim();
  const queue = (input.queue ?? "").trim() || "default";
  const idempotencyKey = (input.idempotencyKey ?? "").trim();

  if (!name) {
    errors.push({ field: "name", issue: "Job name is required" });
  } else if (name.length > 120) {
    errors.push({ field: "name", issue: "Job name must be at most 120 characters" });
  }

  if (queue.length > 48) {
    errors.push({ field: "queue", issue: "Queue name must be at most 48 characters" });
  }

  if (!VALID_TYPES.includes(input.type)) {
    errors.push({
      field: "type",
      issue: "Type must be simulate_work, http_webhook, media_probe, or system_check",
    });
  }

  const priority = Number.isFinite(input.priority) ? Math.round(input.priority) : 5;
  if (priority < 0 || priority > 10) {
    errors.push({ field: "priority", issue: "Priority must be between 0 and 10" });
  }

  const maxAttempts = input.maxAttempts || 3;
  if (maxAttempts < 1 || maxAttempts > 10) {
    errors.push({ field: "maxAttempts", issue: "Max attempts must be between 1 and 10" });
  }

  const backoffMs = input.backoffMs || 1500;
  if (backoffMs < 200 || backoffMs > 60000) {
    errors.push({ field: "backoffMs", issue: "Backoff must be between 200ms and 60000ms" });
  }

  const timeoutMs = input.timeoutMs || 15000;
  if (timeoutMs < 500 || timeoutMs > 120000) {
    errors.push({ field: "timeoutMs", issue: "Timeout must be between 500ms and 120000ms" });
  }

  const delayMs = input.delayMs ?? 0;
  if (delayMs < 0 || delayMs > 3600000) {
    errors.push({ field: "delayMs", issue: "Delay must be between 0ms and 3600000ms" });
  }

  if (input.type === "http_webhook") {
    const rawUrl = String(input.payload?.url ?? "").trim();
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        errors.push({ field: "payload", issue: "Webhook URL must start with http:// or https://" });
      }
    } catch {
      errors.push({ field: "payload", issue: "Webhook payload requires a valid http(s) url" });
    }
  }

  if (input.type === "media_probe") {
    const p = String(input.payload?.path ?? "").trim();
    if (!p) {
      errors.push({ field: "payload", issue: "Media probe payload requires a file path" });
    }
  }

  if (errors.length > 0) {
    throw new ApiValidationError("Invalid request payload", errors);
  }

  return {
    name,
    queue,
    type: input.type,
    priority,
    payload: input.payload ?? {},
    maxAttempts,
    backoffMs,
    timeoutMs,
    delayMs,
    idempotencyKey,
  };
}

export class BrowserSandboxEngine {
  private state: PersistedState;
  private slots: WorkerSlot[] = [];
  private controllers = new Map<string, AbortController>();
  private listeners = new Set<Listener>();
  private timer: number | null = null;
  private startedAt = Date.now();

  constructor() {
    this.state = this.loadState();
    // Recover any interrupted "running" jobs after tab reload (same semantics as Go engine).
    let recovered = false;
    for (const job of this.state.jobs) {
      if (job.status === "running") {
        job.status = "queued";
        job.workerId = undefined;
        job.progress = 0;
        job.runAt = nowISO();
        job.updatedAt = nowISO();
        this.pushLog(job.id, "warn", "Recovered interrupted job back to queued after reload");
        recovered = true;
      }
    }
    if (recovered) {
      this.saveState();
    }

    this.rebuildSlots();
    if (!this.state.initialized) {
      this.state.initialized = true;
      this.spawnStarterDemo();
    }
  }

  start() {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => {
      this.tick();
    }, 220);
  }

  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    for (const ctrl of this.controllers.values()) {
      ctrl.abort();
    }
    this.controllers.clear();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.getSnapshot());
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit() {
    const snap = this.getSnapshot();
    for (const fn of this.listeners) {
      fn(snap);
    }
  }

  private loadState(): PersistedState {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedState;
        if (parsed && Array.isArray(parsed.jobs)) {
          return {
            initialized: Boolean(parsed.initialized),
            concurrency: Math.min(MAX_WORKERS, Math.max(MIN_WORKERS, parsed.concurrency || 3)),
            paused: Boolean(parsed.paused),
            jobs: parsed.jobs,
            logs: parsed.logs || {},
            buckets: parsed.buckets || {},
            nextLogId: parsed.nextLogId || 1,
          };
        }
      }
    } catch {
      // Fall back to fresh state if localStorage is unavailable or malformed.
    }
    return {
      initialized: false,
      concurrency: 3,
      paused: false,
      jobs: [],
      logs: {},
      buckets: {},
      nextLogId: 1,
    };
  }

  private saveState() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Ignore storage quota errors in private browsing mode.
    }
  }

  private rebuildSlots() {
    const next: WorkerSlot[] = [];
    for (let i = 1; i <= this.state.concurrency; i++) {
      const id = `W-${String(i).padStart(2, "0")}`;
      const existing = this.slots.find((s) => s.id === id);
      if (existing) {
        if (existing.state !== "busy") {
          existing.state = this.state.paused ? "paused" : "idle";
        }
        next.push(existing);
      } else {
        next.push({
          id,
          state: this.state.paused ? "paused" : "idle",
          progress: 0,
          processed: 0,
          failed: 0,
        });
      }
    }
    this.slots = next;
  }

  private pushLog(jobId: string, level: JobLog["level"], message: string) {
    if (!this.state.logs[jobId]) {
      this.state.logs[jobId] = [];
    }
    this.state.logs[jobId].push({
      id: this.state.nextLogId++,
      jobId,
      level,
      message,
      createdAt: nowISO(),
    });
  }

  private recordBucket(outcome: "completed" | "failed") {
    const b = minuteBucket();
    if (!this.state.buckets[b]) {
      this.state.buckets[b] = { completed: 0, failed: 0 };
    }
    this.state.buckets[b][outcome] += 1;
  }

  private spawnStarterDemo() {
    const starter: EnqueueInput[] = [
      {
        name: "Transcode reel 720p H.264",
        queue: "media",
        type: "simulate_work",
        priority: 8,
        maxAttempts: 3,
        backoffMs: 1100,
        timeoutMs: 15000,
        payload: { durationMs: 2400, steps: 6 },
      },
      {
        name: "Export catalog PDF batch #14",
        queue: "documents",
        type: "simulate_work",
        priority: 7,
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 15000,
        payload: { durationMs: 1900, steps: 5 },
      },
      {
        name: "Deliver partner webhook (flaky retry)",
        queue: "webhooks",
        type: "simulate_work",
        priority: 6,
        maxAttempts: 3,
        backoffMs: 1100,
        timeoutMs: 15000,
        payload: {
          durationMs: 1300,
          steps: 4,
          failUntilAttempt: 1,
          errorMessage: "503 Service Unavailable from upstream webhook",
        },
      },
      {
        name: "Sync invoice callback (dead-letter sample)",
        queue: "webhooks",
        type: "simulate_work",
        priority: 5,
        maxAttempts: 2,
        backoffMs: 800,
        timeoutMs: 15000,
        payload: {
          durationMs: 1100,
          steps: 4,
          alwaysFail: true,
          errorMessage: "401 Invalid HMAC signature on target endpoint",
        },
      },
      {
        name: "Compress product thumbnails (WebP)",
        queue: "media",
        type: "simulate_work",
        priority: 4,
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 15000,
        payload: { durationMs: 2000, steps: 5 },
      },
    ];

    for (const item of starter) {
      this.enqueue(item);
    }
  }

  enqueue(rawInput: EnqueueInput): { job: Job; replay: boolean } {
    const input = validateEnqueueInput(rawInput);

    if (input.idempotencyKey) {
      const existing = this.state.jobs.find(
        (j) => j.idempotencyKey && j.idempotencyKey === input.idempotencyKey
      );
      if (existing) {
        return { job: { ...existing }, replay: true };
      }
    }

    const now = nowISO();
    const runAt = new Date(Date.now() + (input.delayMs ?? 0)).toISOString();
    const job: Job = {
      id: makeJobId(),
      name: input.name,
      queue: input.queue,
      type: input.type,
      status: "queued",
      priority: input.priority,
      payload: input.payload,
      progress: 0,
      attempts: 0,
      maxAttempts: input.maxAttempts,
      backoffMs: input.backoffMs,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey || undefined,
      runAt,
      durationMs: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.state.jobs.unshift(job);
    this.pushLog(
      job.id,
      "info",
      `Enqueued into "${job.queue}" (priority ${job.priority}, max ${job.maxAttempts} attempts)`
    );
    this.saveState();
    this.emit();
    return { job: { ...job }, replay: false };
  }

  spawnDemoBatch(): Job[] {
    const batch: EnqueueInput[] = [
      {
        name: "Transcode clip 720p H.264",
        queue: "media",
        type: "simulate_work",
        priority: 8,
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 15000,
        payload: { durationMs: 2400, steps: 6 },
      },
      {
        name: "Build Typst SOP document PDF",
        queue: "documents",
        type: "simulate_work",
        priority: 7,
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 15000,
        payload: { durationMs: 1600, steps: 5 },
      },
      {
        name: "Dispatch webhook (recovers on attempt 2)",
        queue: "webhooks",
        type: "simulate_work",
        priority: 6,
        maxAttempts: 3,
        backoffMs: 900,
        timeoutMs: 15000,
        payload: {
          durationMs: 1200,
          steps: 4,
          failUntilAttempt: 1,
          errorMessage: "502 Bad Gateway from remote endpoint",
        },
      },
      {
        name: "Verify payment webhook (dead-letter test)",
        queue: "webhooks",
        type: "simulate_work",
        priority: 5,
        maxAttempts: 2,
        backoffMs: 700,
        timeoutMs: 15000,
        payload: {
          durationMs: 950,
          steps: 4,
          alwaysFail: true,
          errorMessage: "401 Rejected signing secret",
        },
      },
      {
        name: "Run runtime telemetry snapshot",
        queue: "ops",
        type: "system_check",
        priority: 4,
        maxAttempts: 2,
        backoffMs: 1000,
        timeoutMs: 10000,
        payload: { target: "runtime" },
      },
      {
        name: "Optimize thumbnail bundle (WebP)",
        queue: "media",
        type: "simulate_work",
        priority: 5,
        maxAttempts: 3,
        backoffMs: 1000,
        timeoutMs: 15000,
        payload: { durationMs: 2100, steps: 5 },
      },
    ];

    return batch.map((b) => this.enqueue(b).job);
  }

  setPaused(paused: boolean): PoolStatus {
    this.state.paused = paused;
    this.rebuildSlots();
    this.saveState();
    this.emit();
    return this.getPoolStatus();
  }

  setConcurrency(target: number): PoolStatus {
    if (target < MIN_WORKERS || target > MAX_WORKERS) {
      throw new ApiValidationError("Invalid concurrency", [
        { field: "concurrency", issue: `Must be between ${MIN_WORKERS} and ${MAX_WORKERS}` },
      ]);
    }
    this.state.concurrency = target;
    this.rebuildSlots();
    this.saveState();
    this.emit();
    return this.getPoolStatus();
  }

  getJobDetail(id: string): JobDetail {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) {
      throw new Error("Requested job was not found");
    }
    return {
      job: { ...job },
      logs: [...(this.state.logs[id] || [])],
    };
  }

  retryJob(id: string): Job {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Requested job was not found");
    if (!["dead_letter", "cancelled", "completed"].includes(job.status)) {
      throw new Error("Only dead-letter, cancelled, or completed jobs can be re-queued");
    }
    const now = nowISO();
    job.status = "queued";
    job.attempts = 0;
    job.progress = 0;
    job.lastError = undefined;
    job.result = undefined;
    job.workerId = undefined;
    job.startedAt = undefined;
    job.completedAt = undefined;
    job.durationMs = 0;
    job.runAt = now;
    job.updatedAt = now;
    this.pushLog(job.id, "info", "Manually re-queued from dashboard");
    this.saveState();
    this.emit();
    return { ...job };
  }

  retryAllDeadLetters(): number {
    const now = nowISO();
    let count = 0;
    for (const job of this.state.jobs) {
      if (job.status === "dead_letter") {
        job.status = "queued";
        job.attempts = 0;
        job.progress = 0;
        job.lastError = undefined;
        job.result = undefined;
        job.workerId = undefined;
        job.startedAt = undefined;
        job.completedAt = undefined;
        job.durationMs = 0;
        job.runAt = now;
        job.updatedAt = now;
        this.pushLog(job.id, "info", "Re-queued in bulk Dead-Letter replay");
        count++;
      }
    }
    if (count > 0) {
      this.saveState();
      this.emit();
    }
    return count;
  }

  cancelJob(id: string): Job {
    const job = this.state.jobs.find((j) => j.id === id);
    if (!job) throw new Error("Requested job was not found");
    if (!["queued", "retrying", "running"].includes(job.status)) {
      throw new Error("Job is already in a terminal state");
    }
    const ctrl = this.controllers.get(id);
    if (ctrl) {
      ctrl.abort();
    }
    const now = nowISO();
    job.status = "cancelled";
    job.workerId = undefined;
    job.completedAt = now;
    job.updatedAt = now;
    this.pushLog(job.id, "warn", "Cancelled by operator");
    this.saveState();
    this.emit();
    return { ...job };
  }

  deleteJob(id: string) {
    const idx = this.state.jobs.findIndex((j) => j.id === id);
    if (idx === -1) throw new Error("Requested job was not found");
    if (this.state.jobs[idx].status === "running") {
      throw new Error("Cancel the running job before deleting it");
    }
    this.state.jobs.splice(idx, 1);
    delete this.state.logs[id];
    this.saveState();
    this.emit();
  }

  purgeCompleted(): number {
    const before = this.state.jobs.length;
    const removedIds: string[] = [];
    this.state.jobs = this.state.jobs.filter((j) => {
      if (j.status === "completed" || j.status === "cancelled") {
        removedIds.push(j.id);
        return false;
      }
      return true;
    });
    for (const id of removedIds) {
      delete this.state.logs[id];
    }
    const purged = before - this.state.jobs.length;
    if (purged > 0) {
      this.saveState();
      this.emit();
    }
    return purged;
  }

  private tick() {
    if (this.state.paused) return;

    const nowMs = Date.now();
    for (const slot of this.slots) {
      if (slot.state !== "idle") continue;

      const candidates = this.state.jobs
        .filter(
          (j) =>
            (j.status === "queued" || j.status === "retrying") &&
            new Date(j.runAt).getTime() <= nowMs
        )
        .sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return new Date(a.runAt).getTime() - new Date(b.runAt).getTime();
        });

      const nextJob = candidates[0];
      if (!nextJob) break;

      void this.runInSlot(slot, nextJob);
    }
  }

  private async runInSlot(slot: WorkerSlot, job: Job) {
    const startedMs = Date.now();
    const startedAt = new Date(startedMs).toISOString();
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);

    job.status = "running";
    job.attempts += 1;
    job.workerId = slot.id;
    job.progress = 0;
    job.startedAt = startedAt;
    job.updatedAt = startedAt;

    slot.state = "busy";
    slot.jobId = job.id;
    slot.jobName = job.name;
    slot.jobType = job.type;
    slot.progress = 0;
    slot.startedAt = startedAt;

    this.pushLog(
      job.id,
      "info",
      `Claimed by ${slot.id} (attempt ${job.attempts}/${job.maxAttempts})`
    );
    this.saveState();
    this.emit();

    let result: Record<string, unknown> | undefined;
    let summary = "";
    let execErr: Error | null = null;

    try {
      const out = await this.executeSandboxJob(job, ctrl.signal, (pct, msg) => {
        if (job.status !== "running") return;
        job.progress = pct;
        job.updatedAt = nowISO();
        slot.progress = pct;
        if (msg) this.pushLog(job.id, "info", msg);
        this.emit();
      });
      result = out.result;
      summary = out.summary;
    } catch (err) {
      execErr = err instanceof Error ? err : new Error(String(err));
    } finally {
      this.controllers.delete(job.id);
    }

    const durationMs = Math.max(1, Date.now() - startedMs);
    const wasAborted =
      ctrl.signal.aborted || (job.status as JobStatus) === "cancelled";

    slot.state = this.state.paused ? "paused" : "idle";
    slot.jobId = undefined;
    slot.jobName = undefined;
    slot.jobType = undefined;
    slot.progress = 0;
    slot.startedAt = undefined;

    if (wasAborted) {
      // Already marked cancelled by cancelJob()
    } else if (execErr) {
      slot.failed += 1;
      job.lastError = execErr.message;
      job.progress = 0;
      job.workerId = undefined;
      job.durationMs = durationMs;
      job.updatedAt = nowISO();

      if (job.attempts < job.maxAttempts) {
        const delayMs = Math.min(job.backoffMs * Math.pow(2, job.attempts - 1), 30000);
        job.status = "retrying";
        job.runAt = new Date(Date.now() + delayMs).toISOString();
        this.pushLog(
          job.id,
          "warn",
          `Attempt ${job.attempts}/${job.maxAttempts} failed: ${execErr.message}. Retrying in ${delayMs}ms`
        );
      } else {
        job.status = "dead_letter";
        job.completedAt = nowISO();
        this.recordBucket("failed");
        this.pushLog(
          job.id,
          "error",
          `Exhausted ${job.attempts}/${job.maxAttempts} attempts: ${execErr.message}. Moved to Dead-Letter Queue`
        );
      }
    } else {
      slot.processed += 1;
      job.status = "completed";
      job.progress = 100;
      job.lastError = undefined;
      job.result = result;
      job.workerId = undefined;
      job.completedAt = nowISO();
      job.durationMs = durationMs;
      job.updatedAt = nowISO();
      this.recordBucket("completed");
      this.pushLog(job.id, "success", summary || "Completed successfully");
    }

    this.saveState();
    this.emit();
  }

  private async executeSandboxJob(
    job: Job,
    signal: AbortSignal,
    onProgress: (pct: number, logLine: string) => void
  ): Promise<{ result: Record<string, unknown>; summary: string }> {
    const p = job.payload || {};

    if (job.type === "http_webhook") {
      const targetUrl = String(p.url || "");
      const method = String(p.method || "POST").toUpperCase();
      onProgress(25, `Dispatching ${method} ${targetUrl}`);
      const started = performance.now();
      try {
        const resp = await fetch(targetUrl, {
          method,
          headers: method === "GET" ? undefined : { "Content-Type": "application/json" },
          body: method === "GET" ? undefined : JSON.stringify(p.body ?? { jobId: job.id }),
          signal,
        });
        const latencyMs = Math.round(performance.now() - started);
        onProgress(80, `Received HTTP ${resp.status} in ${latencyMs}ms`);
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status} from ${targetUrl}`);
        }
        return {
          result: { statusCode: resp.status, latencyMs, mode: "browser-fetch" },
          summary: `HTTP ${resp.status} (${latencyMs}ms)`,
        };
      } catch (err) {
        if (signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : "Network/CORS failure";
        throw new Error(`${msg} (run local Go binary to bypass browser CORS limits)`);
      }
    }

    if (job.type === "media_probe") {
      const targetPath = String(p.path || "clip.mp4");
      await waitAbortable(500, signal);
      onProgress(45, `Inspecting container headers for ${targetPath}`);
      await waitAbortable(650, signal);
      onProgress(90, "Sandbox probe finished (run local Go binary for native ffprobe)");
      return {
        result: {
          file: targetPath.split("/").pop() || targetPath,
          mode: "browser-sandbox-simulation",
          note: "Native ffprobe executes when connected to the local Go server",
        },
        summary: `Simulated probe for ${targetPath}`,
      };
    }

    if (job.type === "system_check") {
      const target = String(p.target || "runtime");
      await waitAbortable(350, signal);
      onProgress(50, `Collecting browser host runtime (${target})`);
      await waitAbortable(350, signal);
      onProgress(90, "Telemetry snapshot captured");
      return {
        result: {
          target,
          userAgent: typeof navigator !== "undefined" ? navigator.platform : "web",
          cores: typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 4,
          checkedAt: nowISO(),
        },
        summary: `Captured ${target} snapshot in browser sandbox`,
      };
    }

    // simulate_work
    const durationMs = Math.min(30000, Math.max(200, Number(p.durationMs) || 2000));
    const steps = Math.min(20, Math.max(2, Number(p.steps) || 5));
    const failUntilAttempt = Number(p.failUntilAttempt) || 0;
    const alwaysFail = Boolean(p.alwaysFail);
    const customErr = String(p.errorMessage || "").trim();
    const failStep = Math.max(1, Math.floor(steps / 2));

    for (let i = 1; i <= steps; i++) {
      await waitAbortable(Math.round(durationMs / steps), signal);
      const pct = Math.round((i / steps) * 100);
      if ((alwaysFail || (failUntilAttempt > 0 && job.attempts <= failUntilAttempt)) && i === failStep) {
        throw new Error(customErr || `Upstream timeout simulated at step ${i}/${steps}`);
      }
      onProgress(pct, `Processed chunk ${i}/${steps} (${pct}%)`);
    }

    return {
      result: { stepsCompleted: steps, attempt: job.attempts, status: "ok" },
      summary: `Completed ${steps} steps on attempt ${job.attempts}`,
    };
  }

  getPoolStatus(): PoolStatus {
    const busyWorkers = this.slots.filter((s) => s.state === "busy").length;
    return {
      runtime: "Browser Sandbox (localStorage)",
      paused: this.state.paused,
      concurrency: this.state.concurrency,
      minWorkers: MIN_WORKERS,
      maxWorkers: MAX_WORKERS,
      busyWorkers,
      slots: this.slots.map((s) => ({ ...s })),
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  getMetrics(): QueueMetrics {
    const counts: Record<JobStatus, number> = {
      queued: 0,
      running: 0,
      retrying: 0,
      completed: 0,
      dead_letter: 0,
      cancelled: 0,
    };

    const queues = new Set<string>();
    let durSum = 0;
    let durCount = 0;

    for (const j of this.state.jobs) {
      counts[j.status] = (counts[j.status] || 0) + 1;
      queues.add(j.queue);
      if (j.status === "completed" && j.durationMs > 0) {
        durSum += j.durationMs;
        durCount += 1;
      }
    }

    const total = this.state.jobs.length;
    const terminal = counts.completed + counts.dead_letter;
    const successRatePct =
      terminal > 0 ? Math.round((counts.completed / terminal) * 1000) / 10 : null;

    const nowB = minuteBucket();
    const startB = nowB - 11 * 60;
    const throughput: ThroughputPoint[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = startB + i * 60;
      const b = this.state.buckets[ts] || { completed: 0, failed: 0 };
      const d = new Date(ts * 1000);
      const label = d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      throughput.push({
        label,
        bucketTs: ts,
        completed: b.completed,
        failed: b.failed,
      });
    }

    return {
      total,
      queued: counts.queued,
      running: counts.running,
      retrying: counts.retrying,
      completed: counts.completed,
      deadLetter: counts.dead_letter,
      cancelled: counts.cancelled,
      avgDurationMs: durCount > 0 ? Math.round(durSum / durCount) : 0,
      successRatePct,
      activeQueues: Array.from(queues).sort(),
      throughput,
    };
  }

  getSnapshot(): Snapshot {
    const orderRank: Record<JobStatus, number> = {
      running: 0,
      retrying: 1,
      queued: 2,
      dead_letter: 3,
      completed: 4,
      cancelled: 5,
    };
    const sorted = [...this.state.jobs].sort((a, b) => {
      const d = orderRank[a.status] - orderRank[b.status];
      if (d !== 0) return d;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    return {
      pool: this.getPoolStatus(),
      metrics: this.getMetrics(),
      jobs: sorted.map((j) => ({ ...j })),
      updatedAt: nowISO(),
    };
  }
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const id = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(id);
      reject(new Error("Cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
