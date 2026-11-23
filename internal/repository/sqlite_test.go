package repository_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
)

func newTestRepo(t *testing.T) *repository.SQLiteRepository {
	t.Helper()
	dsn := filepath.Join(t.TempDir(), "test.db")
	repo, err := repository.NewSQLiteRepository(dsn)
	if err != nil {
		t.Fatalf("NewSQLiteRepository: %v", err)
	}
	t.Cleanup(func() { _ = repo.Close() })
	return repo
}

func TestRepositoryLifecycleAndMetricsReconcile(t *testing.T) {
	ctx := context.Background()
	repo := newTestRepo(t)
	now := time.Now().UTC()

	j1 := &domain.Job{
		ID:             "job_01",
		Name:           "High priority media",
		Queue:          "media",
		Type:           domain.TypeSimulateWork,
		Status:         domain.StatusQueued,
		Priority:       9,
		Payload:        json.RawMessage(`{"durationMs":200}`),
		MaxAttempts:    2,
		BackoffMs:      300,
		TimeoutMs:      5000,
		IdempotencyKey: "idem-01",
		RunAt:          now.Add(-time.Second),
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	j2 := &domain.Job{
		ID:          "job_02",
		Name:        "Low priority webhook",
		Queue:       "webhooks",
		Type:        domain.TypeSimulateWork,
		Status:      domain.StatusQueued,
		Priority:    3,
		Payload:     json.RawMessage(`{"alwaysFail":true}`),
		MaxAttempts: 1,
		BackoffMs:   200,
		TimeoutMs:   5000,
		RunAt:       now.Add(-time.Second),
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := repo.CreateJob(ctx, j1, "created j1"); err != nil {
		t.Fatalf("CreateJob j1: %v", err)
	}
	if err := repo.CreateJob(ctx, j2, "created j2"); err != nil {
		t.Fatalf("CreateJob j2: %v", err)
	}

	// Idempotency lookup
	found, err := repo.FindByIdempotencyKey(ctx, "idem-01")
	if err != nil || found.ID != "job_01" {
		t.Fatalf("FindByIdempotencyKey failed: job=%v err=%v", found, err)
	}

	// Claim should return higher priority j1 first
	claimed, err := repo.ClaimNextJob(ctx, "W-01")
	if err != nil || claimed == nil || claimed.ID != "job_01" {
		t.Fatalf("expected job_01 claimed first, got %v err=%v", claimed, err)
	}
	if claimed.Attempts != 1 || claimed.Status != domain.StatusRunning {
		t.Fatalf("unexpected claimed state: %+v", claimed)
	}

	if err := repo.MarkCompleted(ctx, claimed.ID, json.RawMessage(`{"ok":true}`), 150, "done"); err != nil {
		t.Fatalf("MarkCompleted: %v", err)
	}

	// Claim j2 and exhaust its single attempt into dead_letter
	claimed2, err := repo.ClaimNextJob(ctx, "W-02")
	if err != nil || claimed2 == nil || claimed2.ID != "job_02" {
		t.Fatalf("expected job_02 claimed, got %v err=%v", claimed2, err)
	}
	nextStatus, _, err := repo.MarkRetryOrDeadLetter(ctx, claimed2, "boom", 80)
	if err != nil || nextStatus != domain.StatusDeadLetter {
		t.Fatalf("expected dead_letter, got %s err=%v", nextStatus, err)
	}

	// Metrics must reconcile cleanly
	m, err := repo.GetMetrics(ctx)
	if err != nil {
		t.Fatalf("GetMetrics: %v", err)
	}
	sum := m.Queued + m.Running + m.Retrying + m.Completed + m.DeadLetter + m.Cancelled
	if m.Total != 2 || sum != m.Total || m.Completed != 1 || m.DeadLetter != 1 {
		t.Fatalf("metrics mismatch: %+v", m)
	}
	if m.SuccessRatePct == nil || *m.SuccessRatePct != 50.0 {
		t.Fatalf("expected 50.0%% success rate, got %v", m.SuccessRatePct)
	}

	// Bulk DLQ replay
	requeued, err := repo.RetryAllDeadLetters(ctx)
	if err != nil || requeued != 1 {
		t.Fatalf("RetryAllDeadLetters expected 1, got %d err=%v", requeued, err)
	}
	detail, err := repo.GetJobDetail(ctx, "job_02")
	if err != nil || detail.Job.Status != domain.StatusQueued || len(detail.Logs) < 3 {
		t.Fatalf("unexpected requeued detail: %+v err=%v", detail, err)
	}
}
