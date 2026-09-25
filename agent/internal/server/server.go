package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type Snapshotter interface {
	Snapshot(context.Context) model.Snapshot
}

type ContainerController interface {
	ContainerAction(context.Context, string, string) error
}

type HostController interface {
	HostAction(context.Context, string) error
	ServiceAction(context.Context, string, string) error
}

type StorageController interface {
	AnalyzeStorage(context.Context, string) (model.StorageAnalysis, error)
	CleanupCandidates(context.Context) []model.CleanupCandidate
	DockerCleanup(context.Context, string) (uint64, error)
}

type UpdateInvalidator interface {
	InvalidateUpdates()
}

type Authenticator interface {
	Authenticate(context.Context, string, string) (bool, error)
}

type Server struct {
	token          string
	snapshotter    Snapshotter
	controller     ContainerController
	hostController HostController
	authenticator  Authenticator
	logger         *slog.Logger

	cacheMu        sync.Mutex
	cachedAt       time.Time
	cachedSnapshot model.Snapshot
	jobsMu         sync.Mutex
	jobs           map[string]*SystemJob
}

type SystemJob struct {
	ID             string     `json:"id"`
	Action         string     `json:"action"`
	Status         string     `json:"status"`
	StartedAt      time.Time  `json:"startedAt"`
	CompletedAt    *time.Time `json:"completedAt,omitempty"`
	Error          string     `json:"error,omitempty"`
	ReclaimedBytes uint64     `json:"reclaimedBytes,omitempty"`
}

func New(token string, snapshotter Snapshotter, controller ContainerController, hostController HostController, authenticator Authenticator, logger *slog.Logger) *Server {
	return &Server{token: token, snapshotter: snapshotter, controller: controller, hostController: hostController, authenticator: authenticator, logger: logger, jobs: map[string]*SystemJob{}}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /v1/snapshot", s.authorize(s.snapshot))
	mux.HandleFunc("POST /v1/containers/{id}/{action}", s.authorize(s.containerAction))
	mux.HandleFunc("POST /v1/system/{action}", s.authorize(s.startSystemAction))
	mux.HandleFunc("GET /v1/system/jobs/{id}", s.authorize(s.systemJob))
	mux.HandleFunc("GET /v1/system/jobs", s.authorize(s.systemJobs))
	mux.HandleFunc("GET /v1/storage/analysis", s.authorize(s.storageAnalysis))
	mux.HandleFunc("GET /v1/storage/cleanup", s.authorize(s.cleanupCandidates))
	mux.HandleFunc("POST /v1/storage/cleanup/{action}", s.authorize(s.dockerCleanup))
	mux.HandleFunc("POST /v1/services/{unit}/{action}", s.authorize(s.serviceAction))
	mux.HandleFunc("POST /v1/auth/elevate", s.authorize(s.elevate))
	return s.securityHeaders(mux)
}

func (s *Server) storageAnalysis(response http.ResponseWriter, request *http.Request) {
	controller, ok := s.snapshotter.(StorageController)
	if !ok {
		writeJSON(response, http.StatusNotImplemented, map[string]string{"error": "storage analysis is unavailable"})
		return
	}
	mount := request.URL.Query().Get("mount")
	if mount == "" || len(mount) > 4096 || !strings.HasPrefix(mount, "/") {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "a valid mount is required"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 50*time.Second)
	defer cancel()
	analysis, err := controller.AnalyzeStorage(ctx, mount)
	if err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"analysis": analysis})
}

func (s *Server) cleanupCandidates(response http.ResponseWriter, request *http.Request) {
	controller, ok := s.snapshotter.(StorageController)
	if !ok {
		writeJSON(response, http.StatusNotImplemented, map[string]string{"error": "cleanup analysis is unavailable"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	writeJSON(response, http.StatusOK, map[string]any{"candidates": controller.CleanupCandidates(ctx)})
}

func (s *Server) dockerCleanup(response http.ResponseWriter, request *http.Request) {
	controller, ok := s.snapshotter.(StorageController)
	if !ok {
		writeJSON(response, http.StatusNotImplemented, map[string]string{"error": "Docker cleanup is unavailable"})
		return
	}
	action := request.PathValue("action")
	if !allowedDockerCleanup(action) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "unsupported Docker cleanup action"})
		return
	}
	s.jobsMu.Lock()
	for _, existing := range s.jobs {
		if existing.Status == "running" {
			job := *existing
			s.jobsMu.Unlock()
			writeJSON(response, http.StatusConflict, map[string]any{"error": "another system action is already running", "job": job})
			return
		}
	}
	job := &SystemJob{ID: newJobID(), Action: action, Status: "running", StartedAt: time.Now().UTC()}
	s.jobs[job.ID] = job
	accepted := *job
	s.jobsMu.Unlock()
	s.logger.Warn("Docker cleanup accepted", "action", action, "job", job.ID, "actor", request.Header.Get("X-OpsDeck-Actor"))
	go s.runDockerCleanup(job.ID, action, controller)
	writeJSON(response, http.StatusAccepted, map[string]any{"job": accepted})
}

