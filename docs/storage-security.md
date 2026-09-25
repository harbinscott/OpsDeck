# Storage and security providers

## Storage accuracy

OpsDeck identifies a filesystem by the Linux mount identity (`major:minor`) and
keeps all of its mount paths together. Capacity totals count the backing
filesystem once. Used space follows `df` semantics: filesystem-reserved blocks
are reported separately rather than being presented as user data.

An on-demand scan stays on the selected filesystem, does not follow symbolic
links, skips other mounts, and stops after 45 seconds or two million entries.
The agent reports permission errors and truncated results instead of silently
presenting a partial scan as complete.

Cleanup candidates are unchecked by default. The root helper supports only the
named APT, journal, and systemd-tmpfiles operations. Docker cleanup uses fixed
Docker Engine prune endpoints after PAM elevation. Docker volume deletion is
intentionally unavailable.

Docker prune operations run as asynchronous agent jobs with a two-hour
deadline. This keeps large build-cache cleanups alive across reverse-proxy and
browser request timeouts while exposing their status through the system-jobs
API.

## Services

The Services page inventories systemd services. Controls appear only for units
listed in `settings.managedServices` in the dashboard configuration. The root
helper accepts only `start`, `stop`, and `restart` and validates that the target
is a syntactically valid `.service` unit. It never invokes a shell.

## Security

The security provider performs fixed privileged inspections for:

- UFW status, defaults, logging, and user rules;
- listening TCP and UDP sockets with owning processes when available;
- the effective `sshd -T` configuration;
- NordVPN status and settings;
- systemd automatic-update service and timer status.

NordVPN private keys and credentials are never requested or exposed. VPN and
firewall changes remain read-only in this release. Future write support must
include an automatic rollback window that restores network access if the
browser cannot confirm connectivity.
