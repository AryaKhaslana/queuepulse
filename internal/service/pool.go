package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
	"github.com/AryaKhaslana/queuepulse/internal/repository"
)

const (
	MinPoolWorkers = 1
	MaxPoolWorkers = 8
)

type WorkerPool struct {
	repo      *repository.SQLiteRepository
	executor  *Executor
	broker    *Broker
	startedAt time.Time

	mu           sync.Mutex
	concurrency  int
	paused       bool
	stopping     bool
	slots        []domain.WorkerSlot
	runningJobs  map[string]context.CancelFunc
	workerCancel map[string]context.CancelFunc
	wakeCh       chan struct{}

	rootCtx    context.Context
	rootCancel context.CancelFunc
	wg         sync.WaitGroup
}

func NewWorkerPool(repo *repository.SQLiteRepository, executor *Executor, broker *Broker, initialWorkers int) *WorkerPool {
	if initialWorkers < MinPoolWorkers {
		initialWorkers = MinPoolWorkers
	}
	if initialWorkers > MaxPoolWorkers {
		initialWorkers = MaxPoolWorkers
	}

	ctx, cancel := context.WithCancel(context.Background())
	p := &WorkerPool{
		repo:         repo,
		executor:     executor,
		broker:       broker,
		startedAt:    time.Now(),
		concurrency:  initialWorkers,
		slots:        make([]domain.WorkerSlot, 0, MaxPoolWorkers),
		runningJobs:  make(map[string]context.CancelFunc),
		workerCancel: make(map[string]context.CancelFunc),
		wakeCh:       make(chan struct{}, 1),
		rootCtx:      ctx,
		rootCancel:   cancel,
	}
	return p
}

func (p *WorkerPool) Start() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for i := 1; i <= p.concurrency; i++ {
		p.spawnWorkerLocked(i)
	}
}

func (p *WorkerPool) spawnWorkerLocked(index int) {
	id := fmt.Sprintf("W-%02d", index)
	wCtx, wCancel := context.WithCancel(p.rootCtx)
	p.workerCancel[id] = wCancel
	state := "idle"
	if p.paused {
		state = "paused"
	}
	p.slots = append(p.slots, domain.WorkerSlot{
		ID:    id,
		State: state,
	})
	p.wg.Add(1)
	go p.workerLoop(wCtx, id)
}

func (p *WorkerPool) Wake() {
	select {
	case p.wakeCh <- struct{}{}:
	default:
	}
}

func (p *WorkerPool) SetPaused(paused bool) domain.PoolStatus {
	p.mu.Lock()
	p.paused = paused
	for i := range p.slots {
		if p.slots[i].JobID == "" {
			if paused {
				p.slots[i].State = "paused"
			} else {
				p.slots[i].State = "idle"
			}
		}
	}
	p.mu.Unlock()

	if !paused {
		p.Wake()
	}
	st := p.Status()
	p.broker.Publish("pool.updated", st)
	return st
}

func (p *WorkerPool) SetConcurrency(target int) (domain.PoolStatus, error) {
	if target < MinPoolWorkers || target > MaxPoolWorkers {
		return domain.PoolStatus{}, &domain.ValidationError{
			Details: []domain.FieldError{{
				Field: "concurrency",
				Issue: fmt.Sprintf("Concurrency must be between %d and %d", MinPoolWorkers, MaxPoolWorkers),
			}},
		}
	}

	p.mu.Lock()
	if target > p.concurrency {
		for i := p.concurrency + 1; i <= target; i++ {
			p.spawnWorkerLocked(i)
		}
		p.concurrency = target
	} else if target < p.concurrency {
		for i := p.concurrency; i > target; i-- {
			id := fmt.Sprintf("W-%02d", i)
			if cancel, ok := p.workerCancel[id]; ok {
				cancel()
				delete(p.workerCancel, id)
			}
		}
		p.slots = p.slots[:target]
		p.concurrency = target
	}
	p.mu.Unlock()

	p.Wake()
	st := p.Status()
	p.broker.Publish("pool.updated", st)
	return st, nil
}

func (p *WorkerPool) CancelRunningJob(jobID string) bool {
	p.mu.Lock()
	cancel, ok := p.runningJobs[jobID]
	p.mu.Unlock()
	if ok {
		cancel()
		return true
	}
	return false
}

