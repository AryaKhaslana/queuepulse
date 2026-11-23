import * as React from "react";
import {
  ApiValidationError,
  type EnqueueInput,
  type JobType,
} from "@/lib/types";
import { Dialog } from "./ui/dialog";
import { Button } from "./ui/button";
import { Input, Label, Select, Textarea } from "./ui/input";

interface EnqueueDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: EnqueueInput) => Promise<void>;
}

interface Preset {
  label: string;
  name: string;
  queue: string;
  type: JobType;
  priority: number;
  maxAttempts: number;
  backoffMs: number;
  payload: string;
}

const PRESETS: Preset[] = [
  {
    label: "Media job",
    name: "Encode 1080p clip H.264",
    queue: "media",
    type: "simulate_work",
    priority: 8,
    maxAttempts: 3,
    backoffMs: 1200,
    payload: JSON.stringify({ durationMs: 2500, steps: 6 }, null, 2),
  },
  {
    label: "Flaky retry",
    name: "Deliver order webhook (auto-recovers)",
    queue: "webhooks",
    type: "simulate_work",
    priority: 7,
    maxAttempts: 3,
    backoffMs: 1000,
    payload: JSON.stringify(
      {
        durationMs: 1400,
        steps: 4,
        failUntilAttempt: 1,
        errorMessage: "503 upstream gateway timeout",
      },
      null,
      2
    ),
  },
  {
    label: "Dead-letter test",
    name: "Sync billing event (exhausts retries)",
    queue: "webhooks",
    type: "simulate_work",
    priority: 5,
    maxAttempts: 2,
    backoffMs: 800,
    payload: JSON.stringify(
      {
        durationMs: 1000,
        steps: 4,
        alwaysFail: true,
        errorMessage: "401 unauthorized signing token",
      },
      null,
      2
    ),
  },
  {
    label: "HTTP webhook",
    name: "Ping JSON placeholder endpoint",
    queue: "webhooks",
    type: "http_webhook",
    priority: 6,
    maxAttempts: 3,
    backoffMs: 1500,
    payload: JSON.stringify(
      {
        url: "https://jsonplaceholder.typicode.com/posts",
        method: "POST",
        body: { source: "queuepulse", event: "job.ping" },
      },
      null,
      2
    ),
  },
  {
    label: "Media probe",
    name: "Inspect local MP4 metadata",
    queue: "media",
    type: "media_probe",
    priority: 6,
    maxAttempts: 2,
    backoffMs: 1000,
    payload: JSON.stringify({ path: "~/Videos/exile_35mm_film_1x1.mp4" }, null, 2),
  },
  {
    label: "Host check",
    name: "Collect host thermal snapshot",
    queue: "ops",
    type: "system_check",
    priority: 4,
    maxAttempts: 2,
    backoffMs: 1000,
    payload: JSON.stringify({ target: "thermal" }, null, 2),
  },
];

