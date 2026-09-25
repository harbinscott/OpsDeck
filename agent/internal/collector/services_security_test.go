//go:build linux

package collector

import "testing"

func TestParseNordVPNStatus(t *testing.T) {
	status := []byte("A new version of NordVPN is available!\nStatus: Connected\nServer: United States #1234\nHostname: us1234.nordvpn.com\nIP: 203.0.113.45\nCountry: United States\nCity: New York\nCurrent technology: NORDLYNX\nCurrent protocol: UDP\nPost-quantum VPN: Disabled\nTransfer: 13.07 GiB received, 321.46 MiB sent\nUptime: 12 hours 58 minutes 15 seconds\n")
	settings := []byte("Auto-connect: enabled\nKill Switch: enabled\n")
	got := parseNordVPN(status, settings, nil, nil)
	if !got.Connected || got.Server != "United States #1234" || got.Technology != "NORDLYNX" {
		t.Fatalf("unexpected NordVPN result: %#v", got)
	}
	if got.AutoConnect == nil || !*got.AutoConnect {
		t.Fatal("expected auto-connect to be enabled")
	}
	if got.Received != "13.07 GiB" || got.Sent != "321.46 MiB" {
		t.Fatalf("unexpected transfer values: %q / %q", got.Received, got.Sent)
	}
}

func TestParseUFWStatus(t *testing.T) {
	output := []byte("Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n\nTo                         Action      From\n--                         ------      ----\n22/tcp                     ALLOW IN    192.0.2.0/24\n9095/tcp                   ALLOW IN    192.0.2.0/24\n")
	got := parseUFW(output, nil)
	if !got.Enabled || got.DefaultIncoming != "deny" || len(got.Rules) != 2 {
		t.Fatalf("unexpected UFW result: %#v", got)
	}
}
