//go:build linux

package auth

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

type Client struct{ socket string }

func New(socket string) *Client { return &Client{socket: socket} }

func (c *Client) Authenticate(ctx context.Context, username, password string) (bool, error) {
	if len(username) == 0 || len(username) > 64 || len(password) == 0 || len(password) > 512 {
		return false, nil
	}
	connection, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "unix", c.socket)
	if err != nil {
		return false, fmt.Errorf("PAM authentication broker is unavailable: %w", err)
	}
	defer connection.Close()
	deadline := time.Now().Add(12 * time.Second)
	_ = connection.SetDeadline(deadline)
	header := make([]byte, 8)
	binary.BigEndian.PutUint32(header[0:4], uint32(len(username)))
	binary.BigEndian.PutUint32(header[4:8], uint32(len(password)))
	payload := make([]byte, 0, len(header)+len(username)+len(password))
	payload = append(payload, header...)
	payload = append(payload, username...)
	payload = append(payload, password...)
	defer func() {
		for index := range payload {
			payload[index] = 0
		}
	}()
	if _, err = connection.Write(payload); err != nil {
		return false, fmt.Errorf("PAM authentication request failed: %w", err)
	}
	response := []byte{0}
	if _, err = io.ReadFull(connection, response); err != nil {
		return false, fmt.Errorf("PAM authentication response failed: %w", err)
	}
	switch response[0] {
	case 0:
		return true, nil
	case 1, 2:
		return false, nil
	default:
		return false, fmt.Errorf("PAM authentication broker returned an internal error")
	}
}
