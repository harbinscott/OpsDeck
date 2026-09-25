# Administrative authentication

OpsDeck uses Linux PAM for administrative elevation. On Ubuntu, enter the same
Linux username and password that you use with `sudo`. PAM verifies the password;
OpsDeck separately requires the authenticated account to be a member of an
allowed administrative group.

The default groups are `sudo`, `admin`, and `wheel`. To change them, edit:

```text
/etc/opsdeck/auth.env
```

For example:

```text
OPSDECK_ADMIN_GROUPS=opsdeck-admins
```

The setting is read for each authentication request. The PAM policy is installed
at `/etc/pam.d/opsdeck` and includes Ubuntu's standard `common-auth` and
`common-account` policies.

## Security model

- The dashboard must be served over HTTPS before credentials are entered.
- The dashboard forwards credentials to the loopback-only agent.
- The agent sends them over `/run/opsdeck/auth.sock` to a root-owned, one-shot
  PAM helper.
- The password is used only for that PAM transaction and is not stored or logged.
- Successful authentication creates a signed, time-limited browser token scoped
  to the current tab. Closing the tab removes it.
- The root PAM helper does not accept commands and has no Docker access. A
  separate fixed-action control helper performs explicitly supported host tasks.

The main OpsDeck agent continues to run as `opsdeck-agent`; it does not run as
root. PAM elevation authorizes only the fixed actions implemented by the agent.
It does not create a general-purpose sudo session.

## Diagnostics

```bash
sudo systemctl status opsdeck-auth.socket opsdeck-control.socket opsdeck-agent.service
sudo ss -xl | grep /run/opsdeck/
sudo journalctl -u 'opsdeck-auth@*' -n 50 --no-pager
sudo journalctl -t opsdeck-auth -n 50 --no-pager
sudo journalctl -t opsdeck-control -n 50 --no-pager
```

Authentication failures intentionally return a generic error to the browser.
The journal records the username and outcome, but never the password.

## Emergency secret fallback

The legacy shared-secret provider remains available for development or emergency
recovery only. Set `OPSDECK_AUTH_PROVIDER=secret` and provide a random
`OPSDECK_ADMIN_SECRET` of at least 32 characters. PAM is the default and is the
recommended provider for the self-hosted deployment.
