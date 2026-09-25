# HTTPS with host Nginx

OpsDeck should remain an HTTP service bound to host loopback. Nginx terminates
TLS and forwards requests to `127.0.0.1:9095`. The certificate and private key
remain owned by the host Nginx installation and are never mounted into the
dashboard container.

The included example uses:

- HTTPS URL: `https://opsdeck.example.internal:9443`
- certificate: `/etc/ssl/certs/opsdeck.crt`
- private key: `/etc/ssl/private/opsdeck.key`
- upstream: `http://127.0.0.1:9095`

The certificate must contain the public hostname or IP address in its Subject
Alternative Name extension. Do not expose port 9095 through the host firewall
after the HTTPS proxy is working.

Set these values in the Compose environment file:

```text
OPSDECK_BIND_ADDRESS=127.0.0.1
VINEXT_TRUST_PROXY=1
VINEXT_TRUSTED_HOSTS=opsdeck.example.internal:9443
```

Install `deploy/nginx/opsdeck.conf.example` as a separate Nginx site, validate
with `nginx -t`, reload Nginx, and allow the HTTPS port only from the intended
network.