export function EnqueueDialog({ open, onClose, onSubmit }: EnqueueDialogProps) {
  const [name, setName] = React.useState(PRESETS[0].name);
  const [queue, setQueue] = React.useState(PRESETS[0].queue);
  const [type, setType] = React.useState<JobType>(PRESETS[0].type);
  const [priority, setPriority] = React.useState(String(PRESETS[0].priority));
  const [maxAttempts, setMaxAttempts] = React.useState(String(PRESETS[0].maxAttempts));
  const [backoffMs, setBackoffMs] = React.useState(String(PRESETS[0].backoffMs));
  const [idempotencyKey, setIdempotencyKey] = React.useState("");
  const [payloadText, setPayloadText] = React.useState(PRESETS[0].payload);

  const [submitting, setSubmitting] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const applyPreset = (preset: Preset) => {
    setName(preset.name);
    setQueue(preset.queue);
    setType(preset.type);
    setPriority(String(preset.priority));
    setMaxAttempts(String(preset.maxAttempts));
    setBackoffMs(String(preset.backoffMs));
    setPayloadText(preset.payload);
    setFieldErrors({});
    setFormError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFieldErrors({});
    setFormError(null);

    let parsedPayload: Record<string, unknown>;
    try {
      const val = JSON.parse(payloadText || "{}");
      if (!val || typeof val !== "object" || Array.isArray(val)) {
        setFieldErrors({ payload: "Payload must be a JSON object" });
        return;
      }
      parsedPayload = val as Record<string, unknown>;
    } catch {
      setFieldErrors({ payload: "Payload contains invalid JSON syntax" });
      return;
    }

    const input: EnqueueInput = {
      name: name.trim(),
      queue: queue.trim() || "default",
      type,
      priority: Number(priority),
      maxAttempts: Number(maxAttempts),
      backoffMs: Number(backoffMs),
      timeoutMs: 15000,
      idempotencyKey: idempotencyKey.trim() || undefined,
      payload: parsedPayload,
    };

    setSubmitting(true);
    try {
      await onSubmit(input);
      setIdempotencyKey("");
      onClose();
    } catch (err) {
      if (err instanceof ApiValidationError) {
        const mapped: Record<string, string> = {};
        for (const d of err.details) {
          mapped[d.field] = d.issue;
        }
        setFieldErrors(mapped);
        setFormError("Please fix the highlighted fields before submitting.");
      } else {
        setFormError(
          err instanceof Error ? err.message : "Could not enqueue job. Check input and retry."
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Enqueue background job"
      description="Jobs persist immediately and are claimed by the next available worker slot."
    >
      {/* Presets */}
      <div className="mb-4">
        <div className="mb-1.5 text-[12px] font-medium text-[var(--muted)]">
          Quick presets
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-[5px] border border-[var(--border)] bg-[var(--raised)] px-2 py-1 text-[12px] text-[var(--text)] hover:border-[var(--accent)] hover:text-[var(--accent)] cursor-pointer"
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3.5" noValidate>
        {formError && (
          <div className="rounded-[6px] border border-[var(--negative)]/35 bg-[var(--pill-negative-bg)] px-3 py-2 text-[12px] text-[var(--pill-negative-ink)]">
            {formError}
          </div>
        )}

        <div>
          <Label htmlFor="qp-name">Job name</Label>
          <Input
            id="qp-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Export catalog PDF #14"
            required
          />
          {fieldErrors.name && (
            <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.name}</p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="qp-type">Executor type</Label>
            <Select
              id="qp-type"
              value={type}
              onChange={(e) => setType(e.target.value as JobType)}
            >
              <option value="simulate_work">simulate_work (steps &amp; retry test)</option>
              <option value="http_webhook">http_webhook (HTTP request)</option>
              <option value="media_probe">media_probe (local ffprobe)</option>
              <option value="system_check">system_check (safe host telemetry)</option>
            </Select>
            {fieldErrors.type && (
              <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.type}</p>
            )}
          </div>

          <div>
            <Label htmlFor="qp-queue">Queue name</Label>
            <Input
              id="qp-queue"
              value={queue}
              onChange={(e) => setQueue(e.target.value)}
              placeholder="default"
            />
            {fieldErrors.queue && (
              <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.queue}</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="qp-priority">Priority (0-10)</Label>
            <Input
              id="qp-priority"
              type="number"
              min={0}
              max={10}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
            {fieldErrors.priority && (
              <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.priority}</p>
            )}
          </div>

          <div>
            <Label htmlFor="qp-attempts">Max attempts</Label>
            <Input
              id="qp-attempts"
              type="number"
              min={1}
              max={10}
              value={maxAttempts}
              onChange={(e) => setMaxAttempts(e.target.value)}
            />
            {fieldErrors.maxAttempts && (
              <p className="mt-1 text-[12px] text-[var(--negative)]">
                {fieldErrors.maxAttempts}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="qp-backoff">Backoff (ms)</Label>
            <Input
              id="qp-backoff"
              type="number"
              min={200}
              max={60000}
              step={100}
              value={backoffMs}
              onChange={(e) => setBackoffMs(e.target.value)}
            />
            {fieldErrors.backoffMs && (
              <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.backoffMs}</p>
            )}
          </div>
        </div>

        <div>
          <Label htmlFor="qp-idem">Idempotency key (optional)</Label>
          <Input
            id="qp-idem"
            value={idempotencyKey}
            onChange={(e) => setIdempotencyKey(e.target.value)}
            placeholder="e.g. invoice-2026-11-batch14 (prevents duplicate enqueue)"
          />
          {fieldErrors.idempotencyKey && (
            <p className="mt-1 text-[12px] text-[var(--negative)]">
              {fieldErrors.idempotencyKey}
            </p>
          )}
        </div>

        <div>
          <Label htmlFor="qp-payload">Payload JSON</Label>
          <Textarea
            id="qp-payload"
            rows={5}
            value={payloadText}
            onChange={(e) => setPayloadText(e.target.value)}
            className="font-mono text-[12px]"
          />
          {fieldErrors.payload && (
            <p className="mt-1 text-[12px] text-[var(--negative)]">{fieldErrors.payload}</p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--rule)]">
          <Button variant="outline" size="md" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" size="md" type="submit" disabled={submitting}>
            {submitting ? "Enqueueing..." : "Enqueue job"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
