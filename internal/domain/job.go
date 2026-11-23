package domain

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type JobStatus string

const (
	StatusQueued     JobStatus = "queued"
	StatusRunning    JobStatus = "running"
	StatusRetrying   JobStatus = "retrying"
	StatusCompleted  JobStatus = "completed"
	StatusDeadLetter JobStatus = "dead_letter"
	StatusCancelled  JobStatus = "cancelled"
)

type JobType string

const (
	TypeSimulateWork JobType = "simulate_work"
	TypeHTTPWebhook  JobType = "http_webhook"
	TypeMediaProbe   JobType = "media_probe"
	TypeSystemCheck  JobType = "system_check"
)

func IsValidJobType(t JobType) bool {
	switch t {
	case TypeSimulateWork, TypeHTTPWebhook, TypeMediaProbe, TypeSystemCheck:
		return true
	default:
		return false
	}
}

func IsValidStatus(s JobStatus) bool {
	switch s {
	case StatusQueued, StatusRunning, StatusRetrying, StatusCompleted, StatusDeadLetter, StatusCancelled:
		return true
	default:
		return false
	}
}

var (
	ErrNotFound         = errors.New("resource not found")
	ErrInvalidState     = errors.New("invalid state transition")
	ErrValidationFailed = errors.New("validation failed")
)

type FieldError struct {
	Field string `json:"field"`
	Issue string `json:"issue"`
}

type ValidationError struct {
	Details []FieldError
}

func (e *ValidationError) Error() string {
	return ErrValidationFailed.Error()
}

type Job struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	Queue          string          `json:"queue"`
	Type           JobType         `json:"type"`
	Status         JobStatus       `json:"status"`
	Priority       int             `json:"priority"`
	Payload        json.RawMessage `json:"payload"`
	Result         json.RawMessage `json:"result,omitempty"`
	LastError      string          `json:"lastError,omitempty"`
	Progress       int             `json:"progress"`
	Attempts       int             `json:"attempts"`
	MaxAttempts    int             `json:"maxAttempts"`
	BackoffMs      int             `json:"backoffMs"`
	TimeoutMs      int             `json:"timeoutMs"`
	IdempotencyKey string          `json:"idempotencyKey,omitempty"`
	WorkerID       string          `json:"workerId,omitempty"`
	RunAt          time.Time       `json:"runAt"`
	StartedAt      *time.Time      `json:"startedAt,omitempty"`
	CompletedAt    *time.Time      `json:"completedAt,omitempty"`
	DurationMs     int64           `json:"durationMs"`
	CreatedAt      time.Time       `json:"createdAt"`
	UpdatedAt      time.Time       `json:"updatedAt"`
}

type JobLog struct {
	ID        int64     `json:"id"`
	JobID     string    `json:"jobId"`
	Level     string    `json:"level"`
	Message   string    `json:"message"`
	CreatedAt time.Time `json:"createdAt"`
}

type JobDetail struct {
	Job  Job      `json:"job"`
	Logs []JobLog `json:"logs"`
}

type EnqueueInput struct {
	Name           string          `json:"name"`
	Queue          string          `json:"queue"`
	Type           JobType         `json:"type"`
	Priority       int             `json:"priority"`
	Payload        json.RawMessage `json:"payload"`
	MaxAttempts    int             `json:"maxAttempts"`
	BackoffMs      int             `json:"backoffMs"`
	TimeoutMs      int             `json:"timeoutMs"`
	DelayMs        int             `json:"delayMs"`
	IdempotencyKey string          `json:"idempotencyKey"`
}

