package httpapi

import (
	"crypto/rand"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/service"
)

func NewRouter(svc *service.QueueService, staticFS fs.FS, logger *slog.Logger) http.Handler {
	h := NewHandlers(svc)
	mux := http.NewServeMux()

	// API v1 Routes
	mux.HandleFunc("GET /api/v1/health", h.Health)
	mux.HandleFunc("GET /api/v1/snapshot", h.Snapshot)
	mux.HandleFunc("GET /api/v1/metrics", h.Metrics)
	mux.HandleFunc("GET /api/v1/pool", h.PoolStatus)
	mux.HandleFunc("POST /api/v1/pool/pause", h.PausePool)
	mux.HandleFunc("POST /api/v1/pool/resume", h.ResumePool)
	mux.HandleFunc("PATCH /api/v1/pool/concurrency", h.UpdateConcurrency)

	mux.HandleFunc("GET /api/v1/jobs", h.ListJobs)
	mux.HandleFunc("POST /api/v1/jobs", h.EnqueueJob)
	mux.HandleFunc("POST /api/v1/jobs/demo", h.SpawnDemoBatch)
	mux.HandleFunc("POST /api/v1/jobs/retry-dead-letters", h.RetryAllDeadLetters)
	mux.HandleFunc("DELETE /api/v1/jobs/completed", h.PurgeCompleted)

	mux.HandleFunc("GET /api/v1/jobs/{id}", h.GetJobDetail)
	mux.HandleFunc("POST /api/v1/jobs/{id}/retry", h.RetryJob)
	mux.HandleFunc("POST /api/v1/jobs/{id}/cancel", h.CancelJob)
	mux.HandleFunc("DELETE /api/v1/jobs/{id}", h.DeleteJob)

	mux.HandleFunc("GET /api/v1/stream", h.StreamEvents)

	// Static SPA fallback for embedded React dashboard
	if staticFS != nil {
		fileServer := http.FileServer(http.FS(staticFS))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			if strings.HasPrefix(r.URL.Path, "/api/") {
				writeError(w, http.StatusNotFound, "NOT_FOUND", "API route not found", nil)
				return
			}

			clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
			if clean == "" || clean == "." {
				clean = "index.html"
			}
			if _, err := fs.Stat(staticFS, clean); err != nil {
				r2 := r.Clone(r.Context())
				r2.URL.Path = "/"
				fileServer.ServeHTTP(w, r2)
				return
			}
			fileServer.ServeHTTP(w, r)
		})
	}

	var handler http.Handler = mux
	handler = corsMiddleware(handler)
	handler = loggingMiddleware(logger, handler)
	handler = recoveryMiddleware(logger, handler)
	handler = requestIDMiddleware(handler)
	return handler
}

func requestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if id == "" {
			var b [4]byte
			_, _ = rand.Read(b[:])
			id = "req_" + hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Request-ID")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func recoveryMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if logger != nil {
					logger.Error("panic recovered", "panic", rec, "path", r.URL.Path)
				}
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "An unexpected server error occurred", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (sw *statusWriter) WriteHeader(code int) {
	sw.status = code
	sw.ResponseWriter.WriteHeader(code)
}

func (sw *statusWriter) Flush() {
	if fl, ok := sw.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}

func loggingMiddleware(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if logger == nil || strings.HasPrefix(r.URL.Path, "/assets/") {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		logger.Info("http",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"ms", time.Since(start).Milliseconds(),
		)
	})
}
