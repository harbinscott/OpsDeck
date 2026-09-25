//go:build linux

package collector

import (
	"bufio"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type cpuSample struct {
	total uint64
	idle  uint64
}

type networkSample struct {
	rx uint64
	tx uint64
}

type diskSample struct {
	readBytes  uint64
	writeBytes uint64
}

func collectHost() (model.Host, error) {
	hostname, hostErr := os.Hostname()
	osName, osErr := operatingSystemName("/etc/os-release")
	kernelBytes, kernelErr := os.ReadFile("/proc/sys/kernel/osrelease")
	uptime, uptimeErr := firstFloatFromFile("/proc/uptime")
	load, loadErr := firstFloatFromFile("/proc/loadavg")
	temperature := readTemperature()

	host := model.Host{
		Hostname:        hostname,
		OperatingSystem: osName,
		Kernel:          strings.TrimSpace(string(kernelBytes)),
		Architecture:    linuxArchitecture(runtime.GOARCH),
		UptimeSeconds:   uptime,
		CPUCount:        runtime.NumCPU(),
		Load1:           load,
		TemperatureC:    temperature,
	}

	return host, errors.Join(hostErr, osErr, kernelErr, uptimeErr, loadErr)
}

func (c *Collector) collectMetrics() (model.Metrics, error) {
	currentCPU, cpuErr := readCPUSample()
	currentNet, netErr := readNetworkSample()
	currentDisk, diskErr := readDiskSample()
	totalMemory, availableMemory, memoryErr := readMemory()
	now := time.Now()

	c.sampleMu.Lock()
	elapsed := now.Sub(c.previousAt).Seconds()
	cpuPercent := cpuUsagePercent(c.previousCPU, currentCPU)
	var rxRate, txRate, diskReadRate, diskWriteRate float64
	if elapsed > 0 && currentNet.rx >= c.previousNet.rx && currentNet.tx >= c.previousNet.tx {
		rxRate = float64(currentNet.rx-c.previousNet.rx) / elapsed
		txRate = float64(currentNet.tx-c.previousNet.tx) / elapsed
	}
	if elapsed > 0 && currentDisk.readBytes >= c.previousDisk.readBytes && currentDisk.writeBytes >= c.previousDisk.writeBytes {
		diskReadRate = float64(currentDisk.readBytes-c.previousDisk.readBytes) / elapsed
		diskWriteRate = float64(currentDisk.writeBytes-c.previousDisk.writeBytes) / elapsed
	}
	c.previousCPU = currentCPU
	c.previousNet = currentNet
	c.previousDisk = currentDisk
	c.previousAt = now
	c.sampleMu.Unlock()

	used := uint64(0)
	if totalMemory >= availableMemory {
		used = totalMemory - availableMemory
	}
	return model.Metrics{
		CPUPercent:              round(cpuPercent, 1),
		MemoryUsedBytes:         used,
		MemoryTotalBytes:        totalMemory,
		NetworkRxBytesPerSecond: round(rxRate, 1),
		NetworkTxBytesPerSecond: round(txRate, 1),
		DiskReadBytesPerSecond:  round(diskReadRate, 1),
		DiskWriteBytesPerSecond: round(diskWriteRate, 1),
	}, errors.Join(cpuErr, netErr, diskErr, memoryErr)
}

func readDiskSample() (diskSample, error) {
	file, err := os.Open("/proc/diskstats")
	if err != nil {
		return diskSample{}, err
	}
	defer file.Close()
	var sample diskSample
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 10 {
			continue
		}
		name := fields[2]
		if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") || strings.HasPrefix(name, "dm-") || strings.HasPrefix(name, "md") || strings.HasPrefix(name, "zram") {
			continue
		}
		if _, statErr := os.Stat(filepath.Join("/sys/block", name)); statErr != nil {
			continue
		}
		sectorsRead, readErr := strconv.ParseUint(fields[5], 10, 64)
		sectorsWritten, writeErr := strconv.ParseUint(fields[9], 10, 64)
		if readErr == nil && writeErr == nil {
			sample.readBytes += sectorsRead * 512
			sample.writeBytes += sectorsWritten * 512
		}
	}
	return sample, scanner.Err()
}

