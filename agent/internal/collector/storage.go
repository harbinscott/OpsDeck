//go:build linux

package collector

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

const storageEntryLimit = 2_000_000

func (c *Collector) AnalyzeStorage(parent context.Context, requestedMount string) (model.StorageAnalysis, error) {
	filesystems, err := collectFilesystems()
	if err != nil {
		return model.StorageAnalysis{}, err
	}
	var selected *model.Filesystem
	for index := range filesystems {
		for _, mount := range filesystems[index].Mounts {
			if mount == requestedMount {
				selected = &filesystems[index]
				break
			}
		}
		if selected != nil {
			break
		}
	}
	if selected == nil {
		return model.StorageAnalysis{}, fmt.Errorf("the requested mount is not a reported filesystem")
	}
	started := time.Now()
	analysis := model.StorageAnalysis{Mount: requestedMount, FilesystemID: selected.ID, ScannedAt: started.UTC(), TopDirectories: []model.StorageEntry{}, TopFiles: []model.StorageEntry{}}
	rootInfo, err := os.Stat(requestedMount)
	if err != nil {
		return analysis, err
	}
	rootStat, ok := rootInfo.Sys().(*syscall.Stat_t)
	if !ok {
		return analysis, fmt.Errorf("filesystem identity was unavailable")
	}
	directorySizes := map[string]uint64{}
	ctx, cancel := context.WithTimeout(parent, 45*time.Second)
	defer cancel()
	err = filepath.WalkDir(requestedMount, func(path string, entry fs.DirEntry, walkErr error) error {
		if ctx.Err() != nil {
			analysis.Truncated = true
			return fs.SkipAll
		}
		if analysis.EntriesVisited >= storageEntryLimit {
			analysis.Truncated = true
			return fs.SkipAll
		}
		analysis.EntriesVisited++
		if walkErr != nil {
			analysis.PermissionErrors++
			if entry != nil && entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		info, infoErr := entry.Info()
		if infoErr != nil {
			analysis.PermissionErrors++
			return nil
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if ok && stat.Dev != rootStat.Dev {
			analysis.CrossMountsSkipped++
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		relative, relativeErr := filepath.Rel(requestedMount, path)
		if relativeErr != nil || relative == "." {
			return nil
		}
		first := strings.Split(relative, string(filepath.Separator))[0]
		directorySizes[filepath.Join(requestedMount, first)] += uint64(max64(info.Size(), 0))
		if info.Mode().IsRegular() {
			addTopStorageEntry(&analysis.TopFiles, model.StorageEntry{Path: path, SizeBytes: uint64(max64(info.Size(), 0)), Modified: timePointer(info.ModTime().UTC())}, 5)
		}
		return nil
	})
	if err != nil && ctx.Err() == nil {
		return analysis, err
	}
	for path, size := range directorySizes {
		analysis.TopDirectories = append(analysis.TopDirectories, model.StorageEntry{Path: path, SizeBytes: size})
	}
	sort.Slice(analysis.TopDirectories, func(i, j int) bool {
		return analysis.TopDirectories[i].SizeBytes > analysis.TopDirectories[j].SizeBytes
	})
	if len(analysis.TopDirectories) > 5 {
		analysis.TopDirectories = analysis.TopDirectories[:5]
	}
	analysis.DurationMillis = time.Since(started).Milliseconds()
	analysis.ScannedAt = time.Now().UTC()
	return analysis, nil
}

func addTopStorageEntry(entries *[]model.StorageEntry, candidate model.StorageEntry, limit int) {
	*entries = append(*entries, candidate)
	sort.Slice(*entries, func(i, j int) bool { return (*entries)[i].SizeBytes > (*entries)[j].SizeBytes })
	if len(*entries) > limit {
		*entries = (*entries)[:limit]
	}
}

func timePointer(value time.Time) *time.Time { return &value }
func max64(value, minimum int64) int64 {
	if value < minimum {
		return minimum
	}
	return value
}

func (c *Collector) CleanupCandidates(parent context.Context) []model.CleanupCandidate {
	candidates := []model.CleanupCandidate{}
	usage := map[string]uint64{}
	if c.inspector != nil {
		ctx, cancel := context.WithTimeout(parent, 12*time.Second)
		if output, err := c.inspector.Inspect(ctx, "cleanup-usage"); err == nil {
			usage = parseDUUsage(output)
		}
		cancel()
		ctx, cancel = context.WithTimeout(parent, 8*time.Second)
		if output, err := c.inspector.Inspect(ctx, "journal-usage"); err == nil {
			size := parseJournalUsage(string(output))
			candidates = append(candidates, model.CleanupCandidate{ID: "journals-30d", Label: "Archived system journals", Description: "Remove archived journal files older than 30 days.", ReclaimableBytes: size, Risk: "low", Action: "cleanup-journals-30d", Available: size > 0, Detail: "Active journal files are retained."})
			candidates = append(candidates, model.CleanupCandidate{ID: "journals-1g", Label: "Limit archived journals to 1 GB", Description: "Remove the oldest archived journals until their total is below 1 GB.", ReclaimableBytes: journalReclaimableAbove(size, 1<<30), Risk: "low", Action: "cleanup-journals-1g", Available: size > 1<<30, Detail: "Use either journal option, not both."})
		}
		cancel()
	}
	aptSize := usage["/var/cache/apt/archives"]
	temporarySize := usage["/tmp"] + usage["/var/tmp"]
	candidates = append(candidates,
		model.CleanupCandidate{ID: "apt-cache", Label: "APT package cache", Description: "Remove downloaded package archives. Installed packages are not removed.", ReclaimableBytes: aptSize, Risk: "low", Action: "cleanup-apt-cache", Available: aptSize > 0},
		model.CleanupCandidate{ID: "temporary-files", Label: "Expired temporary files", Description: "Apply the host's configured systemd-tmpfiles retention policy.", ReclaimableBytes: temporarySize, Risk: "low", Action: "cleanup-tempfiles", Available: temporarySize > 0, Detail: "The reported size is an upper bound; only policy-expired files are removed."},
	)
	candidates = append(candidates, c.dockerCleanupCandidates(parent)...)
	return candidates
}

func parseDUUsage(output []byte) map[string]uint64 {
	result := map[string]uint64{}
	scanner := bufio.NewScanner(strings.NewReader(string(output)))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			size, _ := strconv.ParseUint(fields[0], 10, 64)
			result[fields[1]] = size
		}
	}
	return result
}

func parseJournalUsage(value string) uint64 {
	fields := strings.Fields(value)
	for index := 0; index+1 < len(fields); index++ {
		if parsed, err := strconv.ParseFloat(fields[index], 64); err == nil {
			unit := strings.Trim(fields[index+1], ".")
			multipliers := map[string]float64{"B": 1, "K": 1 << 10, "KB": 1 << 10, "M": 1 << 20, "MB": 1 << 20, "G": 1 << 30, "GB": 1 << 30, "T": 1 << 40, "TB": 1 << 40}
			if multiplier, found := multipliers[strings.ToUpper(unit)]; found {
				return uint64(parsed * multiplier)
			}
		}
	}
	return 0
}

func journalReclaimableAbove(size, target uint64) uint64 {
	if size > target {
		return size - target
	}
	return 0
}

type dockerDiskUsage struct {
	Images []struct {
		ID         string `json:"Id"`
		Size       int64  `json:"Size"`
		SharedSize int64  `json:"SharedSize"`
		Containers int64  `json:"Containers"`
	} `json:"Images"`
	Containers []struct {
		ID     string `json:"Id"`
		SizeRw int64  `json:"SizeRw"`
		State  string `json:"State"`
	} `json:"Containers"`
	Volumes []struct {
		Name      string `json:"Name"`
		UsageData struct {
			Size     int64 `json:"Size"`
			RefCount int64 `json:"RefCount"`
		} `json:"UsageData"`
	} `json:"Volumes"`
	BuildCache []struct {
		ID    string `json:"ID"`
		Size  int64  `json:"Size"`
		InUse bool   `json:"InUse"`
	} `json:"BuildCache"`
}

func (c *Collector) dockerCleanupCandidates(parent context.Context) []model.CleanupCandidate {
	client := dockerClient(c.dockerSocket)
	var usage dockerDiskUsage
	if err := dockerGet(parent, client, "/system/df", &usage); err != nil {
		return []model.CleanupCandidate{}
	}
	var containerBytes, imageBytes, buildBytes, volumeBytes uint64
	for _, container := range usage.Containers {
		if container.State != "running" {
			containerBytes += uint64(max64(container.SizeRw, 0))
		}
	}
	for _, image := range usage.Images {
		if image.Containers <= 0 {
			imageBytes += uint64(max64(image.Size-image.SharedSize, 0))
		}
	}
	for _, cache := range usage.BuildCache {
		if !cache.InUse {
			buildBytes += uint64(max64(cache.Size, 0))
		}
	}
	for _, volume := range usage.Volumes {
		if volume.UsageData.RefCount <= 0 {
			volumeBytes += uint64(max64(volume.UsageData.Size, 0))
		}
	}
	return []model.CleanupCandidate{
		{ID: "docker-containers", Label: "Stopped Docker containers", Description: "Remove stopped containers while retaining their named volumes.", ReclaimableBytes: containerBytes, Risk: "medium", Action: "docker-containers", Available: containerBytes > 0},
		{ID: "docker-images", Label: "Dangling Docker images", Description: "Remove untagged image layers not referenced by a container.", ReclaimableBytes: imageBytes, Risk: "medium", Action: "docker-images", Available: imageBytes > 0},
		{ID: "docker-build-cache", Label: "Unused Docker build cache", Description: "Remove build cache that is not currently in use.", ReclaimableBytes: buildBytes, Risk: "low", Action: "docker-build-cache", Available: buildBytes > 0},
		{ID: "docker-volumes", Label: "Unattached Docker volumes", Description: "Review only. OpsDeck never automatically removes volumes.", ReclaimableBytes: volumeBytes, Risk: "high", Action: "", Available: false, Detail: "Volume deletion is intentionally unavailable because volumes may contain irreplaceable application data."},
	}
}

func (c *Collector) DockerCleanup(parent context.Context, action string) (uint64, error) {
	path := ""
	switch action {
	case "docker-containers":
		path = "/containers/prune"
	case "docker-images":
		path = "/images/prune"
	case "docker-build-cache":
		path = "/build/prune"
	default:
		return 0, fmt.Errorf("unsupported Docker cleanup action")
	}
	request, err := http.NewRequestWithContext(parent, http.MethodPost, "http://docker"+path, nil)
	if err != nil {
		return 0, err
	}
	// Pruning large build caches may legitimately take many minutes. The
	// caller supplies the operation deadline; the inventory client's short
	// timeout must not terminate a cleanup after seven seconds.
	client := dockerClient(c.dockerSocket)
	client.Timeout = 0
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("Docker returned HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
	}
	var result struct {
		SpaceReclaimed uint64 `json:"SpaceReclaimed"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		return 0, err
	}
	return result.SpaceReclaimed, nil
}