func (in *EnqueueInput) NormalizeAndValidate() error {
	var errs []FieldError

	in.Name = strings.TrimSpace(in.Name)
	in.Queue = strings.TrimSpace(in.Queue)
	in.IdempotencyKey = strings.TrimSpace(in.IdempotencyKey)

	if in.Name == "" {
		errs = append(errs, FieldError{Field: "name", Issue: "Job name is required"})
	} else if len(in.Name) > 120 {
		errs = append(errs, FieldError{Field: "name", Issue: "Job name must be at most 120 characters"})
	}

	if in.Queue == "" {
		in.Queue = "default"
	} else if len(in.Queue) > 48 {
		errs = append(errs, FieldError{Field: "queue", Issue: "Queue name must be at most 48 characters"})
	}

	if !IsValidJobType(in.Type) {
		errs = append(errs, FieldError{
			Field: "type",
			Issue: "Type must be one of simulate_work, http_webhook, media_probe, system_check",
		})
	}

	if in.Priority < 0 || in.Priority > 10 {
		errs = append(errs, FieldError{Field: "priority", Issue: "Priority must be between 0 and 10"})
	}

	if in.MaxAttempts == 0 {
		in.MaxAttempts = 3
	} else if in.MaxAttempts < 1 || in.MaxAttempts > 10 {
		errs = append(errs, FieldError{Field: "maxAttempts", Issue: "Max attempts must be between 1 and 10"})
	}

	if in.BackoffMs == 0 {
		in.BackoffMs = 1500
	} else if in.BackoffMs < 200 || in.BackoffMs > 60000 {
		errs = append(errs, FieldError{Field: "backoffMs", Issue: "Backoff must be between 200ms and 60000ms"})
	}

	if in.TimeoutMs == 0 {
		in.TimeoutMs = 15000
	} else if in.TimeoutMs < 500 || in.TimeoutMs > 120000 {
		errs = append(errs, FieldError{Field: "timeoutMs", Issue: "Timeout must be between 500ms and 120000ms"})
	}

	if in.DelayMs < 0 || in.DelayMs > 3600000 {
		errs = append(errs, FieldError{Field: "delayMs", Issue: "Delay must be between 0ms and 3600000ms"})
	}

	if len(in.IdempotencyKey) > 120 {
		errs = append(errs, FieldError{Field: "idempotencyKey", Issue: "Idempotency key must be at most 120 characters"})
	}

	if len(in.Payload) == 0 {
		in.Payload = json.RawMessage(`{}`)
	} else if !json.Valid(in.Payload) {
		errs = append(errs, FieldError{Field: "payload", Issue: "Payload must be valid JSON"})
	}

	if len(errs) > 0 {
		return &ValidationError{Details: errs}
	}
	return nil
}

type JobFilter struct {
	Status JobStatus
	Queue  string
	Search string
	SortBy string
	Page   int
	Limit  int
}

type PaginationMeta struct {
	Page        int  `json:"page"`
	Limit       int  `json:"limit"`
	TotalItems  int  `json:"totalItems"`
	TotalPages  int  `json:"totalPages"`
	HasNextPage bool `json:"hasNextPage"`
	HasPrevPage bool `json:"hasPrevPage"`
}

type WorkerSlot struct {
	ID         string     `json:"id"`
	State      string     `json:"state"` // idle | busy | paused
	JobID      string     `json:"jobId,omitempty"`
	JobName    string     `json:"jobName,omitempty"`
	JobType    JobType    `json:"jobType,omitempty"`
	Progress   int        `json:"progress"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	Processed  int64      `json:"processed"`
	Failed     int64      `json:"failed"`
}

type PoolStatus struct {
	Runtime     string       `json:"runtime"`
	Paused      bool         `json:"paused"`
	Concurrency int          `json:"concurrency"`
	MinWorkers  int          `json:"minWorkers"`
	MaxWorkers  int          `json:"maxWorkers"`
	BusyWorkers int          `json:"busyWorkers"`
	Slots       []WorkerSlot `json:"slots"`
	UptimeSec   int64        `json:"uptimeSec"`
}

type ThroughputPoint struct {
	Label     string `json:"label"`
	BucketTS  int64  `json:"bucketTs"`
	Completed int    `json:"completed"`
	Failed    int    `json:"failed"`
}

type QueueMetrics struct {
	Total           int               `json:"total"`
	Queued          int               `json:"queued"`
	Running         int               `json:"running"`
	Retrying        int               `json:"retrying"`
	Completed       int               `json:"completed"`
	DeadLetter      int               `json:"deadLetter"`
	Cancelled       int               `json:"cancelled"`
	AvgDurationMs   int64             `json:"avgDurationMs"`
	SuccessRatePct  *float64          `json:"successRatePct"` // nil when no terminal jobs yet
	ActiveQueues    []string          `json:"activeQueues"`
	Throughput      []ThroughputPoint `json:"throughput"`
}

type Snapshot struct {
	Pool    PoolStatus   `json:"pool"`
	Metrics QueueMetrics `json:"metrics"`
	Jobs    []Job        `json:"jobs"`
	Updated time.Time    `json:"updatedAt"`
}
