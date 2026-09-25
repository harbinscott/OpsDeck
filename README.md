# OpsDeck

OpsDeck is a self-hosted, application-aware operations dashboard for Linux and Docker hosts. This repository provides a read-mostly dashboard, a constrained Linux host agent, and a mock fallback for development and hosted previews.

The dashboard also supports a portable, deployment-owned JSON configuration for
host display names, application grouping, and container aliases. Docker Compose
metadata remains the automatic fallback.

## Current data and controls

- host identity, kernel, architecture, uptime, load, temperature, CPU and memory
- aggregate network receive/transmit rates
- mounted filesystem capacity
- unique backing-filesystem capacity, reserved blocks, inode pressure, and on-demand largest-directory/file analysis
- previewed cleanup suggestions for APT, journals, temporary-file policy, and selected Docker resources
- Docker Engine version, containers, Compose application labels, state, health and utilization
- host systemd service inventory with an explicit dashboard-managed control list
- UFW rules, listening ports/processes, effective OpenSSH posture, automatic-update status, and NordVPN connection details
- recent journald messages
- APT update inventory, repository refresh, and standard package upgrades
- confirmed server restart and shutdown actions
- persistent log filters and detailed log inspection

The agent exposes health and snapshot reads plus fixed container and host-control routes. It never accepts arbitrary commands or arbitrary Docker requests. Control routes are available through the dashboard only after time-limited Linux PAM elevation.

## Production topology

```text
browser -> HTTPS reverse proxy -> dashboard container -> 127.0.0.1:9040 -> constrained agent
                                                                         -> /proc and /sys
                                                                         -> journald and APT inventory
                                                                         -> Docker Engine socket
                                                                         -> /run/opsdeck/auth.sock
                                                                            -> one-shot PAM helper
                                                                         -> /run/opsdeck/control.sock
                                                                            -> fixed-action root helper
```

The dashboard container runs unprivileged with a read-only filesystem. The native agent is deliberately separate because host telemetry and service integration are awkward and unsafe to expose directly to a web container.

## Build and install on Ubuntu

Prerequisites: Go 1.23 or newer, Docker Engine, and Docker Compose.

```bash
./deploy/build-agent.sh
./deploy/build-auth-helper.sh
sudo ./deploy/agent/install.sh \
  ./agent/bin/opsdeck-agent-linux-amd64 \
  ./agent/bin/opsdeck-auth-linux-amd64 \
  ./agent/bin/opsdeck-control-linux-amd64
sudo docker compose --env-file /etc/opsdeck/agent.env up --build -d
```

By default the dashboard binds to host loopback for reverse-proxy use. See
`docs/https-nginx.md` for the recommended HTTPS deployment. For a temporary
direct HTTP deployment, set `OPSDECK_BIND_ADDRESS=0.0.0.0` and restrict port
9095 with the host firewall.

See `docs/authentication.md` for PAM policy, administrative groups, security
boundaries, and troubleshooting.
See `docs/system-controls.md` for package and host power operations.
See `docs/storage-security.md` for storage scans, cleanup boundaries, service controls, and the read-only security provider.

The agent listens only on loopback. The dashboard uses host networking so it can reach the loopback agent without exposing the agent port to the LAN. Administrative elevation uses the Linux username and password of an account in an allowed administrative group (`sudo`, `admin`, or `wheel` by default).

## Customize applications and aliases

Open Applications and choose **Manage groups**. After administrative elevation,
groups can be created, renamed, and assigned in the console. Dashboard settings
and saved log views use the same persistent `opsdeck-data` Docker volume. See
`docs/configuration.md` for matching behavior and backup details.

## Verify the agent

The health endpoint intentionally reveals no host data and does not require a token:

```bash
curl http://127.0.0.1:9040/healthz
```

The snapshot endpoint requires the generated bearer token:

```bash
set -a
source /etc/opsdeck/agent.env
set +a
curl -H "Authorization: Bearer $OPSDECK_AGENT_TOKEN" http://127.0.0.1:9040/v1/snapshot
```

## Development

Without `OPSDECK_AGENT_URL`, the dashboard automatically uses its mock provider. To connect a local dashboard to an agent, set:

```text
OPSDECK_AGENT_URL=http://127.0.0.1:9040
OPSDECK_AGENT_TOKEN=<matching agent token>
```

Then run the normal dashboard development command. The browser only calls the same-origin dashboard API; the bearer token is never sent to browser code.

## Security boundary

Docker socket access is effectively root-equivalent even if the socket is mounted read-only. OpsDeck therefore never mounts the socket into the dashboard container. The native agent has Docker group access and implements only fixed snapshot and container lifecycle operations. PAM and root host actions run in separate socket-activated helpers; the main agent remains unprivileged. The control helper accepts only repository refresh, standard package upgrade, reboot, and poweroff actions. Passwords are forwarded only over HTTPS and local IPC for immediate verification, and are neither stored nor logged. The browser receives a short-lived, tab-scoped elevation token, while the Docker socket and agent bearer token remain inaccessible to it.
