# QueuePulse

Zero-config, local-first background job queue and concurrent worker pool written in Go, backed by SQLite WAL persistence, exponential backoff retries, Dead-Letter Queue (DLQ) recovery, and a real-time React + TypeScript dashboard.

Part of the **\*Pulse** developer tooling series (`devpulse`, `pocketpulse`, `queuepulse`).

- **Live Interactive Demo (Vercel):** [https://queuepulse-ashy.vercel.app](https://queuepulse-ashy.vercel.app) *(runs the client-side Browser Sandbox Worker Engine with `localStorage` persistence)*
- **Native Go + SQLite Engine:** Run locally via `make run` or `docker compose up` for native SQLite WAL durability, SSE streaming, `ffprobe` media inspection, and server-side HTTP webhooks.

## Why QueuePulse?

Heavy background tasks (video transcoding, PDF generation, flaky webhook deliveries, local media inspection) should not block HTTP handlers or saturate a laptop's CPU cores all at once. QueuePulse gives you a durable job queue with bounded concurrency and live observability in a **single binary** with zero Redis or external broker setup.

## Key Features

- **Pure-Go SQLite WAL Persistence (`modernc.org/sqlite`)**: Atomic priority-aware job claiming, crash recovery on startup (`running` -> `queued`), foreign-key cascade logs, and persisted 1-minute throughput buckets.
- **Dynamic Goroutine Worker Pool**: Scale active worker slots (`1..8`) live, pause/resume claiming at runtime, cancel in-flight jobs via `context.Context`, and drain gracefully on `SIGINT`/`SIGTERM`.
- **Exponential Backoff & Dead-Letter Queue (DLQ)**: Failed attempts automatically reschedule (`backoffMs * 2^(attempt-1)`, capped at `30s`) until `maxAttempts` is exhausted, then move to DLQ for single or bulk replay.
- **Idempotency Keys**: Duplicate enqueue calls with the same `idempotencyKey` return the existing job cleanly without creating duplicate rows.
- **Real-Time SSE Streaming (`/api/v1/stream`)**: Pushes initial snapshot, worker slot transitions, progress ticks, logs, and reconciled metrics directly to the browser.
- **Dual-Mode Dashboard (React + TypeScript + Tailwind CSS + shadcn/ui patterns)**:
  - Connects natively to the Go REST + SSE server when run locally (`make run` or Docker).
  - Runs an interactive **Browser Sandbox Engine** (`localStorage` persisted) when deployed statically on Vercel so anyone can inspect worker slots, retry flaky jobs, and test DLQ flows directly in the browser.

## Architecture

```text
Browser Dashboard (React + TypeScript + Tailwind)
       │  REST (/api/v1/*) + SSE (/api/v1/stream)
       ▼
Go HTTP Layer (internal/httpapi)
  ├── Middleware: RequestID, Recovery, Structured Logging, CORS
  └── Uniform JSON Envelopes (200 / 201 / 202 / 204 / 404 / 409 / 422)
       │
       ▼
Queue Service & Worker Pool (internal/service)
  ├── Goroutine Worker Slots (W-01 .. W-08) + Dynamic Resize + Pause
  ├── Executors: simulate_work | http_webhook | media_probe (ffprobe) | system_check
  └── Non-blocking SSE Pub/Sub Broker
       │
       ▼
SQLite WAL Repository (internal/repository)
  ├── jobs (priority + run_at index, unique partial idempotency index)
  ├── job_logs (FK ON DELETE CASCADE)
  └── throughput_buckets (per-minute completed/failed counters)
```

## Quick Start (Single Binary)

```bash
git clone https://github.com/AryaKhaslana/queuepulse.git
cd queuepulse
make run
```

Open `http://localhost:8080`. The `-seed` flag enqueues a starter batch when the database is empty.

### CLI Flags

| Flag | Default | Description |
| :--- | :--- | :--- |
| `-addr` | `:8080` | HTTP listen address (`QUEUEPULSE_ADDR`) |
| `-db` | `queuepulse.db` | SQLite database file path (`QUEUEPULSE_DB`) |
| `-workers` | `3` | Initial concurrent worker slots (`1..8`) |
| `-seed` | `false` | Spawn 6 demo jobs on startup if queue is empty |

### Docker Compose

```bash
docker compose up --build
```

## API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/v1/health` | Health status & runtime metadata |
| `GET` | `/api/v1/snapshot` | Full pool, metrics, and recent jobs snapshot |
| `GET` | `/api/v1/stream` | Server-Sent Events live stream |
| `GET` | `/api/v1/jobs` | List jobs (`status`, `queue`, `search`, `sort`, `page`, `limit`) |
| `POST` | `/api/v1/jobs` | Enqueue job (supports `idempotencyKey`, returns `202 Accepted`) |
| `POST` | `/api/v1/jobs/demo` | Spawn 6 demo jobs covering success, retry recovery, and DLQ |
| `GET` | `/api/v1/jobs/{id}` | Job detail + execution log timeline |
| `POST` | `/api/v1/jobs/{id}/retry` | Re-queue dead-letter, cancelled, or completed job |
| `POST` | `/api/v1/jobs/retry-dead-letters` | Bulk replay all jobs in Dead-Letter Queue |
| `POST` | `/api/v1/jobs/{id}/cancel` | Cancel queued, retrying, or running job |
| `DELETE` | `/api/v1/jobs/{id}` | Permanently delete non-running job |
| `DELETE` | `/api/v1/jobs/completed` | Purge all completed and cancelled jobs |
| `POST` | `/api/v1/pool/pause` | Pause claiming new jobs |
| `POST` | `/api/v1/pool/resume` | Resume worker pool |
| `PATCH` | `/api/v1/pool/concurrency` | Resize active worker slots (`1..8`) |

## Running Tests

```bash
make test
```

## License

MIT
