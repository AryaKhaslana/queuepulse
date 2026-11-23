package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	"github.com/AryaKhaslana/queuepulse/internal/service"
)

type Handlers struct {
	svc *service.QueueService
}

func NewHandlers(svc *service.QueueService) *Handlers {
	return &Handlers{svc: svc}
}

type apiEnvelope struct {
	Success bool        `json:"success"`
	Data    any         `json:"data,omitempty"`
	Meta    any         `json:"meta,omitempty"`
	Message string      `json:"message,omitempty"`
	Error   *apiErrBody `json:"error,omitempty"`
}

type apiErrBody struct {
	Code    string              `json:"code"`
	Message string              `json:"message"`
	Details []domain.FieldError `json:"details,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeOK(w http.ResponseWriter, status int, data any, message string) {
	writeJSON(w, status, apiEnvelope{
		Success: true,
		Data:    data,
		Message: message,
	})
}

func writeError(w http.ResponseWriter, status int, code, message string, details []domain.FieldError) {
	writeJSON(w, status, apiEnvelope{
		Success: false,
		Error: &apiErrBody{
			Code:    code,
			Message: message,
			Details: details,
		},
	})
}

func handleServiceError(w http.ResponseWriter, err error) {
	var valErr *domain.ValidationError
	if errors.As(err, &valErr) {
		writeError(w, http.StatusUnprocessableEntity, "VALIDATION_ERROR", "Invalid request payload", valErr.Details)
		return
	}
	if errors.Is(err, domain.ErrNotFound) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Requested job was not found", nil)
		return
	}
	if errors.Is(err, domain.ErrInvalidState) {
		writeError(w, http.StatusConflict, "INVALID_STATE", "Action is not allowed in the job's current state", nil)
		return
	}
	writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected server error occurred", nil)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MiB limit
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errors.New("request body cannot be empty")
		}
		return err
	}
	return nil
}

func (h *Handlers) Health(w http.ResponseWriter, r *http.Request) {
	st := h.svc.PoolStatus()
	writeOK(w, http.StatusOK, map[string]any{
		"status":      "ok",
		"runtime":     st.Runtime,
		"uptimeSec":   st.UptimeSec,
		"concurrency": st.Concurrency,
		"paused":      st.Paused,
	}, "QueuePulse is healthy")
}

func (h *Handlers) Snapshot(w http.ResponseWriter, r *http.Request) {
	snap, err := h.svc.Snapshot(r.Context())
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, snap, "Snapshot retrieved")
}

func (h *Handlers) Metrics(w http.ResponseWriter, r *http.Request) {
	metrics, err := h.svc.GetMetrics(r.Context())
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, metrics, "Metrics retrieved")
}

func (h *Handlers) PoolStatus(w http.ResponseWriter, r *http.Request) {
	writeOK(w, http.StatusOK, h.svc.PoolStatus(), "Pool status retrieved")
}

func (h *Handlers) PausePool(w http.ResponseWriter, r *http.Request) {
	writeOK(w, http.StatusOK, h.svc.SetPaused(true), "Worker pool paused")
}

func (h *Handlers) ResumePool(w http.ResponseWriter, r *http.Request) {
	writeOK(w, http.StatusOK, h.svc.SetPaused(false), "Worker pool resumed")
}

func (h *Handlers) UpdateConcurrency(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Concurrency int `json:"concurrency"`
	}
	if err := decodeJSON(w, r, &body); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}
	st, err := h.svc.SetConcurrency(body.Concurrency)
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, st, fmt.Sprintf("Concurrency set to %d", st.Concurrency))
}

func (h *Handlers) ListJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	limit, _ := strconv.Atoi(q.Get("limit"))

	filter := domain.JobFilter{
		Status: domain.JobStatus(strings.TrimSpace(q.Get("status"))),
		Queue:  strings.TrimSpace(q.Get("queue")),
		Search: strings.TrimSpace(q.Get("search")),
		SortBy: strings.TrimSpace(q.Get("sort")),
		Page:   page,
		Limit:  limit,
	}

	jobs, meta, err := h.svc.ListJobs(r.Context(), filter)
	if err != nil {
		handleServiceError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, apiEnvelope{
		Success: true,
		Data:    jobs,
		Meta:    meta,
	})
}

func (h *Handlers) EnqueueJob(w http.ResponseWriter, r *http.Request) {
	var input domain.EnqueueInput
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, http.StatusBadRequest, "BAD_REQUEST", err.Error(), nil)
		return
	}

	job, replay, err := h.svc.Enqueue(r.Context(), input)
	if err != nil {
		handleServiceError(w, err)
		return
	}

	if replay {
		w.Header().Set("X-Idempotent-Replay", "true")
		writeOK(w, http.StatusOK, job, "Returned existing job for idempotency key")
		return
	}
	writeOK(w, http.StatusAccepted, job, "Job enqueued")
}

func (h *Handlers) SpawnDemoBatch(w http.ResponseWriter, r *http.Request) {
	jobs, err := h.svc.SpawnDemoBatch(r.Context())
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusCreated, jobs, fmt.Sprintf("Spawned %d demo jobs", len(jobs)))
}

func (h *Handlers) GetJobDetail(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	detail, err := h.svc.GetJobDetail(r.Context(), id)
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, detail, "Job detail retrieved")
}

func (h *Handlers) RetryJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	job, err := h.svc.RetryJob(r.Context(), id)
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, job, "Job re-queued")
}

func (h *Handlers) RetryAllDeadLetters(w http.ResponseWriter, r *http.Request) {
	count, err := h.svc.RetryAllDeadLetters(r.Context())
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]int64{"requeued": count}, fmt.Sprintf("Re-queued %d dead-letter jobs", count))
}

func (h *Handlers) CancelJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	job, err := h.svc.CancelJob(r.Context(), id)
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, job, "Job cancelled")
}

func (h *Handlers) DeleteJob(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimSpace(r.PathValue("id"))
	if err := h.svc.DeleteJob(r.Context(), id); err != nil {
		handleServiceError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) PurgeCompleted(w http.ResponseWriter, r *http.Request) {
	count, err := h.svc.PurgeCompleted(r.Context())
	if err != nil {
		handleServiceError(w, err)
		return
	}
	writeOK(w, http.StatusOK, map[string]int64{"purged": count}, fmt.Sprintf("Purged %d finished jobs", count))
}

func (h *Handlers) StreamEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "STREAM_UNSUPPORTED", "Streaming is not supported by this server", nil)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch, unsubscribe := h.svc.Broker().Subscribe()
	defer unsubscribe()

	// Send initial full snapshot immediately upon connect.
	if snap, err := h.svc.Snapshot(r.Context()); err == nil {
		if raw, err := json.Marshal(service.Event{Type: "snapshot", Data: snap}); err == nil {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
			flusher.Flush()
		}
	}

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case msg, open := <-ch:
			if !open {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}
