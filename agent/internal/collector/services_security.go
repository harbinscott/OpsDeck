//go:build linux

package collector

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/opsdeck/opsdeck/agent/internal/model"
)

type privilegedInspector interface {
	Inspect(context.Context, string) ([]byte, error)
}

func collectServices(parent context.Context) []model.Service {
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager").Output()
	if err != nil {
		return []model.Service{}
	}
	enabled := serviceEnablement(parent)
	services := []model.Service{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 5 || !strings.HasSuffix(fields[0], ".service") {
			continue
		}
		services = append(services, model.Service{Unit: fields[0], Load: fields[1], Active: fields[2], Sub: fields[3], Description: strings.Join(fields[4:], " "), Enabled: enabled[fields[0]]})
	}
	sort.Slice(services, func(i, j int) bool {
		if services[i].Active != services[j].Active {
			return services[i].Active == "active"
		}
		return services[i].Unit < services[j].Unit
	})
	return services
}

func serviceEnablement(parent context.Context) map[string]string {
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", "list-unit-files", "--type=service", "--no-legend", "--no-pager").Output()
	result := map[string]string{}
	if err != nil {
		return result
	}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			result[fields[0]] = fields[1]
		}
	}
	return result
}

func collectSecurity(parent context.Context, inspector privilegedInspector) model.Security {
	security := model.Security{CollectedAt: time.Now().UTC(), Firewall: model.Firewall{Provider: "ufw", Rules: []model.FirewallRule{}}, Listeners: []model.Listener{}, VPN: model.VPNStatus{Provider: "NordVPN", Fields: map[string]string{}}}
	security.AutomaticUpdates = automaticUpdates(parent)
	if inspector == nil {
		security.Firewall.Error = "Privileged inspection is unavailable"
		security.SSH.Error = "Privileged inspection is unavailable"
		security.VPN.Error = "Privileged inspection is unavailable"
		return security
	}
	type result struct {
		name   string
		output []byte
		err    error
	}
	results := make(chan result, 5)
	var wg sync.WaitGroup
	for _, name := range []string{"ufw", "sshd", "listeners", "nordvpn-status", "nordvpn-settings"} {
		name := name
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(parent, 8*time.Second)
			defer cancel()
			output, err := inspector.Inspect(ctx, name)
			results <- result{name: name, output: output, err: err}
		}()
	}
	go func() { wg.Wait(); close(results) }()
	var nordStatus, nordSettings []byte
	var nordStatusErr, nordSettingsErr error
	for item := range results {
		switch item.name {
		case "ufw":
			security.Firewall = parseUFW(item.output, item.err)
		case "sshd":
			security.SSH = parseSSHD(item.output, item.err)
		case "listeners":
			security.Listeners = parseListeners(item.output)
		case "nordvpn-status":
			nordStatus = item.output
			nordStatusErr = item.err
		case "nordvpn-settings":
			nordSettings = item.output
			nordSettingsErr = item.err
		}
	}
	security.VPN = parseNordVPN(nordStatus, nordSettings, nordStatusErr, nordSettingsErr)
	security.VPN.DefaultRouteInterface = defaultRouteInterface(parent)
	return security
}

