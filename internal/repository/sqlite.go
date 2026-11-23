package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	_ "modernc.org/sqlite"
)

type SQLiteRepository struct {
	db *sql.DB
}

func NewSQLiteRepository(dsn string) (*SQLiteRepository, error) {
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// Single open connection guarantees serialized SQLite writes with zero SQLITE_BUSY flakiness.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	repo := &SQLiteRepository{db: db}
	if err := repo.initSchema(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	return repo, nil
}

func (r *SQLiteRepository) Close() error {
	return r.db.Close()
}

func (r *SQLiteRepository) initSchema(ctx context.Context) error {
	pragmas := []string{
		`PRAGMA journal_mode = WAL;`,
		`PRAGMA synchronous = NORMAL;`,
		`PRAGMA foreign_keys = ON;`,
		`PRAGMA busy_timeout = 5000;`,
	}
	for _, p := range pragmas {
		if _, err := r.db.ExecContext(ctx, p); err != nil {
			return fmt.Errorf("exec pragma %q: %w", p, err)
		}
	}

	const schemaSQL = `
	CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS jobs (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		queue TEXT NOT NULL DEFAULT 'default',
		type TEXT NOT NULL,
		status TEXT NOT NULL,
		priority INTEGER NOT NULL DEFAULT 5,
		payload TEXT NOT NULL DEFAULT '{}',
		result TEXT NOT NULL DEFAULT '',
		last_error TEXT NOT NULL DEFAULT '',
		progress INTEGER NOT NULL DEFAULT 0,
		attempts INTEGER NOT NULL DEFAULT 0,
		max_attempts INTEGER NOT NULL DEFAULT 3,
		backoff_ms INTEGER NOT NULL DEFAULT 1500,
		timeout_ms INTEGER NOT NULL DEFAULT 15000,
		idempotency_key TEXT,
		worker_id TEXT NOT NULL DEFAULT '',
		run_at TEXT NOT NULL,
		started_at TEXT,
		completed_at TEXT,
		duration_ms INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);

	CREATE TABLE IF NOT EXISTS job_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		job_id TEXT NOT NULL,
		level TEXT NOT NULL,
		message TEXT NOT NULL,
		created_at TEXT NOT NULL,
		FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
	);

	CREATE TABLE IF NOT EXISTS throughput_buckets (
		bucket_ts INTEGER PRIMARY KEY,
		completed INTEGER NOT NULL DEFAULT 0,
		failed INTEGER NOT NULL DEFAULT 0
	);

	CREATE INDEX IF NOT EXISTS idx_jobs_claim
		ON jobs(status, run_at, priority DESC, created_at ASC);

	CREATE INDEX IF NOT EXISTS idx_jobs_queue_created
		ON jobs(queue, created_at DESC);

	CREATE INDEX IF NOT EXISTS idx_jobs_status_updated
		ON jobs(status, updated_at DESC);

	CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
		ON jobs(idempotency_key)
		WHERE idempotency_key IS NOT NULL AND idempotency_key != '';

	CREATE INDEX IF NOT EXISTS idx_job_logs_job_created
		ON job_logs(job_id, created_at ASC);
	`

	if _, err := r.db.ExecContext(ctx, schemaSQL); err != nil {
		return fmt.Errorf("init schema: %w", err)
	}

	_, err := r.db.ExecContext(
		ctx,
		`INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)`,
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	return err
}

// RecoverStaleRunning resets any jobs left in "running" after an unexpected crash back to "queued".
func (r *SQLiteRepository) RecoverStaleRunning(ctx context.Context) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := r.db.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, worker_id = '', progress = 0, run_at = ?, updated_at = ?
		WHERE status = ?
	`, domain.StatusQueued, now, now, domain.StatusRunning)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (r *SQLiteRepository) FindByIdempotencyKey(ctx context.Context, key string) (*domain.Job, error) {
	if key == "" {
		return nil, domain.ErrNotFound
	}
	row := r.db.QueryRowContext(ctx, selectJobColumns+` WHERE idempotency_key = ?`, key)
	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return job, err
}

func (r *SQLiteRepository) CreateJob(ctx context.Context, job *domain.Job, initialLog string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var idemKey any
	if job.IdempotencyKey != "" {
		idemKey = job.IdempotencyKey
	}

	_, err = tx.ExecContext(ctx, `
		INSERT INTO jobs (
			id, name, queue, type, status, priority, payload, result, last_error,
			progress, attempts, max_attempts, backoff_ms, timeout_ms,
			idempotency_key, worker_id, run_at, started_at, completed_at, duration_ms,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		job.ID, job.Name, job.Queue, string(job.Type), string(job.Status),
		job.Priority, string(job.Payload), string(job.Result), job.LastError,
		job.Progress, job.Attempts, job.MaxAttempts, job.BackoffMs, job.TimeoutMs,
		idemKey, job.WorkerID,
		job.RunAt.UTC().Format(time.RFC3339Nano),
		formatOptTime(job.StartedAt), formatOptTime(job.CompletedAt), job.DurationMs,
		job.CreatedAt.UTC().Format(time.RFC3339Nano),
		job.UpdatedAt.UTC().Format(time.RFC3339Nano),
	)
	if err != nil {
		return err
	}

	if initialLog != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO job_logs (job_id, level, message, created_at)
			VALUES (?, 'info', ?, ?)
		`, job.ID, initialLog, job.CreatedAt.UTC().Format(time.RFC3339Nano)); err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (r *SQLiteRepository) AppendLog(ctx context.Context, jobID, level, message string) error {
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO job_logs (job_id, level, message, created_at)
		VALUES (?, ?, ?, ?)
	`, jobID, level, message, time.Now().UTC().Format(time.RFC3339Nano))
	return err
}

