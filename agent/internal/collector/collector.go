//go:build linux

package collector

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type Collector struct {
	dockerSocket string
	inspector    interface {
		Inspect(context.Context, string) ([]byte, error)
	}

	sampleMu     sync.Mutex
	previousCPU  cpuSample
	previousNet  networkSample
	previousDisk diskSample
	previousAt   time.Time

	cacheMu       sync.Mutex
	logsCachedAt  time.Time
	logsCached    []model.LogEntry
	updatesCached model.Updates
}

func New(dockerSocket string, inspector interface {
	Inspect(context.Context, string) ([]byte, error)
}) *Collector {
	c := &Collector{dockerSocket: dockerSocket, inspector: inspector}
	c.previousCPU, _ = readCPUSample()
	c.previousNet, _ = readNetworkSample()
	c.previousDisk, _ = readDiskSample()
	c.previousAt = time.Now()
	return c
}

func (c *Collector) InvalidateUpdates() {
	c.cacheMu.Lock()
	c.updatesCached = model.Updates{}
	c.cacheMu.Unlock()
}

func (c *Collector) Snapshot(ctx context.Context) model.Snapshot {
	var snapshot model.Snapshot
	snapshot.SchemaVersion = 1
	snapshot.CollectedAt = time.Now().UTC()
	snapshot.Warnings = []string{}

	var wg sync.WaitGroup
	var hostErr, metricsErr, fsErr error

	wg.Add(7)
	go func() {
		defer wg.Done()
		snapshot.Host, hostErr = collectHost()
	}()
	go func() {
		defer wg.Done()
		snapshot.Services = collectServices(ctx)
	}()
	go func() {
		defer wg.Done()
		snapshot.Security = collectSecurity(ctx, c.inspector)
	}()
	go func() {
		defer wg.Done()
		snapshot.Metrics, metricsErr = c.collectMetrics()
	}()
	go func() {
		defer wg.Done()
		snapshot.Filesystems, fsErr = collectFilesystems()
	}()
	go func() {
		defer wg.Done()
		snapshot.Docker = collectDocker(ctx, c.dockerSocket)
	}()
	go func() {
		defer wg.Done()
		snapshot.Logs = c.collectLogs(ctx)
		snapshot.Updates = c.collectUpdates(ctx)
	}()
	wg.Wait()

	if hostErr != nil {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("host: %v", hostErr))
	}
	if metricsErr != nil {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("metrics: %v", metricsErr))
	}
	if fsErr != nil {
		snapshot.Warnings = append(snapshot.Warnings, fmt.Sprintf("filesystems: %v", fsErr))
	}
	if snapshot.Docker.Error != "" {
		snapshot.Warnings = append(snapshot.Warnings, "docker: "+snapshot.Docker.Error)
	}
	if snapshot.Updates.Error != "" {
		snapshot.Warnings = append(snapshot.Warnings, "updates: "+snapshot.Updates.Error)
	}
	return snapshot
}
