//go:build linux

package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/auth"
	"github.com/opsdeck/opsdeck/agent/internal/collector"
	"github.com/opsdeck/opsdeck/agent/internal/control"
	"github.com/opsdeck/opsdeck/agent/internal/server"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	listen := getenv("OPSDECK_AGENT_LISTEN", "127.0.0.1:9040")
	dockerSocket := getenv("OPSDECK_DOCKER_SOCKET", "/var/run/docker.sock")
	authSocket := getenv("OPSDECK_AUTH_SOCKET", "/run/opsdeck/auth.sock")
	controlSocket := getenv("OPSDECK_CONTROL_SOCKET", "/run/opsdeck/control.sock")
	token := os.Getenv("OPSDECK_AGENT_TOKEN")
	if token == "" {
		logger.Error("OPSDECK_AGENT_TOKEN is required")
		os.Exit(2)
	}

	authenticator := auth.New(authSocket)
	hostController := control.New(controlSocket)
	collector := collector.New(dockerSocket, hostController)
	handler := server.New(token, collector, collector, hostController, authenticator, logger).Handler()
	httpServer := &http.Server{
		Addr:              listen,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      90 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}

	shutdownSignal, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-shutdownSignal.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			logger.Error("agent shutdown failed", "error", err)
		}
	}()

	logger.Info("OpsDeck constrained agent listening", "address", listen)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
