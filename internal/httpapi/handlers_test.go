package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/httpapi"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
	"github.com/AryaKhaslana/queuepulse/internal/service"
)

func TestHTTPAPIContract(t *testing.T) {
	repo, err := repository.NewSQLiteRepository(filepath.Join(t.TempDir(), "api.db"))
	if err != nil {
		t.Fatalf("repo: %v", err)
	}
	defer func() { _ = repo.Close() }()

	broker := service.NewBroker()
	pool := service.NewWorkerPool(repo, service.NewExecutor(), broker, 2)
	svc := service.NewQueueService(repo, pool, broker)
	pool.Start()
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = pool.Shutdown(ctx)
	}()

	router := httpapi.NewRouter(svc, nil, nil)

	// 1. Health endpoint
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health expected 200, got %d", rec.Code)
	}

	// 2. Validation error returns 422 with structured details
	badBody := bytes.NewBufferString(`{"name":"","type":"invalid_type"}`)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/jobs", badBody))
	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 3. Valid enqueue returns 202 Accepted
	goodBody := bytes.NewBufferString(`{"name":"API test job","queue":"default","type":"simulate_work","payload":{"durationMs":160,"steps":2}}`)
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/api/v1/jobs", goodBody))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d body=%s", rec.Code, rec.Body.String())
	}
	var env struct {
		Success bool `json:"success"`
		Data    struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil || !env.Success || env.Data.ID == "" {
		t.Fatalf("unexpected enqueue response: %s", rec.Body.String())
	}

	// 4. Concurrency update endpoint
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodPatch, "/api/v1/pool/concurrency", bytes.NewBufferString(`{"concurrency":4}`)))
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 concurrency update, got %d", rec.Code)
	}

	// 5. Missing job returns 404
	rec = httptest.NewRecorder()
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/jobs/job_does_not_exist", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d", rec.Code)
	}
}