func parseUFW(output []byte, err error) model.Firewall {
	firewall := model.Firewall{Provider: "ufw", Rules: []model.FirewallRule{}}
	text := strings.TrimSpace(string(output))
	if err != nil {
		if strings.Contains(strings.ToLower(text), "not found") {
			firewall.Error = "UFW is not installed"
		} else {
			firewall.Error = inspectionFailure("UFW status could not be read", text)
		}
		return firewall
	}
	firewall.Installed = true
	scanner := bufio.NewScanner(strings.NewReader(text))
	inRules := false
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		lower := strings.ToLower(line)
		switch {
		case strings.HasPrefix(lower, "status:"):
			firewall.Enabled = strings.TrimSpace(strings.TrimPrefix(lower, "status:")) == "active"
		case strings.HasPrefix(lower, "logging:"):
			firewall.Logging = strings.TrimSpace(line[strings.Index(line, ":")+1:])
		case strings.HasPrefix(lower, "default:"):
			defaults := strings.Split(strings.TrimSpace(line[strings.Index(line, ":")+1:]), ",")
			for _, value := range defaults {
				value = strings.TrimSpace(value)
				if strings.HasSuffix(value, "(incoming)") {
					firewall.DefaultIncoming = strings.TrimSpace(strings.TrimSuffix(value, "(incoming)"))
				}
				if strings.HasSuffix(value, "(outgoing)") {
					firewall.DefaultOutgoing = strings.TrimSpace(strings.TrimSuffix(value, "(outgoing)"))
				}
				if strings.HasSuffix(value, "(routed)") {
					firewall.DefaultRouted = strings.TrimSpace(strings.TrimSuffix(value, "(routed)"))
				}
			}
		case strings.HasPrefix(line, "To") && strings.Contains(line, "Action"):
			inRules = true
		case inRules && line != "" && !strings.HasPrefix(line, "--"):
			columns := regexp.MustCompile(`\s{2,}`).Split(line, 3)
			if len(columns) == 3 {
				firewall.Rules = append(firewall.Rules, model.FirewallRule{Index: len(firewall.Rules) + 1, To: columns[0], Action: columns[1], From: columns[2], Raw: line})
			}
		}
	}
	return firewall
}

func parseSSHD(output []byte, err error) model.SSHPosture {
	posture := model.SSHPosture{}
	if err != nil {
		posture.Error = "The effective OpenSSH configuration could not be read"
		return posture
	}
	values := map[string][]string{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 {
			values[strings.ToLower(fields[0])] = append(values[strings.ToLower(fields[0])], strings.Join(fields[1:], " "))
		}
	}
	posture.Available = len(values) > 0
	posture.Port = firstMapValue(values, "port")
	posture.ListenAddress = strings.Join(values["listenaddress"], ", ")
	posture.PermitRootLogin = firstMapValue(values, "permitrootlogin")
	posture.PasswordAuthentication = firstMapValue(values, "passwordauthentication")
	posture.PubkeyAuthentication = firstMapValue(values, "pubkeyauthentication")
	posture.PermitEmptyPasswords = firstMapValue(values, "permitemptypasswords")
	posture.X11Forwarding = firstMapValue(values, "x11forwarding")
	posture.AllowTcpForwarding = firstMapValue(values, "allowtcpforwarding")
	return posture
}

func firstMapValue(values map[string][]string, key string) string {
	if len(values[key]) > 0 {
		return values[key][0]
	}
	return ""
}

var listenerProcess = regexp.MustCompile(`\(\("([^\"]+)".*,pid=([0-9]+)`)

func parseListeners(output []byte) []model.Listener {
	listeners := []model.Listener{}
	scanner := bufio.NewScanner(bytes.NewReader(output))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		protocol := strings.ToLower(fields[0])
		localIndex := 4
		if protocol == "udp" || protocol == "udp6" {
			localIndex = 4
		}
		if localIndex >= len(fields) {
			continue
		}
		address, port, ok := splitHostPort(fields[localIndex])
		if !ok {
			continue
		}
		listener := model.Listener{Protocol: protocol, Address: address, Port: port, Scope: listenerScope(address)}
		if match := listenerProcess.FindStringSubmatch(line); len(match) == 3 {
			listener.Process = match[1]
			listener.PID, _ = strconv.Atoi(match[2])
		}
		listeners = append(listeners, listener)
	}
	sort.Slice(listeners, func(i, j int) bool {
		if listeners[i].Port != listeners[j].Port {
			return listeners[i].Port < listeners[j].Port
		}
		return listeners[i].Protocol < listeners[j].Protocol
	})
	return listeners
}

func splitHostPort(value string) (string, uint16, bool) {
	index := strings.LastIndex(value, ":")
	if index < 0 {
		return "", 0, false
	}
	address := strings.Trim(value[:index], "[]")
	parsed, err := strconv.ParseUint(value[index+1:], 10, 16)
	return address, uint16(parsed), err == nil
}

func listenerScope(address string) string {
	switch address {
	case "127.0.0.1", "::1":
		return "loopback"
	case "0.0.0.0", "*", "::":
		return "all"
	default:
		return "interface"
	}
}

