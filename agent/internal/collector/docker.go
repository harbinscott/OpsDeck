//go:build linux

package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type dockerContainer struct {
	ID      string            `json:"Id"`
	Names   []string          `json:"Names"`
	Image   string            `json:"Image"`
	State   string            `json:"State"`
	Status  string            `json:"Status"`
	Created int64             `json:"Created"`
	Labels  map[string]string `json:"Labels"`
	Ports   []struct {
		IP          string `json:"IP"`
		PrivatePort uint16 `json:"PrivatePort"`
		PublicPort  uint16 `json:"PublicPort"`
		Type        string `json:"Type"`
	} `json:"Ports"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint32 `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64 `json:"usage"`
		Stats struct {
			Cache        uint64 `json:"cache"`
			InactiveFile uint64 `json:"inactive_file"`
		} `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

func collectDocker(ctx context.Context, socket string) model.Docker {
	client := dockerClient(socket)
	var version struct {
		Version string `json:"Version"`
	}
	if err := dockerGet(ctx, client, "/version", &version); err != nil {
		return model.Docker{Connected: false, Error: friendlyDockerError(err), Containers: []model.Container{}}
	}

	var raw []dockerContainer
	if err := dockerGet(ctx, client, "/containers/json?all=1", &raw); err != nil {
		return model.Docker{Connected: true, Version: version.Version, Error: err.Error(), Containers: []model.Container{}}
	}

	containers := make([]model.Container, len(raw))
	var wg sync.WaitGroup
	semaphore := make(chan struct{}, 8)
	for index := range raw {
		index := index
		wg.Add(1)
		go func() {
			defer wg.Done()
			semaphore <- struct{}{}
			defer func() { <-semaphore }()
			containers[index] = mapDockerContainer(ctx, client, raw[index])
		}()
	}
	wg.Wait()
	sort.Slice(containers, func(i, j int) bool { return containers[i].Name < containers[j].Name })
	return model.Docker{Connected: true, Version: version.Version, Containers: containers}
}

func dockerClient(socket string) *http.Client {
	transport := &http.Transport{
		DisableCompression: true,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socket)
		},
	}
	return &http.Client{Transport: transport, Timeout: 7 * time.Second}
}

func dockerGet(ctx context.Context, client *http.Client, path string, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("Docker returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return json.NewDecoder(io.LimitReader(response.Body, 32<<20)).Decode(target)
}

func dockerPost(ctx context.Context, client *http.Client, path string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://docker"+path, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fmt.Errorf("Docker returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	return nil
}

func (c *Collector) ContainerAction(ctx context.Context, id, action string) error {
	if len(id) < 12 || len(id) > 64 {
		return fmt.Errorf("invalid container identifier")
	}
	for _, character := range id {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return fmt.Errorf("invalid container identifier")
		}
	}
	path := "/containers/" + url.PathEscape(id)
	switch action {
	case "start":
		path += "/start"
	case "stop":
		path += "/stop?t=10"
	case "restart":
		path += "/restart?t=10"
	default:
		return fmt.Errorf("unsupported container action")
	}
	return dockerPost(ctx, dockerClient(c.dockerSocket), path)
}

func mapDockerContainer(ctx context.Context, client *http.Client, raw dockerContainer) model.Container {
	name := strings.TrimPrefix(first(raw.Names), "/")
	if name == "" {
		name = shortID(raw.ID)
	}
	state := "stopped"
	health := titleCase(raw.State)
	if raw.State == "running" {
		state = "running"
		health = "Running"
	}
	statusLower := strings.ToLower(raw.Status)
	if strings.Contains(statusLower, "unhealthy") {
		state = "unhealthy"
		health = "Health check failing"
	} else if strings.Contains(statusLower, "healthy") {
		health = "Healthy"
	}

	container := model.Container{
		ID:             raw.ID,
		Name:           name,
		Image:          raw.Image,
		State:          state,
		Health:         health,
		Ports:          mapPorts(raw.Ports),
		CreatedAt:      time.Unix(raw.Created, 0).UTC(),
		ComposeProject: raw.Labels["com.docker.compose.project"],
		ComposeService: raw.Labels["com.docker.compose.service"],
	}

	if raw.State != "running" {
		return container
	}
	statsPath := "/containers/" + url.PathEscape(raw.ID) + "/stats?stream=false&one-shot=true"
	var stats dockerStats
	if err := dockerGet(ctx, client, statsPath, &stats); err != nil {
		return container
	}
	container.CPUPercent = round(dockerCPUPercent(stats), 1)
	cache := stats.MemoryStats.Stats.InactiveFile
	if cache == 0 {
		cache = stats.MemoryStats.Stats.Cache
	}
	if stats.MemoryStats.Usage >= cache {
		container.MemoryBytes = stats.MemoryStats.Usage - cache
	} else {
		container.MemoryBytes = stats.MemoryStats.Usage
	}
	for _, network := range stats.Networks {
		container.NetworkRxBytes += network.RxBytes
		container.NetworkTxBytes += network.TxBytes
	}
	return container
}

func dockerCPUPercent(stats dockerStats) float64 {
	cpuDelta := stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage
	systemDelta := stats.CPUStats.SystemUsage - stats.PreCPUStats.SystemUsage
	if cpuDelta == 0 || systemDelta == 0 {
		return 0
	}
	count := stats.CPUStats.OnlineCPUs
	if count == 0 {
		count = uint32(len(stats.CPUStats.CPUUsage.PercpuUsage))
	}
	if count == 0 {
		count = 1
	}
	return float64(cpuDelta) / float64(systemDelta) * float64(count) * 100
}

func mapPorts(ports []struct {
	IP          string `json:"IP"`
	PrivatePort uint16 `json:"PrivatePort"`
	PublicPort  uint16 `json:"PublicPort"`
	Type        string `json:"Type"`
}) []string {
	mapped := make([]string, 0, len(ports))
	for _, port := range ports {
		if port.PublicPort > 0 {
			mapped = append(mapped, fmt.Sprintf("%d:%d/%s", port.PublicPort, port.PrivatePort, port.Type))
		} else {
			mapped = append(mapped, fmt.Sprintf("%d/%s", port.PrivatePort, port.Type))
		}
	}
	sort.Strings(mapped)
	return mapped
}

func friendlyDockerError(err error) string {
	message := err.Error()
	if strings.Contains(strings.ToLower(message), "permission denied") {
		return "permission denied while opening the Docker socket"
	}
	if strings.Contains(strings.ToLower(message), "no such file") {
		return "Docker socket was not found"
	}
	return message
}

func first(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

func shortID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func titleCase(value string) string {
	if value == "" {
		return "Unknown"
	}
	return strings.ToUpper(value[:1]) + value[1:]
}
