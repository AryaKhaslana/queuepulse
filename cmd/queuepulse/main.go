package main

import (
	"context"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/httpapi"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
	"github.com/AryaKhaslana/queuepulse/internal/service"
	"github.com/AryaKhaslana/queuepulse/webembed"
)

func main() {
	addr := flag.String("addr", envOrDefault("QUEUEPULSE_ADDR", ":8080"), "HTTP listen address")
	dbPath := flag.String("db", envOrDefault("QUEUEPULSE_DB", "queuepulse.db"), "SQLite database path")
	workers := flag.Int("workers", 3, "Initial concurrent worker slots (1..8)")
	seed := flag.Bool("seed", false, "Enqueue a demo batch on startup if the queue is empty")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))

	repo, err := repository.NewSQLiteRepository(*dbPath)
	if err != nil {
		logger.Error("failed to initialize sqlite repository", "err", err)
		os.Exit(1)
	}
	defer func() { _ = repo.Close() }()

	if recovered, err := repo.RecoverStaleRunning(context.Background()); err != nil {
		logger.Warn("failed to recover stale jobs", "err", err)
	} else if recovered > 0 {
		logger.Info("recovered stale running jobs back to queued", "count", recovered)
	}

	broker := service.NewBroker()
	executor := service.NewExecutor()
	pool := service.NewWorkerPool(repo, executor, broker, *workers)
	queueSvc := service.NewQueueService(repo, pool, broker)

	if *seed {
		if m, err := queueSvc.GetMetrics(context.Background()); err == nil && m.Total == 0 {
			if _, err := queueSvc.SpawnDemoBatch(context.Background()); err != nil {
				logger.Warn("seed demo batch failed", "err", err)
			}
		}
	}

	pool.Start()

	staticFS, err := webembed.FS()
	if err != nil {
		logger.Error("failed to load embedded web UI", "err", err)
		os.Exit(1)
	}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           httpapi.NewRouter(queueSvc, staticFS, logger),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		logger.Info("QueuePulse listening", "addr", *addr, "db", *dbPath, "workers", *workers)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case err := <-errCh:
		logger.Error("http server error", "err", err)
		os.Exit(1)
	case sig := <-sigCh:
		logger.Info("shutdown signal received; draining active workers", "signal", sig.String())
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	if err := srv.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http shutdown timeout", "err", err)
	}
	if err := pool.Shutdown(shutdownCtx); err != nil {
		logger.Warn("worker pool shutdown timeout", "err", err)
	}
	logger.Info("QueuePulse stopped cleanly")
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
