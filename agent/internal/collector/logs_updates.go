//go:build linux

package collector

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

func (c *Collector) collectLogs(ctx context.Context) []model.LogEntry {
	c.cacheMu.Lock()
	if time.Since(c.logsCachedAt) < 8*time.Second && c.logsCached != nil {
		cached := append([]model.LogEntry(nil), c.logsCached...)
		c.cacheMu.Unlock()
		return cached
	}
	c.cacheMu.Unlock()

	logs := readJournal(ctx)
	c.cacheMu.Lock()
	c.logsCached = append([]model.LogEntry(nil), logs...)
	c.logsCachedAt = time.Now()
	c.cacheMu.Unlock()
	return logs
}

func readJournal(parent context.Context) []model.LogEntry {
	if _, err := exec.LookPath("journalctl"); err != nil {
		return []model.LogEntry{}
	}
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "journalctl", "--output=json", "--lines=100", "--no-pager", "--priority=0..6")
	output, err := command.Output()
	if err != nil {
		return []model.LogEntry{}
	}

	entries := []model.LogEntry{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	scanner.Buffer(make([]byte, 64*1024), 2*1024*1024)
	for scanner.Scan() {
		var raw map[string]any
		if json.Unmarshal(scanner.Bytes(), &raw) != nil {
			continue
		}
		message := stringValue(raw["MESSAGE"])
		if message == "" {
			continue
		}
		priority, _ := strconv.Atoi(stringValue(raw["PRIORITY"]))
		severity := "info"
		if priority <= 3 {
			severity = "error"
		} else if priority == 4 {
			severity = "warning"
		}
		source := firstNonempty(stringValue(raw["CONTAINER_NAME"]), stringValue(raw["SYSLOG_IDENTIFIER"]), stringValue(raw["_SYSTEMD_UNIT"]), "journal")
		timestamp := time.Now().UTC()
		if micros, parseErr := strconv.ParseInt(stringValue(raw["__REALTIME_TIMESTAMP"]), 10, 64); parseErr == nil {
			timestamp = time.UnixMicro(micros).UTC()
		}
		entries = append(entries, model.LogEntry{Timestamp: timestamp, Severity: severity, Source: source, Message: message})
	}
	return entries
}

func (c *Collector) collectUpdates(ctx context.Context) model.Updates {
	c.cacheMu.Lock()
	if !c.updatesCached.CheckedAt.IsZero() && time.Since(c.updatesCached.CheckedAt) < 15*time.Minute {
		cached := c.updatesCached
		cached.Packages = append([]model.Update(nil), cached.Packages...)
		c.cacheMu.Unlock()
		return cached
	}
	c.cacheMu.Unlock()

	updates := readAPTUpdates(ctx)
	c.cacheMu.Lock()
	c.updatesCached = updates
	c.cacheMu.Unlock()
	return updates
}

func readAPTUpdates(parent context.Context) model.Updates {
	result := model.Updates{CheckedAt: time.Now().UTC(), Packages: []model.Update{}}
	if _, err := exec.LookPath("apt"); err != nil {
		result.Error = "APT is unavailable on this host"
		return result
	}
	ctx, cancel := context.WithTimeout(parent, 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "apt", "list", "--upgradable")
	output, err := command.Output()
	if err != nil && len(output) == 0 {
		result.Error = "APT update inventory could not be read"
		return result
	}

	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "Listing...") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		nameAndSource := strings.SplitN(fields[0], "/", 2)
		if len(nameAndSource) != 2 {
			continue
		}
		current := ""
		if marker := strings.Index(line, "upgradable from: "); marker >= 0 {
			current = strings.TrimSuffix(strings.TrimSpace(line[marker+len("upgradable from: "):]), "]")
		}
		security := strings.Contains(strings.ToLower(nameAndSource[1]), "security")
		result.Packages = append(result.Packages, model.Update{Package: nameAndSource[0], Source: nameAndSource[1], CandidateVersion: fields[1], CurrentVersion: current, Security: security})
		if security {
			result.Security++
		}
	}
	result.Available = len(result.Packages)
	return result
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return ""
	}
}

func firstNonempty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func updateSummary(update model.Update) string {
	return fmt.Sprintf("%s %s -> %s", update.Package, update.CurrentVersion, update.CandidateVersion)
}