func (s *Server) runDockerCleanup(id, action string, controller StorageController) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	reclaimed, err := controller.DockerCleanup(ctx, action)
	completed := time.Now().UTC()
	s.jobsMu.Lock()
	job := s.jobs[id]
	job.CompletedAt = &completed
	job.ReclaimedBytes = reclaimed
	if err != nil {
		job.Status = "failed"
		job.Error = err.Error()
	} else {
		job.Status = "completed"
	}
	s.jobsMu.Unlock()
	s.cacheMu.Lock()
	s.cachedAt = time.Time{}
	s.cacheMu.Unlock()
	if err != nil {
		s.logger.Error("Docker cleanup failed", "action", action, "job", id, "error", err)
	} else {
		s.logger.Info("Docker cleanup completed", "action", action, "job", id, "reclaimedBytes", reclaimed)
	}
}

func allowedDockerCleanup(action string) bool {
	return action == "docker-containers" || action == "docker-images" || action == "docker-build-cache"
}

func (s *Server) serviceAction(response http.ResponseWriter, request *http.Request) {
	unit, action := request.PathValue("unit"), request.PathValue("action")
	if !validServiceUnit(unit) || (action != "start" && action != "stop" && action != "restart") {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "unsupported service action"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 90*time.Second)
	defer cancel()
	if err := s.hostController.ServiceAction(ctx, unit, action); err != nil {
		s.logger.Warn("service action failed", "unit", unit, "action", action, "error", err)
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.cacheMu.Lock()
	s.cachedAt = time.Time{}
	s.cacheMu.Unlock()
	s.logger.Warn("service action completed", "unit", unit, "action", action, "actor", request.Header.Get("X-OpsDeck-Actor"))
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok", "unit": unit, "action": action})
}

func validServiceUnit(unit string) bool {
	if len(unit) < 9 || len(unit) > 180 || !strings.HasSuffix(unit, ".service") {
		return false
	}
	for _, character := range unit {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '@' || character == '_' || character == '.' || character == '-') {
			return false
		}
	}
	return true
}

func (s *Server) startSystemAction(response http.ResponseWriter, request *http.Request) {
	action := request.PathValue("action")
	if !allowedSystemAction(action) {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "unsupported system action"})
		return
	}
	s.jobsMu.Lock()
	for _, existing := range s.jobs {
		if existing.Status == "running" {
			job := *existing
			s.jobsMu.Unlock()
			writeJSON(response, http.StatusConflict, map[string]any{"error": "another system action is already running", "job": job})
			return
		}
	}
	job := &SystemJob{ID: newJobID(), Action: action, Status: "running", StartedAt: time.Now().UTC()}
	s.jobs[job.ID] = job
	accepted := *job
	s.jobsMu.Unlock()
	s.logger.Warn("privileged system action accepted", "action", action, "job", job.ID)
	go s.runSystemAction(job.ID, action)
	writeJSON(response, http.StatusAccepted, map[string]any{"job": accepted})
}

func (s *Server) runSystemAction(id, action string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	err := s.hostController.HostAction(ctx, action)
	completed := time.Now().UTC()
	s.jobsMu.Lock()
	job := s.jobs[id]
	job.CompletedAt = &completed
	if err != nil {
		job.Status = "failed"
		job.Error = err.Error()
	} else {
		job.Status = "completed"
	}
	s.jobsMu.Unlock()
	if err == nil && (action == "refresh-repositories" || action == "install-updates") {
		if invalidator, ok := s.snapshotter.(UpdateInvalidator); ok {
			invalidator.InvalidateUpdates()
		}
	}
	s.cacheMu.Lock()
	s.cachedAt = time.Time{}
	s.cacheMu.Unlock()
	if err != nil {
		s.logger.Error("privileged system action failed", "action", action, "job", id, "error", err)
	} else {
		s.logger.Info("privileged system action completed", "action", action, "job", id)
	}
}

