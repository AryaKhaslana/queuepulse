export type JobStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "dead_letter"
  | "cancelled";

export type JobType =
  | "simulate_work"
  | "http_webhook"
  | "media_probe"
  | "system_check";

export interface Job {
  id: string;
  name: string;
  queue: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  lastError?: string;
  progress: number;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
  idempotencyKey?: string;
  workerId?: string;
  runAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface JobLog {
  id: number;
  jobId: string;
  level: "info" | "warn" | "error" | "success" | string;
  message: string;
  createdAt: string;
}

export interface JobDetail {
  job: Job;
  logs: JobLog[];
}

export interface EnqueueInput {
  name: string;
  queue: string;
  type: JobType;
  priority: number;
  payload: Record<string, unknown>;
  maxAttempts: number;
  backoffMs: number;
  timeoutMs: number;
  delayMs?: number;
  idempotencyKey?: string;
}

export interface WorkerSlot {
  id: string;
  state: "idle" | "busy" | "paused";
  jobId?: string;
  jobName?: string;
  jobType?: JobType;
  progress: number;
  startedAt?: string;
  processed: number;
  failed: number;
}

export interface PoolStatus {
  runtime: string;
  paused: boolean;
  concurrency: number;
  minWorkers: number;
  maxWorkers: number;
  busyWorkers: number;
  slots: WorkerSlot[];
  uptimeSec: number;
}

export interface ThroughputPoint {
  label: string;
  bucketTs: number;
  completed: number;
  failed: number;
}

export interface QueueMetrics {
  total: number;
  queued: number;
  running: number;
  retrying: number;
  completed: number;
  deadLetter: number;
  cancelled: number;
  avgDurationMs: number;
  successRatePct: number | null;
  activeQueues: string[];
  throughput: ThroughputPoint[];
}

export interface Snapshot {
  pool: PoolStatus;
  metrics: QueueMetrics;
  jobs: Job[];
  updatedAt: string;
}

export interface FieldError {
  field: string;
  issue: string;
}

export class ApiValidationError extends Error {
  details: FieldError[];
  constructor(message: string, details: FieldError[]) {
    super(message);
    this.details = details;
  }
}

export type RuntimeMode = "go-api" | "browser-sandbox";