func (r *SQLiteRepository) ClaimNextJob(ctx context.Context, workerID string) (*domain.Job, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339Nano)

	row := tx.QueryRowContext(ctx, selectJobColumns+`
		WHERE status IN (?, ?) AND run_at <= ?
		ORDER BY priority DESC, run_at ASC, created_at ASC
		LIMIT 1
	`, domain.StatusQueued, domain.StatusRetrying, nowStr)

	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}

	job.Status = domain.StatusRunning
	job.Attempts++
	job.WorkerID = workerID
	job.Progress = 0
	job.StartedAt = &now
	job.UpdatedAt = now

	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, attempts = ?, worker_id = ?, progress = 0, started_at = ?, updated_at = ?
		WHERE id = ?
	`, string(job.Status), job.Attempts, job.WorkerID, nowStr, nowStr, job.ID); err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO job_logs (job_id, level, message, created_at)
		VALUES (?, 'info', ?, ?)
	`, job.ID, fmt.Sprintf("Claimed by %s (attempt %d/%d)", workerID, job.Attempts, job.MaxAttempts), nowStr); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return job, nil
}

func (r *SQLiteRepository) UpdateProgress(ctx context.Context, jobID string, progress int) error {
	if progress < 0 {
		progress = 0
	}
	if progress > 100 {
		progress = 100
	}
	_, err := r.db.ExecContext(ctx, `
		UPDATE jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = ?
	`, progress, time.Now().UTC().Format(time.RFC3339Nano), jobID, domain.StatusRunning)
	return err
}

