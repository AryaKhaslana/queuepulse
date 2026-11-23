package service_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
	"github.com/AryaKhaslana/queuepulse/internal/service"
)

func TestWorkerPoolRetryDeadLetterAndIdempotency(t *testing.T) {
	ctx := context.Background()
	repo, err := repository.NewSQLiteRepository(filepath.Join(t.TempDir(), "pool.db"))
	if err != nil {
		t.Fatalf("repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	broker := service.NewBroker()
	exec := service.NewExecutor()
	pool := service.NewWorkerPool(repo, exec, broker, 2)
	svc := service.NewQueueService(repo, pool, broker)
	pool.Start()
	defer func() {
		shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = pool.Shutdown(shutCtx)
	}()

	// 1. Idempotency check
	first, replay1, err := svc.Enqueue(ctx, domain.EnqueueInput{
		Name:           "Fast task",
		Queue:          "default",
		Type:           domain.TypeSimulateWork,
		Priority:       8,
		MaxAttempts:    2,
		BackoffMs:      200,
		IdempotencyKey: "unique-key-1",
		Payload:        json.RawMessage(`{"durationMs":160,"steps":2}`),
	})
	if err != nil || replay1 {
		t.Fatalf("first enqueue failed: replay=%v err=%v", replay1, err)
	}

	dup, replay2, err := svc.Enqueue(ctx, domain.EnqueueInput{
		Name:           "Fast task duplicate",
		Queue:          "default",
		Type:           domain.TypeSimulateWork,
		IdempotencyKey: "unique-key-1",
		Payload:        json.RawMessage(`{"durationMs":160,"steps":2}`),
	})
	if err != nil || !replay2 || dup.ID != first.ID {
		t.Fatalf("expected idempotent replay of %s, got %+v replay=%v err=%v", first.ID, dup, replay2, err)
	}

	// 2. Flaky task that fails attempt 1, succeeds on attempt 2
	flaky, _, err := svc.Enqueue(ctx, domain.EnqueueInput{
		Name:        "Flaky job",
		Queue:       "webhooks",
		Type:        domain.TypeSimulateWork,
		Priority:    7,
		MaxAttempts: 3,
		BackoffMs:   200,
		Payload:     json.RawMessage(`{"durationMs":160,"steps":2,"failUntilAttempt":1}`),
	})
	if err != nil {
		t.Fatalf("enqueue flaky: %v", err)
	}

	// 3. Always-fail task that promotes to dead_letter
	dlqJob, _, err := svc.Enqueue(ctx, domain.EnqueueInput{
		Name:        "Dead letter job",
		Queue:       "webhooks",
		Type:        domain.TypeSimulateWork,
		Priority:    6,
		MaxAttempts: 2,
		BackoffMs:   200,
		Payload:     json.RawMessage(`{"durationMs":160,"steps":2,"alwaysFail":true}`),
	})
	if err != nil {
		t.Fatalf("enqueue dlq: %v", err)
	}

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		j1, _ := repo.GetJob(ctx, first.ID)
		j2, _ := repo.GetJob(ctx, flaky.ID)
		j3, _ := repo.GetJob(ctx, dlqJob.ID)
		if j1.Status == domain.StatusCompleted && j2.Status == domain.StatusCompleted && j3.Status == domain.StatusDeadLetter {
			if j2.Attempts != 2 {
				t.Fatalf("expected flaky job to succeed on attempt 2, got %d", j2.Attempts)
			}
			if j3.Attempts != 2 || j3.LastError == "" {
				t.Fatalf("expected dlq job attempts=2 with error, got %+v", j3)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for worker pool jobs to finish")
}
