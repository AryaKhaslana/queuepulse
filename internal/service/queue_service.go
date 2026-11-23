package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
)

type QueueService struct {
	repo   *repository.SQLiteRepository
	pool   *WorkerPool
	broker *Broker
}

func NewQueueService(repo *repository.SQLiteRepository, pool *WorkerPool, broker *Broker) *QueueService {
	return &QueueService{
		repo:   repo,
		pool:   pool,
		broker: broker,
	}
}

func (s *QueueService) Broker() *Broker {
	return s.broker
}

func (s *QueueService) PoolStatus() domain.PoolStatus {
	return s.pool.Status()
}

func (s *QueueService) SetPaused(paused bool) domain.PoolStatus {
	return s.pool.SetPaused(paused)
}

func (s *QueueService) SetConcurrency(workers int) (domain.PoolStatus, error) {
	return s.pool.SetConcurrency(workers)
}

func (s *QueueService) Enqueue(ctx context.Context, input domain.EnqueueInput) (*domain.Job, bool, error) {
	if err := input.NormalizeAndValidate(); err != nil {
		return nil, false, err
	}

	if input.IdempotencyKey != "" {
		existing, err := s.repo.FindByIdempotencyKey(ctx, input.IdempotencyKey)
		if err == nil && existing != nil {
			return existing, true, nil
		}
		if err != nil && !errors.Is(err, domain.ErrNotFound) {
			return nil, false, err
		}
	}

	now := time.Now().UTC()
	runAt := now.Add(time.Duration(input.DelayMs) * time.Millisecond)

	job := &domain.Job{
		ID:             newJobID(),
		Name:           input.Name,
		Queue:          input.Queue,
		Type:           input.Type,
		Status:         domain.StatusQueued,
		Priority:       input.Priority,
		Payload:        input.Payload,
		MaxAttempts:    input.MaxAttempts,
		BackoffMs:      input.BackoffMs,
		TimeoutMs:      input.TimeoutMs,
		IdempotencyKey: input.IdempotencyKey,
		RunAt:          runAt,
		CreatedAt:      now,
		UpdatedAt:      now,
	}

	initialLog := fmt.Sprintf("Enqueued into %q (priority %d, max %d attempts)", job.Queue, job.Priority, job.MaxAttempts)
	if err := s.repo.CreateJob(ctx, job, initialLog); err != nil {
		return nil, false, err
	}

	s.pool.Wake()
	s.broadcastMutation(ctx, job)
	return job, false, nil
}

func (s *QueueService) SpawnDemoBatch(ctx context.Context) ([]domain.Job, error) {
	templates := []domain.EnqueueInput{
		{
			Name:        "Transcode clip 720p H.264",
			Queue:       "media",
			Type:        domain.TypeSimulateWork,
			Priority:    8,
			MaxAttempts: 3,
			BackoffMs:   1000,
			Payload:     json.RawMessage(`{"durationMs":2600,"steps":6}`),
		},
		{
			Name:        "Generate invoice PDF batch #14",
			Queue:       "documents",
			Type:        domain.TypeSimulateWork,
			Priority:    7,
			MaxAttempts: 3,
			BackoffMs:   1000,
			Payload:     json.RawMessage(`{"durationMs":1800,"steps":5}`),
		},
		{
			Name:        "Sync webhook delivery (flaky upstream)",
			Queue:       "webhooks",
			Type:        domain.TypeSimulateWork,
			Priority:    6,
			MaxAttempts: 3,
			BackoffMs:   900,
			Payload:     json.RawMessage(`{"durationMs":1400,"steps":4,"failUntilAttempt":1,"errorMessage":"503 Service Unavailable from partner API"}`),
		},
		{
			Name:        "Dispatch payment receipt (dead-letter test)",
			Queue:       "webhooks",
			Type:        domain.TypeSimulateWork,
			Priority:    5,
			MaxAttempts: 2,
			BackoffMs:   700,
			Payload:     json.RawMessage(`{"durationMs":1000,"steps":4,"alwaysFail":true,"errorMessage":"401 Invalid signing secret on webhook endpoint"}`),
		},
		{
			Name:        "Collect host thermal & runtime check",
			Queue:       "ops",
			Type:        domain.TypeSystemCheck,
			Priority:    4,
			MaxAttempts: 2,
			BackoffMs:   1000,
			Payload:     json.RawMessage(`{"target":"thermal"}`),
		},
		{
			Name:        "Compress thumbnail assets (WebP)",
			Queue:       "media",
			Type:        domain.TypeSimulateWork,
			Priority:    5,
			MaxAttempts: 3,
			BackoffMs:   1000,
			Payload:     json.RawMessage(`{"durationMs":2200,"steps":5}`),
		},
	}

	created := make([]domain.Job, 0, len(templates))
	for _, tpl := range templates {
		job, _, err := s.Enqueue(ctx, tpl)
		if err != nil {
			return created, err
		}
		created = append(created, *job)
	}
	return created, nil
}

