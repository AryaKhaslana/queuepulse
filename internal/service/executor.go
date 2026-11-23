package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/AryaKhaslana/queuepulse/internal/domain"
)

type ProgressFunc func(percent int, logLine string)

type Executor struct {
	httpClient *http.Client
}

func NewExecutor() *Executor {
	return &Executor{
		httpClient: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
}

func (e *Executor) Execute(ctx context.Context, job *domain.Job, onProgress ProgressFunc) (json.RawMessage, string, error) {
	switch job.Type {
	case domain.TypeSimulateWork:
		return e.runSimulateWork(ctx, job, onProgress)
	case domain.TypeHTTPWebhook:
		return e.runHTTPWebhook(ctx, job, onProgress)
	case domain.TypeMediaProbe:
		return e.runMediaProbe(ctx, job, onProgress)
	case domain.TypeSystemCheck:
		return e.runSystemCheck(ctx, job, onProgress)
	default:
		return nil, "", fmt.Errorf("unsupported job type: %s", job.Type)
	}
}

type simulatePayload struct {
	DurationMs        int    `json:"durationMs"`
	Steps             int    `json:"steps"`
	FailUntilAttempt  int    `json:"failUntilAttempt"`
	AlwaysFail        bool   `json:"alwaysFail"`
	SimulatedErrorMsg string `json:"errorMessage"`
}

func (e *Executor) runSimulateWork(ctx context.Context, job *domain.Job, onProgress ProgressFunc) (json.RawMessage, string, error) {
	cfg := simulatePayload{
		DurationMs: 2400,
		Steps:      6,
	}
	if len(job.Payload) > 0 {
		_ = json.Unmarshal(job.Payload, &cfg)
	}
	if cfg.DurationMs < 150 {
		cfg.DurationMs = 150
	}
	if cfg.DurationMs > 30000 {
		cfg.DurationMs = 30000
	}
	if cfg.Steps < 2 {
		cfg.Steps = 2
	}
	if cfg.Steps > 20 {
		cfg.Steps = 20
	}

	stepDur := time.Duration(cfg.DurationMs/cfg.Steps) * time.Millisecond
	failStep := cfg.Steps / 2
	if failStep < 1 {
		failStep = 1
	}

	for i := 1; i <= cfg.Steps; i++ {
		select {
		case <-ctx.Done():
			return nil, "", ctx.Err()
		case <-time.After(stepDur):
		}

		pct := (i * 100) / cfg.Steps
		if (cfg.AlwaysFail || (cfg.FailUntilAttempt > 0 && job.Attempts <= cfg.FailUntilAttempt)) && i == failStep {
			msg := strings.TrimSpace(cfg.SimulatedErrorMsg)
			if msg == "" {
				msg = fmt.Sprintf("upstream timeout simulated at step %d/%d", i, cfg.Steps)
			}
			return nil, "", errors.New(msg)
		}

		onProgress(pct, fmt.Sprintf("Processed chunk %d/%d (%d%%)", i, cfg.Steps, pct))
	}

	res, _ := json.Marshal(map[string]any{
		"stepsCompleted": cfg.Steps,
		"attempt":        job.Attempts,
		"status":         "ok",
	})
	return res, fmt.Sprintf("Completed %d steps on attempt %d", cfg.Steps, job.Attempts), nil
}

type webhookPayload struct {
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

func (e *Executor) runHTTPWebhook(ctx context.Context, job *domain.Job, onProgress ProgressFunc) (json.RawMessage, string, error) {
	var cfg webhookPayload
	if err := json.Unmarshal(job.Payload, &cfg); err != nil {
		return nil, "", fmt.Errorf("invalid webhook payload: %w", err)
	}

	rawURL := strings.TrimSpace(cfg.URL)
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, "", errors.New("webhook url must be a valid http:// or https:// URL")
	}

	method := strings.ToUpper(strings.TrimSpace(cfg.Method))
	if method == "" {
		method = http.MethodPost
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
	default:
		return nil, "", fmt.Errorf("unsupported HTTP method %q", method)
	}

	var bodyReader io.Reader
	if cfg.Body != nil && method != http.MethodGet {
		b, err := json.Marshal(cfg.Body)
		if err != nil {
			return nil, "", fmt.Errorf("marshal webhook body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequestWithContext(ctx, method, parsed.String(), bodyReader)
	if err != nil {
		return nil, "", err
	}
	if bodyReader != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("User-Agent", "QueuePulse/1.0")
	for k, v := range cfg.Headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}

	onProgress(25, fmt.Sprintf("Sending %s %s", method, parsed.Host))
	start := time.Now()
	resp, err := e.httpClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	onProgress(75, fmt.Sprintf("Received HTTP %d in %dms", resp.StatusCode, time.Since(start).Milliseconds()))
	snippetBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	snippet := strings.TrimSpace(string(snippetBytes))

	if resp.StatusCode >= 400 {
		return nil, "", fmt.Errorf("webhook returned HTTP %d: %s", resp.StatusCode, truncateString(snippet, 160))
	}

	res, _ := json.Marshal(map[string]any{
		"statusCode": resp.StatusCode,
		"latencyMs":  time.Since(start).Milliseconds(),
		"response":   truncateString(snippet, 400),
	})
	return res, fmt.Sprintf("HTTP %d from %s (%dms)", resp.StatusCode, parsed.Host, time.Since(start).Milliseconds()), nil
}

type mediaProbePayload struct {
	Path string `json:"path"`
}

func (e *Executor) runMediaProbe(ctx context.Context, job *domain.Job, onProgress ProgressFunc) (json.RawMessage, string, error) {
	var cfg mediaProbePayload
	if err := json.Unmarshal(job.Payload, &cfg); err != nil {
		return nil, "", fmt.Errorf("invalid media_probe payload: %w", err)
	}

	target := strings.TrimSpace(cfg.Path)
	if target == "" {
		return nil, "", errors.New("media_probe requires a non-empty file path")
	}
	if strings.HasPrefix(target, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			target = filepath.Join(home, target[2:])
		}
	}
	cleanPath := filepath.Clean(target)
	info, err := os.Stat(cleanPath)
	if err != nil {
		return nil, "", fmt.Errorf("file not accessible: %w", err)
	}
	if info.IsDir() {
		return nil, "", errors.New("target path is a directory, expected a media file")
	}

	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		home, _ := os.UserHomeDir()
		fallback := filepath.Join(home, ".local", "bin", "ffprobe")
		if _, statErr := os.Stat(fallback); statErr == nil {
			ffprobePath = fallback
		} else {
			return nil, "", errors.New("ffprobe binary not found in PATH or ~/.local/bin")
		}
	}

	onProgress(35, fmt.Sprintf("Probing %s (%d KB)", filepath.Base(cleanPath), info.Size()/1024))
	cmd := exec.CommandContext(ctx, ffprobePath, "-v", "error", "-show_format", "-show_streams", "-of", "json", cleanPath)
	out, err := cmd.Output()
	if err != nil {
		return nil, "", fmt.Errorf("ffprobe failed: %w", err)
	}

	onProgress(85, "Parsing stream metadata")
	var parsed struct {
		Format struct {
			FormatName string `json:"format_name"`
			Duration   string `json:"duration"`
			BitRate    string `json:"bit_rate"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width,omitempty"`
			Height    int    `json:"height,omitempty"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		return nil, "", fmt.Errorf("parse ffprobe JSON: %w", err)
	}

	res, _ := json.Marshal(map[string]any{
		"file":      filepath.Base(cleanPath),
		"sizeBytes": info.Size(),
		"format":    parsed.Format.FormatName,
		"duration":  parsed.Format.Duration,
		"bitRate":   parsed.Format.BitRate,
		"streams":   parsed.Streams,
	})
	return res, fmt.Sprintf("Probed %s (%s, %ds)", filepath.Base(cleanPath), parsed.Format.FormatName, parseSec(parsed.Format.Duration)), nil
}

type systemCheckPayload struct {
	Target string `json:"target"` // thermal | disk | runtime
}

func (e *Executor) runSystemCheck(ctx context.Context, job *domain.Job, onProgress ProgressFunc) (json.RawMessage, string, error) {
	cfg := systemCheckPayload{Target: "runtime"}
	if len(job.Payload) > 0 {
		_ = json.Unmarshal(job.Payload, &cfg)
	}

	onProgress(40, fmt.Sprintf("Collecting safe host telemetry (%s)", cfg.Target))
	select {
	case <-ctx.Done():
		return nil, "", ctx.Err()
	case <-time.After(200 * time.Millisecond):
	}

	host, _ := os.Hostname()
	result := map[string]any{
		"target":   cfg.Target,
		"hostname": host,
		"checked":  time.Now().UTC().Format(time.RFC3339),
	}

	switch cfg.Target {
	case "thermal":
		matches, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
		temps := make([]float64, 0, len(matches))
		for _, m := range matches {
			if raw, err := os.ReadFile(m); err == nil {
				var milli int
				if _, err := fmt.Sscanf(strings.TrimSpace(string(raw)), "%d", &milli); err == nil {
					temps = append(temps, float64(milli)/1000.0)
				}
			}
		}
		result["thermalZonesC"] = temps
	case "disk":
		cmd := exec.CommandContext(ctx, "df", "-h", "/")
		if out, err := cmd.Output(); err == nil {
			lines := strings.Split(strings.TrimSpace(string(out)), "\n")
			if len(lines) > 1 {
				result["rootDisk"] = strings.Fields(lines[1])
			}
		}
	default:
		wd, _ := os.Getwd()
		result["workingDir"] = wd
	}

	onProgress(90, "Telemetry snapshot ready")
	raw, _ := json.Marshal(result)
	return raw, fmt.Sprintf("Collected %s snapshot on %s", cfg.Target, host), nil
}

func truncateString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

func parseSec(raw string) int {
	var f float64
	_, _ = fmt.Sscanf(raw, "%f", &f)
	return int(f)
}
