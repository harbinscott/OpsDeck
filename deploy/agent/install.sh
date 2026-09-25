#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer with sudo." >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
auth_dir="$script_dir/../auth"
binary="${1:-}"
auth_binary="${2:-}"
control_binary="${3:-}"
if [[ -z "$binary" || ! -f "$binary" || -z "$auth_binary" || ! -f "$auth_binary" || -z "$control_binary" || ! -f "$control_binary" ]]; then
  echo "Usage: sudo $0 /path/to/opsdeck-agent-linux-amd64 /path/to/opsdeck-auth-linux-amd64 /path/to/opsdeck-control-linux-amd64" >&2
  echo "Build the PAM and control helpers first with ./deploy/build-auth-helper.sh" >&2
  exit 2
fi

if ! id opsdeck-agent >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/opsdeck --create-home --shell /usr/sbin/nologin opsdeck-agent
fi

for group in docker systemd-journal adm nordvpn; do
  if getent group "$group" >/dev/null 2>&1; then
    usermod --append --groups "$group" opsdeck-agent
  fi
done

install -o root -g root -m 0755 "$binary" /usr/local/bin/opsdeck-agent
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$auth_binary" /usr/local/libexec/opsdeck-auth
install -o root -g root -m 0755 "$control_binary" /usr/local/libexec/opsdeck-control
install -d -o root -g opsdeck-agent -m 0750 /etc/opsdeck

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

if [[ ! -f /etc/opsdeck/agent.env ]]; then
  token="$(generate_secret)"
  cat > /etc/opsdeck/agent.env <<EOF
OPSDECK_AGENT_LISTEN=127.0.0.1:9040
OPSDECK_AGENT_TOKEN=$token
OPSDECK_DOCKER_SOCKET=/var/run/docker.sock
OPSDECK_AUTH_SOCKET=/run/opsdeck/auth.sock
OPSDECK_CONTROL_SOCKET=/run/opsdeck/control.sock
EOF
fi

if ! grep -q '^OPSDECK_AUTH_SOCKET=' /etc/opsdeck/agent.env; then
  printf 'OPSDECK_AUTH_SOCKET=/run/opsdeck/auth.sock\n' >> /etc/opsdeck/agent.env
fi
if ! grep -q '^OPSDECK_AUTH_PROVIDER=' /etc/opsdeck/agent.env; then
  printf 'OPSDECK_AUTH_PROVIDER=pam\n' >> /etc/opsdeck/agent.env
fi
if ! grep -q '^OPSDECK_CONTROL_SOCKET=' /etc/opsdeck/agent.env; then
  printf 'OPSDECK_CONTROL_SOCKET=/run/opsdeck/control.sock\n' >> /etc/opsdeck/agent.env
fi
if ! grep -q '^OPSDECK_SESSION_SECRET=' /etc/opsdeck/agent.env; then
  printf 'OPSDECK_SESSION_SECRET=%s\n' "$(generate_secret)" >> /etc/opsdeck/agent.env
fi
if ! grep -q '^OPSDECK_ELEVATION_TIMEOUT_SECONDS=' /etc/opsdeck/agent.env; then
  printf 'OPSDECK_ELEVATION_TIMEOUT_SECONDS=900\n' >> /etc/opsdeck/agent.env
fi
chown root:opsdeck-agent /etc/opsdeck/agent.env
chmod 0640 /etc/opsdeck/agent.env

if [[ ! -f /etc/opsdeck/auth.env ]]; then
  printf 'OPSDECK_ADMIN_GROUPS=sudo,admin,wheel\n' > /etc/opsdeck/auth.env
fi
chown root:root /etc/opsdeck/auth.env
chmod 0644 /etc/opsdeck/auth.env

install -o root -g root -m 0644 "$script_dir/opsdeck-agent.service" /etc/systemd/system/opsdeck-agent.service
install -o root -g root -m 0644 "$auth_dir/opsdeck.pam" /etc/pam.d/opsdeck
install -o root -g root -m 0644 "$auth_dir/opsdeck.tmpfiles" /usr/lib/tmpfiles.d/opsdeck.conf
install -o root -g root -m 0644 "$auth_dir/opsdeck-auth.socket" /etc/systemd/system/opsdeck-auth.socket
install -o root -g root -m 0644 "$auth_dir/opsdeck-auth@.service" /etc/systemd/system/opsdeck-auth@.service
install -o root -g root -m 0644 "$auth_dir/opsdeck-control.socket" /etc/systemd/system/opsdeck-control.socket
install -o root -g root -m 0644 "$auth_dir/opsdeck-control@.service" /etc/systemd/system/opsdeck-control@.service
systemd-tmpfiles --create /usr/lib/tmpfiles.d/opsdeck.conf
systemctl daemon-reload
systemctl enable --now opsdeck-auth.socket
systemctl enable --now opsdeck-control.socket
systemctl enable --now opsdeck-agent.service
systemctl restart opsdeck-agent.service

echo "OpsDeck agent installed and listening on 127.0.0.1:9040."
echo "Use /etc/opsdeck/agent.env as the Docker Compose environment file."
echo "Administrative elevation now uses Linux PAM credentials over /run/opsdeck/auth.sock."
echo "Privileged host actions use the fixed-action broker at /run/opsdeck/control.sock."
