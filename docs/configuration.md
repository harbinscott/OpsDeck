# Dashboard configuration

OpsDeck automatically groups containers by their Docker Compose project label.
An administrator can create or rename those groups from **Applications → Manage groups**.
The resulting mapping is stored in the `opsdeck-data` Docker volume and survives
dashboard upgrades and container recreation.

Administrative access is required to save changes. OpsDeck verifies the supplied
Linux username and password through PAM. The account must belong to an allowed
administrative group (`sudo`, `admin`, or `wheel` by default). Set a custom
comma-separated group list in `/etc/opsdeck/auth.env`, then restart
`opsdeck-auth.socket` if your deployment uses different administrative groups.

Elevation is scoped to the current browser tab. Its timeout is configurable in
**Settings** from 60 to 3600 seconds and defaults to
`OPSDECK_ELEVATION_TIMEOUT_SECONDS` when no dashboard setting exists. Closing the tab or
choosing **Drop administrative access** removes the browser token immediately.
OpsDeck does not store the Linux password.

The stored JSON uses schema version 1. Each application may match exact Compose
project names, Compose service names, or runtime container names. The first
application match wins. Containers without an explicit match continue to use
their Compose project label and otherwise appear in `Ungrouped`.

Container aliases affect only display names; runtime names remain visible in
the details drawer. Alias editing will use the same configuration API when that
control is added to the interface.

The same configuration stores the host display name, telemetry refresh interval,
elevation timeout, and saved log views. Saved views contain filter names,
severity levels, and search text only; they do not duplicate journal contents.

## Backup

Inspect the volume location with:

```bash
sudo docker volume inspect opsdeck_opsdeck-data
```

The dashboard writes `dashboard.json` atomically inside that volume. The file
contains display and filter metadata only—no credentials or agent tokens.