func (p *WorkerPool) Status() domain.PoolStatus {
	p.mu.Lock()
	defer p.mu.Unlock()

	slotsCopy := make([]domain.WorkerSlot, len(p.slots))
	busy := 0
	for i, s := range p.slots {
		slotsCopy[i] = s
		if s.State == "busy" {
			busy++
		}
	}

	return domain.PoolStatus{
		Runtime:     "Go Worker Pool + SQLite WAL",
		Paused:      p.paused,
		Concurrency: p.concurrency,
		MinWorkers:  MinPoolWorkers,
		MaxWorkers:  MaxPoolWorkers,
		BusyWorkers: busy,
		Slots:       slotsCopy,
		UptimeSec:   int64(time.Since(p.startedAt).Seconds()),
	}
}

func (p *WorkerPool) Shutdown(ctx context.Context) error {
	p.mu.Lock()
	p.stopping = true
	p.mu.Unlock()

	p.rootCancel()

	done := make(chan struct{})
	go func() {
		p.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (p *WorkerPool) workerLoop(ctx context.Context, workerID string) {
	defer p.wg.Done()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()

	for {
		if ctx.Err() != nil {
			return
		}

		if p.isPaused() {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				continue
			case <-p.wakeCh:
				continue
			}
		}

		job, err := p.repo.ClaimNextJob(ctx, workerID)
		if err != nil || job == nil {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			case <-p.wakeCh:
			}
			continue
		}

		p.executeClaimedJob(workerID, job)
	}
}

func (p *WorkerPool) isPaused() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.paused || p.stopping
}

func (p *WorkerPool) executeClaimedJob(workerID string, job *domain.Job) {
	started := time.Now()
	timeout := time.Duration(job.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 15 * time.Second
	}
	jobCtx, jobCancel := context.WithTimeout(context.Background(), timeout)
	defer jobCancel()

	p.mu.Lock()
	p.runningJobs[job.ID] = jobCancel
	p.updateSlotLocked(workerID, func(s *domain.WorkerSlot) {
		s.State = "busy"
		s.JobID = job.ID
		s.JobName = job.Name
		s.JobType = job.Type
		s.Progress = 0
		s.StartedAt = &started
	})
	p.mu.Unlock()

	p.broker.Publish("job.updated", job)
	p.broker.Publish("pool.updated", p.Status())

	res, summary, execErr := p.executor.Execute(jobCtx, job, func(pct int, logLine string) {
		_ = p.repo.UpdateProgress(context.Background(), job.ID, pct)
		if logLine != "" {
			_ = p.repo.AppendLog(context.Background(), job.ID, "info", logLine)
		}
		p.mu.Lock()
		p.updateSlotLocked(workerID, func(s *domain.WorkerSlot) {
			s.Progress = pct
		})
		p.mu.Unlock()
		p.broker.Publish("job.progress", map[string]any{
			"jobId":    job.ID,
			"workerId": workerID,
			"progress": pct,
		})
	})

	elapsedMs := time.Since(started).Milliseconds()
	if elapsedMs < 1 {
		elapsedMs = 1
	}

	p.mu.Lock()
	delete(p.runningJobs, job.ID)
	wasCancelled := errors.Is(execErr, context.Canceled)
	failedOutcome := execErr != nil && !wasCancelled
	p.updateSlotLocked(workerID, func(s *domain.WorkerSlot) {
		if p.paused {
			s.State = "paused"
		} else {
			s.State = "idle"
		}
		s.JobID = ""
		s.JobName = ""
		s.JobType = ""
		s.Progress = 0
		s.StartedAt = nil
		if failedOutcome {
			s.Failed++
		} else if !wasCancelled {
			s.Processed++
		}
	})
	p.mu.Unlock()

	if wasCancelled {
		_ = p.repo.MarkCancelled(context.Background(), job.ID, "Cancelled while running")
	} else if execErr != nil {
		msg := execErr.Error()
		if errors.Is(execErr, context.DeadlineExceeded) {
			msg = fmt.Sprintf("execution exceeded timeout (%dms)", job.TimeoutMs)
		}
		_, _, _ = p.repo.MarkRetryOrDeadLetter(context.Background(), job, msg, elapsedMs)
	} else {
		_ = p.repo.MarkCompleted(context.Background(), job.ID, res, elapsedMs, summary)
	}

	if refreshed, err := p.repo.GetJob(context.Background(), job.ID); err == nil {
		p.broker.Publish("job.updated", refreshed)
	}
	if metrics, err := p.repo.GetMetrics(context.Background()); err == nil {
		p.broker.Publish("metrics.updated", metrics)
	}
	p.broker.Publish("pool.updated", p.Status())
}

func (p *WorkerPool) updateSlotLocked(workerID string, fn func(s *domain.WorkerSlot)) {
	for i := range p.slots {
		if p.slots[i].ID == workerID {
			fn(&p.slots[i])
			return
		}
	}
}
