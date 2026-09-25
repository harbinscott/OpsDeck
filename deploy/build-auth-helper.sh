#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$root/agent/bin"
mkdir -p "$output"
docker build --output "type=local,dest=$output" "$root/deploy/auth"
chmod 0755 "$output/opsdeck-auth-linux-amd64"

control="$output/opsdeck-control-linux-amd64"
if command -v go >/dev/null 2>&1; then
  cd "$root/agent"
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o "$control" ./cmd/opsdeck-control
elif [[ -f "$control" ]]; then
  echo "Go is not installed; using the prebuilt OpsDeck control helper from the release."
else
  echo "Go is not installed and $control is missing." >&2
  exit 2
fi
chmod 0755 "$output/opsdeck-control-linux-amd64"
