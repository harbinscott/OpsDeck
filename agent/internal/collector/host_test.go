//go:build linux

package collector

import "testing"

func TestCPUUsagePercent(t *testing.T) {
	previous := cpuSample{total: 1000, idle: 600}
	current := cpuSample{total: 1200, idle: 680}
	got := cpuUsagePercent(previous, current)
	if got != 60 {
		t.Fatalf("expected 60 percent, got %v", got)
	}
}

func TestUnescapeMount(t *testing.T) {
	got := unescapeMount("/media/My\\040Disk")
	if got != "/media/My Disk" {
		t.Fatalf("unexpected mount path %q", got)
	}
}
