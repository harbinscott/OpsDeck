# Privileged system controls

After PAM elevation, OpsDeck supports fixed host actions:

- refresh APT repository metadata with `apt-get update`;
- install standard available updates with non-interactive `apt-get upgrade`;
- restart the server with `systemctl reboot`;
- shut down the server with `systemctl poweroff`.
- clean the APT archive cache;
- vacuum archived journals by a fixed age or size policy;
- invoke the host's configured `systemd-tmpfiles --clean` policy;
- start, stop, or restart explicitly configured systemd service units.

Every action requires an explicit browser confirmation. Package operations run
as asynchronous jobs so the dashboard remains responsive. Only one host action
can run at a time. Restart and shutdown may disconnect the dashboard before its
final status can be reported.

The unprivileged agent sends an enumerated action over
`/run/opsdeck/control.sock`. A root-owned, socket-activated helper validates the
action again and directly executes a fixed absolute binary path. It does not use
a shell and cannot accept a command line from the browser or agent.

Package upgrade output and action outcomes are written to the system journal:

```bash
sudo journalctl -u 'opsdeck-control@*' -n 100 --no-pager
sudo journalctl -t opsdeck-control -n 50 --no-pager
```

OpsDeck uses the standard APT upgrade behavior and does not perform a distribution
release upgrade, package removal, or automatic reboot.