func operatingSystemName(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "Linux", err
	}
	defer file.Close()

	values := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if unquoted, unquoteErr := strconv.Unquote(value); unquoteErr == nil {
			value = unquoted
		}
		values[key] = value
	}
	if values["PRETTY_NAME"] != "" {
		return values["PRETTY_NAME"], scanner.Err()
	}
	if values["NAME"] != "" {
		return values["NAME"], scanner.Err()
	}
	return "Linux", scanner.Err()
}

func firstFloatFromFile(path string) (float64, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(string(bytes))
	if len(fields) == 0 {
		return 0, fmt.Errorf("%s was empty", path)
	}
	return strconv.ParseFloat(fields[0], 64)
}

func readCPUSample() (cpuSample, error) {
	file, err := os.Open("/proc/stat")
	if err != nil {
		return cpuSample{}, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	if !scanner.Scan() {
		return cpuSample{}, fmt.Errorf("/proc/stat did not contain a CPU row")
	}
	fields := strings.Fields(scanner.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return cpuSample{}, fmt.Errorf("unexpected /proc/stat CPU row")
	}
	values := make([]uint64, 0, len(fields)-1)
	for _, field := range fields[1:] {
		value, parseErr := strconv.ParseUint(field, 10, 64)
		if parseErr != nil {
			return cpuSample{}, parseErr
		}
		values = append(values, value)
	}
	var total uint64
	for _, value := range values {
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return cpuSample{total: total, idle: idle}, nil
}

func cpuUsagePercent(previous, current cpuSample) float64 {
	if current.total <= previous.total || current.idle < previous.idle {
		return 0
	}
	totalDelta := current.total - previous.total
	idleDelta := current.idle - previous.idle
	if totalDelta == 0 || idleDelta > totalDelta {
		return 0
	}
	return (1 - float64(idleDelta)/float64(totalDelta)) * 100
}

func readMemory() (total, available uint64, err error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		value, parseErr := strconv.ParseUint(fields[1], 10, 64)
		if parseErr != nil {
			continue
		}
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = value * 1024
		case "MemAvailable":
			available = value * 1024
		}
	}
	if total == 0 {
		return 0, 0, fmt.Errorf("MemTotal was unavailable")
	}
	return total, available, scanner.Err()
}

func readNetworkSample() (networkSample, error) {
	file, err := os.Open("/proc/net/dev")
	if err != nil {
		return networkSample{}, err
	}
	defer file.Close()
	var sample networkSample
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		name, values, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) == "lo" {
			continue
		}
		fields := strings.Fields(values)
		if len(fields) < 9 {
			continue
		}
		rx, rxErr := strconv.ParseUint(fields[0], 10, 64)
		tx, txErr := strconv.ParseUint(fields[8], 10, 64)
		if rxErr == nil && txErr == nil {
			sample.rx += rx
			sample.tx += tx
		}
	}
	return sample, scanner.Err()
}