func parseNordVPN(statusOutput, settingsOutput []byte, statusErr, settingsErr error) model.VPNStatus {
	vpn := model.VPNStatus{Provider: "NordVPN", Fields: map[string]string{}}
	statusText := strings.TrimSpace(string(statusOutput))
	if statusErr != nil {
		vpn.Error = inspectionFailure("NordVPN status could not be read", statusText)
		return vpn
	}
	if statusText == "" {
		vpn.Error = "NordVPN is not installed or its status is unavailable"
		return vpn
	}
	vpn.Installed = true
	vpn.UpdateAvailable = strings.Contains(strings.ToLower(statusText), "new version")
	fields := colonFields(statusText)
	for key, value := range colonFields(string(settingsOutput)) {
		fields[key] = value
	}
	if settingsErr != nil {
		vpn.Error = inspectionFailure("NordVPN settings could not be read", strings.TrimSpace(string(settingsOutput)))
	}
	vpn.Fields = fields
	vpn.Connected = strings.EqualFold(fields["Status"], "Connected")
	vpn.Server = fields["Server"]
	vpn.Hostname = fields["Hostname"]
	vpn.IP = fields["IP"]
	vpn.Country = fields["Country"]
	vpn.City = fields["City"]
	vpn.Technology = firstNonempty(fields["Current technology"], fields["Technology"])
	vpn.Protocol = firstNonempty(fields["Current protocol"], fields["Protocol"])
	vpn.PostQuantum = fields["Post-quantum VPN"]
	vpn.Uptime = fields["Uptime"]
	if transfer := fields["Transfer"]; transfer != "" {
		parts := strings.Split(transfer, ",")
		for _, part := range parts {
			if strings.Contains(part, "received") {
				vpn.Received = strings.TrimSpace(strings.TrimSuffix(part, "received"))
			}
			if strings.Contains(part, "sent") {
				vpn.Sent = strings.TrimSpace(strings.TrimSuffix(part, "sent"))
			}
		}
	}
	if value, found := booleanField(fields, "Auto-connect"); found {
		vpn.AutoConnect = &value
	}
	if value, found := booleanField(fields, "Kill Switch"); found {
		vpn.KillSwitch = &value
	}
	return vpn
}

func inspectionFailure(fallback, output string) string {
	detail := strings.Join(strings.Fields(output), " ")
	if detail == "" {
		return fallback
	}
	if len(detail) > 220 {
		detail = detail[:220] + "…"
	}
	return fallback + ": " + detail
}

func colonFields(text string) map[string]string {
	fields := map[string]string{}
	scanner := bufio.NewScanner(strings.NewReader(text))
	for scanner.Scan() {
		key, value, found := strings.Cut(strings.TrimSpace(scanner.Text()), ":")
		if found && strings.TrimSpace(key) != "" {
			fields[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return fields
}

func booleanField(fields map[string]string, key string) (bool, bool) {
	value, found := fields[key]
	if !found {
		return false, false
	}
	switch strings.ToLower(value) {
	case "enabled", "on", "yes", "true":
		return true, true
	case "disabled", "off", "no", "false":
		return false, true
	}
	return false, false
}

func defaultRouteInterface(parent context.Context) string {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "ip", "route", "show", "default").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(string(output))
	for index, value := range fields {
		if value == "dev" && index+1 < len(fields) {
			return fields[index+1]
		}
	}
	return ""
}

func automaticUpdates(parent context.Context) model.AutomaticUpdates {
	return model.AutomaticUpdates{
		Enabled:      commandState(parent, "systemctl", "is-enabled", "unattended-upgrades.service") == "enabled",
		TimerEnabled: commandState(parent, "systemctl", "is-enabled", "apt-daily-upgrade.timer") == "enabled",
		TimerActive:  commandState(parent, "systemctl", "is-active", "apt-daily-upgrade.timer") == "active",
		LastRun:      commandState(parent, "systemctl", "show", "apt-daily-upgrade.service", "--property=ExecMainExitTimestamp", "--value"),
	}
}

func commandState(parent context.Context, name string, args ...string) string {
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	output, _ := exec.CommandContext(ctx, name, args...).Output()
	return strings.TrimSpace(string(output))
}
