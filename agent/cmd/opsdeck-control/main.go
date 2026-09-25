//go:build linux

package main

import (
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"strings"
	"unicode"
)

const maxRequest = 512
const maxOutput = 1 << 20

func main() {
	request, err := readRequest(os.Stdin)
	if err != nil {
		log.Printf("invalid request: %v", err)
		os.Exit(3)
	}
	var output []byte
	if strings.HasPrefix(request, "inspect:") {
		output, err = inspect(strings.TrimPrefix(request, "inspect:"))
	} else {
		err = runAction(request)
	}
	status := byte(0)
	if err != nil {
		status = 1
		log.Printf("request %q failed: %v", request, err)
	} else {
		log.Printf("request %q completed", request)
	}
	if len(output) > maxOutput {
		output = output[:maxOutput]
	}
	response := make([]byte, 5)
	response[0] = status
	binary.BigEndian.PutUint32(response[1:], uint32(len(output)))
	_, _ = os.Stdout.Write(response)
	if len(output) > 0 {
		_, _ = os.Stdout.Write(output)
	}
}

func readRequest(reader io.Reader) (string, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(reader, header); err != nil {
		return "", err
	}
	length := binary.BigEndian.Uint32(header)
	if length == 0 || length > maxRequest {
		return "", fmt.Errorf("invalid request length")
	}
	buffer := make([]byte, length)
	if _, err := io.ReadFull(reader, buffer); err != nil {
		return "", err
	}
	return string(buffer), nil
}

func runAction(action string) error {
	var command *exec.Cmd
	switch action {
	case "refresh-repositories":
		command = exec.Command("/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=60", "update")
	case "install-updates":
		command = exec.Command("/usr/bin/apt-get", "-o", "DPkg::Lock::Timeout=60", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "-y", "upgrade")
		command.Env = append(os.Environ(), "DEBIAN_FRONTEND=noninteractive")
	case "cleanup-apt-cache":
		command = exec.Command("/usr/bin/apt-get", "clean")
	case "cleanup-journals-30d":
		command = exec.Command("/usr/bin/journalctl", "--vacuum-time=30d")
	case "cleanup-journals-1g":
		command = exec.Command("/usr/bin/journalctl", "--vacuum-size=1G")
	case "cleanup-tempfiles":
		command = exec.Command("/usr/bin/systemd-tmpfiles", "--clean")
	case "reboot":
		command = exec.Command("/usr/bin/systemctl", "reboot")
	case "poweroff":
		command = exec.Command("/usr/bin/systemctl", "poweroff")
	default:
		parts := strings.Split(action, ":")
		if len(parts) != 3 || parts[0] != "service" || !validServiceVerb(parts[1]) || !validServiceUnit(parts[2]) {
			return fmt.Errorf("unsupported action")
		}
		command = exec.Command("/usr/bin/systemctl", parts[1], "--", parts[2])
	}
	command.Stdout = os.Stderr
	command.Stderr = os.Stderr
	return command.Run()
}

func inspect(subject string) ([]byte, error) {
	var command *exec.Cmd
	switch subject {
	case "ufw":
		command = exec.Command("/usr/sbin/ufw", "status", "verbose")
	case "sshd":
		command = exec.Command("/usr/sbin/sshd", "-T")
	case "listeners":
		command = exec.Command("/usr/bin/ss", "-H", "-lntup")
	case "nordvpn-status":
		command = exec.Command("/usr/bin/nordvpn", "status")
	case "nordvpn-settings":
		command = exec.Command("/usr/bin/nordvpn", "settings")
	case "journal-usage":
		command = exec.Command("/usr/bin/journalctl", "--disk-usage")
	case "cleanup-usage":
		command = exec.Command("/usr/bin/du", "-x", "-B1", "-s", "/tmp", "/var/tmp", "/var/cache/apt/archives")
	default:
		return nil, fmt.Errorf("unsupported inspection")
	}
	return command.CombinedOutput()
}

func validServiceVerb(value string) bool {
	return value == "start" || value == "stop" || value == "restart"
}

func validServiceUnit(unit string) bool {
	if len(unit) < 9 || len(unit) > 180 || !strings.HasSuffix(unit, ".service") {
		return false
	}
	for _, value := range unit {
		if !(unicode.IsLetter(value) || unicode.IsDigit(value) || strings.ContainsRune("@_.-", value)) {
			return false
		}
	}
	return true
}