func (r *SQLiteRepository) MarkCompleted(ctx context.Context, jobID string, result json.RawMessage, durationMs int64, summary string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339Nano)
	resStr := "{}"
	if len(result) > 0 && json.Valid(result) {
		resStr = string(result)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, result = ?, last_error = '', progress = 100,
		    worker_id = '', completed_at = ?, duration_ms = ?, updated_at = ?
		WHERE id = ?
	`, domain.StatusCompleted, resStr, nowStr, durationMs, nowStr, jobID); err != nil {
		return err
	}

	if summary != "" {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO job_logs (job_id, level, message, created_at)
			VALUES (?, 'success', ?, ?)
		`, jobID, summary, nowStr); err != nil {
			return err
		}
	}

	bucket := truncateToMinute(now)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO throughput_buckets (bucket_ts, completed, failed)
		VALUES (?, 1, 0)
		ON CONFLICT(bucket_ts) DO UPDATE SET completed = completed + 1
	`, bucket); err != nil {
		return err
	}

	return tx.Commit()
}

func (r *SQLiteRepository) MarkRetryOrDeadLetter(ctx context.Context, job *domain.Job, errMsg string, durationMs int64) (domain.JobStatus, time.Time, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback() }()

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339Nano)

	var nextStatus domain.JobStatus
	var nextRunAt time.Time
	var completedAt any
	var logLevel, logMsg string

	if job.Attempts < job.MaxAttempts {
		// Exponential backoff: backoffMs * 2^(attempts-1), capped at 30s.
		mult := math.Pow(2, float64(job.Attempts-1))
		delayMs := int(math.Min(float64(job.BackoffMs)*mult, 30000))
		nextStatus = domain.StatusRetrying
		nextRunAt = now.Add(time.Duration(delayMs) * time.Millisecond)
		logLevel = "warn"
		logMsg = fmt.Sprintf("Attempt %d/%d failed: %s. Retrying in %dms", job.Attempts, job.MaxAttempts, errMsg, delayMs)
	} else {
		nextStatus = domain.StatusDeadLetter
		nextRunAt = now
		completedAt = nowStr
		logLevel = "error"
		logMsg = fmt.Sprintf("Exhausted %d/%d attempts: %s. Moved to Dead-Letter Queue", job.Attempts, job.MaxAttempts, errMsg)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, last_error = ?, progress = 0, worker_id = '',
		    run_at = ?, completed_at = ?, duration_ms = ?, updated_at = ?
		WHERE id = ?
	`, string(nextStatus), errMsg, nextRunAt.Format(time.RFC3339Nano), completedAt, durationMs, nowStr, job.ID); err != nil {
		return "", time.Time{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO job_logs (job_id, level, message, created_at)
		VALUES (?, ?, ?, ?)
	`, job.ID, logLevel, logMsg, nowStr); err != nil {
		return "", time.Time{}, err
	}

	if nextStatus == domain.StatusDeadLetter {
		bucket := truncateToMinute(now)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO throughput_buckets (bucket_ts, completed, failed)
			VALUES (?, 0, 1)
			ON CONFLICT(bucket_ts) DO UPDATE SET failed = failed + 1
		`, bucket); err != nil {
			return "", time.Time{}, err
		}
	}

	if err := tx.Commit(); err != nil {
		return "", time.Time{}, err
	}
	return nextStatus, nextRunAt, nil
}

func (r *SQLiteRepository) MarkCancelled(ctx context.Context, jobID, reason string) error {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	nowStr := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, worker_id = '', completed_at = ?, updated_at = ?
		WHERE id = ? AND status IN (?, ?, ?)
	`, domain.StatusCancelled, nowStr, nowStr, jobID, domain.StatusQueued, domain.StatusRetrying, domain.StatusRunning)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return domain.ErrInvalidState
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO job_logs (job_id, level, message, created_at)
		VALUES (?, 'warn', ?, ?)
	`, jobID, reason, nowStr); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *SQLiteRepository) RequeueJob(ctx context.Context, jobID string) (*domain.Job, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRowContext(ctx, selectJobColumns+` WHERE id = ?`, jobID)
	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	if job.Status != domain.StatusDeadLetter && job.Status != domain.StatusCancelled && job.Status != domain.StatusCompleted {
		return nil, domain.ErrInvalidState
	}

	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339Nano)
	if _, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, attempts = 0, progress = 0, last_error = '', result = '',
		    worker_id = '', run_at = ?, started_at = NULL, completed_at = NULL,
		    duration_ms = 0, updated_at = ?
		WHERE id = ?
	`, domain.StatusQueued, nowStr, nowStr, jobID); err != nil {
		return nil, err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO job_logs (job_id, level, message, created_at)
		VALUES (?, 'info', 'Manually re-queued from dashboard', ?)
	`, jobID, nowStr); err != nil {
		return nil, err
	}

	if err := tx.Commit(); err != nil {
		return nil, err
	}

	return r.GetJob(ctx, jobID)
}