func collectFilesystems() ([]model.Filesystem, error) {
	file, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return nil, err
	}
	defer file.Close()

	excluded := map[string]bool{"proc": true, "sysfs": true, "tmpfs": true, "devtmpfs": true, "devpts": true, "cgroup": true, "cgroup2": true, "overlay": true, "squashfs": true, "tracefs": true, "securityfs": true, "pstore": true, "autofs": true, "debugfs": true, "mqueue": true, "hugetlbfs": true, "fusectl": true, "nsfs": true, "ramfs": true, "bpf": true}
	seen := map[string]int{}
	filesystems := []model.Filesystem{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		left, right, ok := strings.Cut(scanner.Text(), " - ")
		if !ok {
			continue
		}
		leftFields := strings.Fields(left)
		rightFields := strings.Fields(right)
		if len(leftFields) < 5 || len(rightFields) < 2 || excluded[rightFields[0]] {
			continue
		}
		mount := unescapeMount(leftFields[4])
		filesystemID := leftFields[2]
		device := rightFields[1]
		if index, found := seen[filesystemID]; found {
			filesystems[index].Mounts = append(filesystems[index].Mounts, mount)
			if mount == "/" || (filesystems[index].Mount != "/" && len(mount) < len(filesystems[index].Mount)) {
				filesystems[index].Mount = mount
			}
			continue
		}
		var stats syscall.Statfs_t
		if statErr := syscall.Statfs(mount, &stats); statErr != nil || stats.Blocks == 0 {
			continue
		}
		blockSize := uint64(stats.Bsize)
		total := stats.Blocks * blockSize
		free := stats.Bfree * blockSize
		available := stats.Bavail * blockSize
		used := uint64(0)
		if total >= free {
			used = total - free
		}
		reserved := uint64(0)
		if free >= available {
			reserved = free - available
		}
		usedPercent := float64(0)
		if used+available > 0 {
			usedPercent = float64(used) / float64(used+available) * 100
		}
		inodesUsed := uint64(0)
		if stats.Files >= stats.Ffree {
			inodesUsed = stats.Files - stats.Ffree
		}
		inodesPercent := float64(0)
		if stats.Files > 0 {
			inodesPercent = float64(inodesUsed) / float64(stats.Files) * 100
		}
		readOnly := false
		if len(leftFields) > 5 {
			readOnly = strings.Contains(","+leftFields[5]+",", ",ro,")
		}
		filesystems = append(filesystems, model.Filesystem{
			ID: filesystemID, Device: device, Mount: mount, Mounts: []string{mount}, Type: rightFields[0],
			Category: filesystemCategory(device, rightFields[0]), ReadOnly: readOnly,
			TotalBytes: total, UsedBytes: used, AvailableBytes: available, ReservedBytes: reserved,
			UsedPercent: round(usedPercent, 1), InodesTotal: stats.Files, InodesUsed: inodesUsed,
			InodesUsedPercent: round(inodesPercent, 1),
		})
		seen[filesystemID] = len(filesystems) - 1
	}
	sort.Slice(filesystems, func(i, j int) bool {
		if filesystems[i].Mount == "/" {
			return true
		}
		if filesystems[j].Mount == "/" {
			return false
		}
		return filesystems[i].Mount < filesystems[j].Mount
	})
	return filesystems, scanner.Err()
}

func filesystemCategory(device, filesystemType string) string {
	if strings.HasPrefix(device, "/dev/") {
		return "local"
	}
	switch filesystemType {
	case "nfs", "nfs4", "cifs", "smb3", "sshfs", "fuse.sshfs":
		return "network"
	case "vfat", "exfat", "ntfs", "ntfs3":
		return "removable"
	default:
		return "other"
	}
}

func unescapeMount(value string) string {
	replacer := strings.NewReplacer("\\040", " ", "\\011", "\t", "\\012", "\n", "\\134", "\\")
	return replacer.Replace(value)
}

func readTemperature() *float64 {
	paths, _ := filepath.Glob("/sys/class/thermal/thermal_zone*/temp")
	for _, path := range paths {
		bytes, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		value, err := strconv.ParseFloat(strings.TrimSpace(string(bytes)), 64)
		if err != nil {
			continue
		}
		if value > 1000 {
			value /= 1000
		}
		if value > 0 && value < 130 {
			rounded := round(value, 1)
			return &rounded
		}
	}
	return nil
}

func linuxArchitecture(goarch string) string {
	switch goarch {
	case "amd64":
		return "x86_64"
	case "arm64":
		return "aarch64"
	default:
		return goarch
	}
}

func round(value float64, places int) float64 {
	factor := math.Pow10(places)
	return math.Round(value*factor) / factor
}
