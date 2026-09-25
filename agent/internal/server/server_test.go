package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type testSnapshotter struct{}

func (testSnapshotter) Snapshot(context.Context) model.Snapshot {
	return model.Snapshot{SchemaVersion: 1, Warnings: []string{}}
}

func (testSnapshotter) AnalyzeStorage(context.Context, string) (model.StorageAnalysis, error) {
	return model.StorageAnalysis{}, nil
}

func (testSnapshotter) CleanupCandidates(context.Context) []model.CleanupCandidate { return nil }

func (testSnapshotter) DockerCleanup(context.Context, string) (uint64, error) {
	return 4096, nil
}

type testController struct{}

func (testController) ContainerAction(context.Context, string, string) error { return nil }

type testHostController struct{}

func (testHostController) HostAction(context.Context, string) error            { return nil }
func (testHostController) ServiceAction(context.Context, string, string) error { return nil }

type testAuthenticator struct{ allowed bool }

func (a testAuthenticator) Authenticate(context.Context, string, string) (bool, error) {
	return a.allowed, nil
}

func TestSnapshotRequiresBearerToken(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: true}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()

	unauthorized := httptest.NewRequest(http.MethodGet, "/v1/snapshot", nil)
	unauthorizedResult := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResult, unauthorized)
	if unauthorizedResult.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorizedResult.Code)
	}

	authorized := httptest.NewRequest(http.MethodGet, "/v1/snapshot", nil)
	authorized.Header.Set("Authorization", "Bearer correct-token")
	authorizedResult := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResult, authorized)
	if authorizedResult.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorizedResult.Code)
	}
}

func TestContainerActionRequiresBearerToken(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: true}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()
	unauthorized := httptest.NewRequest(http.MethodPost, "/v1/containers/0123456789abcdef/restart", nil)
	unauthorizedResult := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResult, unauthorized)
	if unauthorizedResult.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", unauthorizedResult.Code)
	}
	authorized := httptest.NewRequest(http.MethodPost, "/v1/containers/0123456789abcdef/restart", nil)
	authorized.Header.Set("Authorization", "Bearer correct-token")
	authorizedResult := httptest.NewRecorder()
	handler.ServeHTTP(authorizedResult, authorized)
	if authorizedResult.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", authorizedResult.Code)
	}
}

func TestElevationAuthenticatesLinuxCredentials(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: true}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/elevate", strings.NewReader(`{"username":"admin","password":"sudo-password"}`))
	request.Header.Set("Authorization", "Bearer correct-token")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", result.Code, result.Body.String())
	}
}

func TestElevationRejectsUnauthorizedAccount(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: false}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()
	request := httptest.NewRequest(http.MethodPost, "/v1/auth/elevate", strings.NewReader(`{"username":"viewer","password":"password"}`))
	request.Header.Set("Authorization", "Bearer correct-token")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", result.Code)
	}
}

func TestSystemActionRunsAsTrackableJob(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: true}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()
	request := httptest.NewRequest(http.MethodPost, "/v1/system/refresh-repositories", nil)
	request.Header.Set("Authorization", "Bearer correct-token")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", result.Code, result.Body.String())
	}
	var payload struct {
		Job SystemJob `json:"job"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 20; attempt++ {
		statusRequest := httptest.NewRequest(http.MethodGet, "/v1/system/jobs/"+payload.Job.ID, nil)
		statusRequest.Header.Set("Authorization", "Bearer correct-token")
		statusResult := httptest.NewRecorder()
		handler.ServeHTTP(statusResult, statusRequest)
		var status struct {
			Job SystemJob `json:"job"`
		}
		if err := json.Unmarshal(statusResult.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status.Job.Status == "completed" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("system job did not complete")
}

func TestDockerCleanupRunsAsTrackableJob(t *testing.T) {
	handler := New("correct-token", testSnapshotter{}, testController{}, testHostController{}, testAuthenticator{allowed: true}, slog.New(slog.NewTextHandler(io.Discard, nil))).Handler()
	request := httptest.NewRequest(http.MethodPost, "/v1/storage/cleanup/docker-build-cache", nil)
	request.Header.Set("Authorization", "Bearer correct-token")
	result := httptest.NewRecorder()
	handler.ServeHTTP(result, request)
	if result.Code != http.StatusAccepted {
		t.Fatalf("expected 202, got %d: %s", result.Code, result.Body.String())
	}
	var payload struct {
		Job SystemJob `json:"job"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 20; attempt++ {
		statusRequest := httptest.NewRequest(http.MethodGet, "/v1/system/jobs/"+payload.Job.ID, nil)
		statusRequest.Header.Set("Authorization", "Bearer correct-token")
		statusResult := httptest.NewRecorder()
		handler.ServeHTTP(statusResult, statusRequest)
		var status struct {
			Job SystemJob `json:"job"`
		}
		if err := json.Unmarshal(statusResult.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if status.Job.Status == "completed" {
			if status.Job.ReclaimedBytes != 4096 {
				t.Fatalf("expected reclaimed bytes, got %d", status.Job.ReclaimedBytes)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Docker cleanup job did not complete")
}