func (r *SQLiteRepository) RetryAllDeadLetters(ctx context.Context) (int64, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()

	nowStr := time.Now().UTC().Format(time.RFC3339Nano)

	rows, err := tx.QueryContext(ctx, `SELECT id FROM jobs WHERE status = ?`, domain.StatusDeadLetter)
	if err != nil {
		return 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	_ = rows.Close()

	if len(ids) == 0 {
		return 0, nil
	}

	res, err := tx.ExecContext(ctx, `
		UPDATE jobs
		SET status = ?, attempts = 0, progress = 0, last_error = '', result = '',
		    worker_id = '', run_at = ?, started_at = NULL, completed_at = NULL,
		    duration_ms = 0, updated_at = ?
		WHERE status = ?
	`, domain.StatusQueued, nowStr, nowStr, domain.StatusDeadLetter)
	if err != nil {
		return 0, err
	}

	for _, id := range ids {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO job_logs (job_id, level, message, created_at)
			VALUES (?, 'info', 'Re-queued in bulk Dead-Letter replay', ?)
		`, id, nowStr); err != nil {
			return 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (r *SQLiteRepository) DeleteJob(ctx context.Context, jobID string) error {
	row := r.db.QueryRowContext(ctx, `SELECT status FROM jobs WHERE id = ?`, jobID)
	var status string
	if err := row.Scan(&status); errors.Is(err, sql.ErrNoRows) {
		return domain.ErrNotFound
	} else if err != nil {
		return err
	}
	if status == string(domain.StatusRunning) {
		return domain.ErrInvalidState
	}

	_, err := r.db.ExecContext(ctx, `DELETE FROM jobs WHERE id = ?`, jobID)
	return err
}

func (r *SQLiteRepository) PurgeCompleted(ctx context.Context) (int64, error) {
	res, err := r.db.ExecContext(ctx, `
		DELETE FROM jobs WHERE status IN (?, ?)
	`, domain.StatusCompleted, domain.StatusCancelled)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (r *SQLiteRepository) GetJob(ctx context.Context, jobID string) (*domain.Job, error) {
	row := r.db.QueryRowContext(ctx, selectJobColumns+` WHERE id = ?`, jobID)
	job, err := scanJob(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, domain.ErrNotFound
	}
	return job, err
}

func (r *SQLiteRepository) GetJobDetail(ctx context.Context, jobID string) (*domain.JobDetail, error) {
	job, err := r.GetJob(ctx, jobID)
	if err != nil {
		return nil, err
	}

	rows, err := r.db.QueryContext(ctx, `
		SELECT id, job_id, level, message, created_at
		FROM job_logs
		WHERE job_id = ?
		ORDER BY id ASC
		LIMIT 200
	`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	logs := make([]domain.JobLog, 0)
	for rows.Next() {
		var l domain.JobLog
		var ts string
		if err := rows.Scan(&l.ID, &l.JobID, &l.Level, &l.Message, &ts); err != nil {
			return nil, err
		}
		l.CreatedAt = parseTime(ts)
		logs = append(logs, l)
	}

	return &domain.JobDetail{
		Job:  *job,
		Logs: logs,
	}, nil
}

func (r *SQLiteRepository) ListJobs(ctx context.Context, filter domain.JobFilter) ([]domain.Job, domain.PaginationMeta, error) {
	if filter.Page < 1 {
		filter.Page = 1
	}
	if filter.Limit < 1 || filter.Limit > 100 {
		filter.Limit = 25
	}

	var where []string
	var args []any

	if filter.Status != "" {
		where = append(where, "status = ?")
		args = append(args, string(filter.Status))
	}
	if filter.Queue != "" {
		where = append(where, "queue = ?")
		args = append(args, filter.Queue)
	}
	if q := strings.TrimSpace(filter.Search); q != "" {
		where = append(where, "(name LIKE ? OR id LIKE ? OR queue LIKE ? OR type LIKE ? OR last_error LIKE ?)")
		like := "%" + q + "%"
		args = append(args, like, like, like, like, like)
	}

	whereClause := ""
	if len(where) > 0 {
		whereClause = " WHERE " + strings.Join(where, " AND ")
	}

	var total int
	if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM jobs`+whereClause, args...).Scan(&total); err != nil {
		return nil, domain.PaginationMeta{}, err
	}

	orderBy := " ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'retrying' THEN 1 WHEN 'queued' THEN 2 WHEN 'dead_letter' THEN 3 ELSE 4 END, created_at DESC"
	switch filter.SortBy {
	case "newest":
		orderBy = " ORDER BY created_at DESC"
	case "oldest":
		orderBy = " ORDER BY created_at ASC"
	case "priority":
		orderBy = " ORDER BY priority DESC, created_at DESC"
	case "duration":
		orderBy = " ORDER BY duration_ms DESC, created_at DESC"
	}

	offset := (filter.Page - 1) * filter.Limit
	queryArgs := append(append([]any{}, args...), filter.Limit, offset)

	rows, err := r.db.QueryContext(ctx, selectJobColumns+whereClause+orderBy+` LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return nil, domain.PaginationMeta{}, err
	}
	defer rows.Close()

	jobs := make([]domain.Job, 0)
	for rows.Next() {
		j, err := scanJob(rows)
		if err != nil {
			return nil, domain.PaginationMeta{}, err
		}
		jobs = append(jobs, *j)
	}

	totalPages := int(math.Ceil(float64(total) / float64(filter.Limit)))
	if totalPages == 0 {
		totalPages = 1
	}

	meta := domain.PaginationMeta{
		Page:        filter.Page,
		Limit:       filter.Limit,
		TotalItems:  total,
		TotalPages:  totalPages,
		HasNextPage: filter.Page < totalPages,
		HasPrevPage: filter.Page > 1,
	}
	return jobs, meta, nil
}

func (r *SQLiteRepository) GetMetrics(ctx context.Context) (domain.QueueMetrics, error) {
	m := domain.QueueMetrics{
		ActiveQueues: make([]string, 0),
		Throughput:   make([]domain.ThroughputPoint, 0, 12),
	}

	rows, err := r.db.QueryContext(ctx, `SELECT status, COUNT(*) FROM jobs GROUP BY status`)
	if err != nil {
		return m, err
	}
	for rows.Next() {
		var status string
		var cnt int
		if err := rows.Scan(&status, &cnt); err != nil {
			_ = rows.Close()
			return m, err
		}
		m.Total += cnt
		switch domain.JobStatus(status) {
		case domain.StatusQueued:
			m.Queued = cnt
		case domain.StatusRunning:
			m.Running = cnt
		case domain.StatusRetrying:
			m.Retrying = cnt
		case domain.StatusCompleted:
			m.Completed = cnt
		case domain.StatusDeadLetter:
			m.DeadLetter = cnt
		case domain.StatusCancelled:
			m.Cancelled = cnt
		}
	}
	_ = rows.Close()

	var avgDur sql.NullFloat64
	if err := r.db.QueryRowContext(ctx, `
		SELECT AVG(duration_ms) FROM jobs WHERE status = ? AND duration_ms > 0
	`, domain.StatusCompleted).Scan(&avgDur); err != nil {
		return m, err
	}
	if avgDur.Valid {
		m.AvgDurationMs = int64(math.Round(avgDur.Float64))
	}

	terminal := m.Completed + m.DeadLetter
	if terminal > 0 {
		rate := math.Round((float64(m.Completed)/float64(terminal))*1000) / 10
		m.SuccessRatePct = &rate
	}

	qRows, err := r.db.QueryContext(ctx, `SELECT DISTINCT queue FROM jobs ORDER BY queue ASC`)
	if err != nil {
		return m, err
	}
	for qRows.Next() {
		var q string
		if err := qRows.Scan(&q); err == nil {
			m.ActiveQueues = append(m.ActiveQueues, q)
		}
	}
	_ = qRows.Close()

	// Last 12 one-minute buckets ending at the current minute.
	nowMinute := truncateToMinute(time.Now().UTC())
	startBucket := nowMinute - 11*60

	bucketMap := make(map[int64]domain.ThroughputPoint)
	bRows, err := r.db.QueryContext(ctx, `
		SELECT bucket_ts, completed, failed
		FROM throughput_buckets
		WHERE bucket_ts >= ?
		ORDER BY bucket_ts ASC
	`, startBucket)
	if err != nil {
		return m, err
	}
	for bRows.Next() {
		var tp domain.ThroughputPoint
		if err := bRows.Scan(&tp.BucketTS, &tp.Completed, &tp.Failed); err == nil {
			bucketMap[tp.BucketTS] = tp
		}
	}
	_ = bRows.Close()

	for i := 0; i < 12; i++ {
		ts := startBucket + int64(i)*60
		point := bucketMap[ts]
		point.BucketTS = ts
		point.Label = time.Unix(ts, 0).Local().Format("15:04")
		m.Throughput = append(m.Throughput, point)
	}

	return m, nil
}

const selectJobColumns = `
SELECT
	id, name, queue, type, status, priority, payload, result, last_error,
	progress, attempts, max_attempts, backoff_ms, timeout_ms,
	COALESCE(idempotency_key, ''), worker_id, run_at, started_at, completed_at,
	duration_ms, created_at, updated_at
FROM jobs`

type scanner interface {
	Scan(dest ...any) error
}

func scanJob(s scanner) (*domain.Job, error) {
	var j domain.Job
	var typ, status, payload, result string
	var runAt, createdAt, updatedAt string
	var startedAt, completedAt sql.NullString

	err := s.Scan(
		&j.ID, &j.Name, &j.Queue, &typ, &status, &j.Priority,
		&payload, &result, &j.LastError, &j.Progress, &j.Attempts,
		&j.MaxAttempts, &j.BackoffMs, &j.TimeoutMs, &j.IdempotencyKey,
		&j.WorkerID, &runAt, &startedAt, &completedAt, &j.DurationMs,
		&createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}

	j.Type = domain.JobType(typ)
	j.Status = domain.JobStatus(status)
	if payload != "" {
		j.Payload = json.RawMessage(payload)
	} else {
		j.Payload = json.RawMessage(`{}`)
	}
	if result != "" && json.Valid([]byte(result)) {
		j.Result = json.RawMessage(result)
	}
	j.RunAt = parseTime(runAt)
	j.CreatedAt = parseTime(createdAt)
	j.UpdatedAt = parseTime(updatedAt)
	if startedAt.Valid && startedAt.String != "" {
		t := parseTime(startedAt.String)
		j.StartedAt = &t
	}
	if completedAt.Valid && completedAt.String != "" {
		t := parseTime(completedAt.String)
		j.CompletedAt = &t
	}
	return &j, nil
}

func formatOptTime(t *time.Time) any {
	if t == nil {
		return nil
	}
	return t.UTC().Format(time.RFC3339Nano)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		t, _ = time.Parse(time.RFC3339, s)
	}
	return t
}

func truncateToMinute(t time.Time) int64 {
	return (t.Unix() / 60) * 60
}