func (s *QueueService) ListJobs(ctx context.Context, filter domain.JobFilter) ([]domain.Job, domain.PaginationMeta, error) {
	if filter.Status != "" && !domain.IsValidStatus(filter.Status) {
		return nil, domain.PaginationMeta{}, &domain.ValidationError{
			Details: []domain.FieldError{{Field: "status", Issue: "Unknown status filter"}},
		}
	}
	return s.repo.ListJobs(ctx, filter)
}

func (s *QueueService) GetJobDetail(ctx context.Context, id string) (*domain.JobDetail, error) {
	return s.repo.GetJobDetail(ctx, id)
}

func (s *QueueService) RetryJob(ctx context.Context, id string) (*domain.Job, error) {
	job, err := s.repo.RequeueJob(ctx, id)
	if err != nil {
		return nil, err
	}
	s.pool.Wake()
	s.broadcastMutation(ctx, job)
	return job, nil
}

func (s *QueueService) RetryAllDeadLetters(ctx context.Context) (int64, error) {
	n, err := s.repo.RetryAllDeadLetters(ctx)
	if err != nil {
		return 0, err
	}
	if n > 0 {
		s.pool.Wake()
		if snap, err := s.Snapshot(ctx); err == nil {
			s.broker.Publish("snapshot", snap)
		}
	}
	return n, nil
}

func (s *QueueService) CancelJob(ctx context.Context, id string) (*domain.Job, error) {
	if s.pool.CancelRunningJob(id) {
		time.Sleep(30 * time.Millisecond)
		job, err := s.repo.GetJob(ctx, id)
		if err == nil {
			s.broadcastMutation(ctx, job)
		}
		return job, err
	}
	if err := s.repo.MarkCancelled(ctx, id, "Cancelled by operator before execution"); err != nil {
		return nil, err
	}
	job, err := s.repo.GetJob(ctx, id)
	if err == nil {
		s.broadcastMutation(ctx, job)
	}
	return job, err
}

func (s *QueueService) DeleteJob(ctx context.Context, id string) error {
	if err := s.repo.DeleteJob(ctx, id); err != nil {
		return err
	}
	s.broker.Publish("job.deleted", map[string]string{"id": id})
	if metrics, err := s.repo.GetMetrics(ctx); err == nil {
		s.broker.Publish("metrics.updated", metrics)
	}
	return nil
}

func (s *QueueService) PurgeCompleted(ctx context.Context) (int64, error) {
	n, err := s.repo.PurgeCompleted(ctx)
	if err != nil {
		return 0, err
	}
	if n > 0 {
		if snap, err := s.Snapshot(ctx); err == nil {
			s.broker.Publish("snapshot", snap)
		}
	}
	return n, nil
}

func (s *QueueService) GetMetrics(ctx context.Context) (domain.QueueMetrics, error) {
	return s.repo.GetMetrics(ctx)
}

func (s *QueueService) Snapshot(ctx context.Context) (domain.Snapshot, error) {
	metrics, err := s.repo.GetMetrics(ctx)
	if err != nil {
		return domain.Snapshot{}, err
	}
	jobs, _, err := s.repo.ListJobs(ctx, domain.JobFilter{Page: 1, Limit: 50})
	if err != nil {
		return domain.Snapshot{}, err
	}
	return domain.Snapshot{
		Pool:    s.pool.Status(),
		Metrics: metrics,
		Jobs:    jobs,
		Updated: time.Now().UTC(),
	}, nil
}

func (s *QueueService) broadcastMutation(ctx context.Context, job *domain.Job) {
	if job != nil {
		s.broker.Publish("job.updated", job)
	}
	if metrics, err := s.repo.GetMetrics(ctx); err == nil {
		s.broker.Publish("metrics.updated", metrics)
	}
}

func newJobID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "job_" + hex.EncodeToString(b[:])
}