func (s *Server) systemJob(response http.ResponseWriter, request *http.Request) {
	s.jobsMu.Lock()
	job, found := s.jobs[request.PathValue("id")]
	if found {
		copy := *job
		s.jobsMu.Unlock()
		writeJSON(response, http.StatusOK, map[string]any{"job": copy})
		return
	}
	s.jobsMu.Unlock()
	writeJSON(response, http.StatusNotFound, map[string]string{"error": "system action was not found"})
}

func (s *Server) systemJobs(response http.ResponseWriter, _ *http.Request) {
	s.jobsMu.Lock()
	jobs := make([]SystemJob, 0, len(s.jobs))
	for _, job := range s.jobs {
		jobs = append(jobs, *job)
	}
	s.jobsMu.Unlock()
	writeJSON(response, http.StatusOK, map[string]any{"jobs": jobs})
}

func allowedSystemAction(action string) bool {
	switch action {
	case "refresh-repositories", "install-updates", "reboot", "poweroff", "cleanup-apt-cache", "cleanup-journals-30d", "cleanup-journals-1g", "cleanup-tempfiles":
		return true
	default:
		return false
	}
}

func newJobID() string {
	value := make([]byte, 12)
	if _, err := rand.Read(value); err == nil {
		return hex.EncodeToString(value)
	}
	return fmt.Sprintf("%x", time.Now().UnixNano())
}

func (s *Server) elevate(response http.ResponseWriter, request *http.Request) {
	request.Body = http.MaxBytesReader(response, request.Body, 4096)
	var credentials struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&credentials) != nil || credentials.Username == "" || credentials.Password == "" {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "invalid authentication request"})
		return
	}
	ctx, cancel := context.WithTimeout(request.Context(), 15*time.Second)
	defer cancel()
	authorized, err := s.authenticator.Authenticate(ctx, credentials.Username, credentials.Password)
	credentials.Password = ""
	if err != nil {
		s.logger.Error("PAM authentication broker failed", "error", err)
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"error": "PAM authentication is unavailable"})
		return
	}
	if !authorized {
		s.logger.Warn("administrative authentication rejected", "username", credentials.Username)
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "credentials were not accepted or the account is not authorized"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"authenticated": true, "username": credentials.Username})
}

func (s *Server) containerAction(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 20*time.Second)
	defer cancel()
	id, action := request.PathValue("id"), request.PathValue("action")
	if err := s.controller.ContainerAction(ctx, id, action); err != nil {
		s.logger.Warn("container action failed", "container", id, "action", action, "error", err)
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	s.cacheMu.Lock()
	s.cachedAt = time.Time{}
	s.cacheMu.Unlock()
	s.logger.Info("container action completed", "container", id, "action", action)
	writeJSON(response, http.StatusOK, map[string]string{"status": "ok", "action": action})
}

func (s *Server) health(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]any{"status": "ok", "schemaVersion": 1})
}

func (s *Server) snapshot(response http.ResponseWriter, request *http.Request) {
	s.cacheMu.Lock()
	if time.Since(s.cachedAt) < 4*time.Second && !s.cachedAt.IsZero() {
		cached := s.cachedSnapshot
		s.cacheMu.Unlock()
		writeJSON(response, http.StatusOK, cached)
		return
	}
	s.cacheMu.Unlock()

	ctx, cancel := context.WithTimeout(request.Context(), 25*time.Second)
	defer cancel()
	snapshot := s.snapshotter.Snapshot(ctx)

	s.cacheMu.Lock()
	s.cachedAt = time.Now()
	s.cachedSnapshot = snapshot
	s.cacheMu.Unlock()
	writeJSON(response, http.StatusOK, snapshot)
}

func (s *Server) authorize(next http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		if s.token == "" || len(provided) != len(s.token) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.token)) != 1 {
			s.logger.Warn("agent request rejected", "remote", request.RemoteAddr, "path", request.URL.Path)
			writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next(response, request)
	}
}

func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
		response.Header().Set("Referrer-Policy", "no-referrer")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(response, request)
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
