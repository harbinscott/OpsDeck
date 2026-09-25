//go:build linux

package control

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

type Client struct{ socket string }

func New(socket string) *Client { return &Client{socket: socket} }

func (c *Client) HostAction(ctx context.Context, action string) error {
	if !allowed(action) {
		return fmt.Errorf("unsupported host action")
	}
	_, err := c.request(ctx, action, false)
	return err
}

func (c *Client) ServiceAction(ctx context.Context, unit, action string) error {
	if !validUnit(unit) || (action != "start" && action != "stop" && action != "restart") {
		return fmt.Errorf("unsupported service action")
	}
	_, err := c.request(ctx, "service:"+action+":"+unit, false)
	return err
}

func (c *Client) Inspect(ctx context.Context, subject string) ([]byte, error) {
	switch subject {
	case "ufw", "sshd", "listeners", "nordvpn-status", "nordvpn-settings", "journal-usage", "cleanup-usage":
	default:
		return nil, fmt.Errorf("unsupported inspection")
	}
	return c.request(ctx, "inspect:"+subject, true)
}

func (c *Client) request(ctx context.Context, request string, requirePayload bool) ([]byte, error) {
	connection, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", c.socket)
	if err != nil {
		return nil, fmt.Errorf("privileged control broker is unavailable: %w", err)
	}
	defer connection.Close()
	_ = connection.SetDeadline(time.Now().Add(2 * time.Hour))
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(request)))
	if _, err = connection.Write(append(header, request...)); err != nil {
		return nil, fmt.Errorf("privileged control request failed: %w", err)
	}
	response := []byte{0}
	if _, err = io.ReadFull(connection, response); err != nil {
		return nil, fmt.Errorf("privileged control response failed: %w", err)
	}
	lengthHeader := make([]byte, 4)
	if _, err = io.ReadFull(connection, lengthHeader); err != nil {
		if !requirePayload && (err == io.EOF || err == io.ErrUnexpectedEOF) {
			return nil, nil
		}
		return nil, fmt.Errorf("privileged control payload failed: %w", err)
	}
	length := binary.BigEndian.Uint32(lengthHeader)
	if length > 1<<20 {
		return nil, fmt.Errorf("privileged control payload was too large")
	}
	payload := make([]byte, length)
	if length > 0 {
		if _, err = io.ReadFull(connection, payload); err != nil {
			return nil, fmt.Errorf("privileged control payload failed: %w", err)
		}
	}
	if response[0] != 0 {
		detail := strings.Join(strings.Fields(string(payload)), " ")
		if len(detail) > 240 {
			detail = detail[:240] + "…"
		}
		if detail == "" {
			detail = "review the OpsDeck control journal"
		}
		return payload, fmt.Errorf("privileged action failed: %s", detail)
	}
	return payload, nil
}

func allowed(action string) bool {
	switch action {
	case "refresh-repositories", "install-updates", "reboot", "poweroff", "cleanup-apt-cache", "cleanup-journals-30d", "cleanup-journals-1g", "cleanup-tempfiles":
		return true
	default:
		return false
	}
}

func validUnit(unit string) bool {
	if len(unit) < len("a.service") || len(unit) > 180 || unit[len(unit)-8:] != ".service" {
		return false
	}
	for _, character := range unit {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '@' || character == '_' || character == '.' || character == '-') {
			return false
		}
	}
	return true
}
