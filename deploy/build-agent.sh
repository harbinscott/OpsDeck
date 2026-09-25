#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
arch="${GOARCH:-amd64}"
mkdir -p "$repo_root/agent/bin"
cd "$repo_root/agent"
CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags='-s -w' -o "bin/opsdeck-agent-linux-$arch" ./cmd/opsdeck-agent
printf '%s\n' "$repo_root/agent/bin/opsdeck-agent-linux-$arch"
