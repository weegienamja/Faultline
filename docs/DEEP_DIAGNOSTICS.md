# Deeper Network and Protocol Diagnostics

Faultline v1.4 preview adds measurements that explain **which stage of a modern connection is failing**, without replacing the existing deterministic fault-domain engine.

## Dual-stack evidence

The endpoint agent independently resolves A and AAAA records and tests TCP reachability to the first observed address in each family.

Recorded evidence includes:

```text
IPv4 A records + TTL
IPv6 AAAA records + TTL
IPv4 TCP reachability/timing
IPv6 TCP reachability/timing
```

This allows Faultline to expose cases where IPv4 succeeds while IPv6 fails, or where a target simply has no AAAA record. Absence of IPv6 is not treated as a fault by itself.

## TLS handshake evidence

For HTTPS/443 targets Faultline performs an explicit TLS connection and records:

- handshake success/failure and timing;
- certificate authorization outcome;
- negotiated TLS protocol;
- negotiated cipher;
- ALPN result;
- certificate subject/issuer/validity/fingerprint metadata.

SNI uses the original hostname even when the connection is made to a previously resolved address. This avoids confusing address-family testing with certificate-name testing.

## HTTP stage timing

The detailed HTTP probe records observable milestones:

```text
socket assignment
DNS lookup event
TCP connect
TLS secureConnect
response headers / TTFB
request completion
```

The measurements are not presented as packet-level truth. They are client-side timing observations useful for comparing runs and vantages.

## Path MTU

On Windows, the deep diagnostic uses a bounded binary search with `ping.exe -f -l` to estimate the largest IPv4 packet size that can traverse the path without fragmentation.

The search is deliberately bounded and stores each attempted size plus the parsed outcome. It does not continuously flood the path.

## Agent integration

Deep diagnostics run by default in the Node-based endpoint agent and can be disabled with:

```text
--no-deep
```

Results are stored under:

```text
telemetry.deepDiagnostics
```

and summary fields are copied into `metrics`:

```text
ipv4Reachable
ipv6Reachable
tlsHandshakeOk
tlsHandshakeMs
targetTtfbMs
pathMtuBytes
```

The existing diagnosis rules remain authoritative. v1.4 does not automatically assign a new root cause merely because one address family or protocol stage behaves differently.

## Current limitation

The standalone `Faultline.exe` still contains its self-contained collector implementation and does not yet import the new modular v1.4 deep collector. The Node endpoint agent is the first executable path for these measurements. The Windows SEA job remains a regression gate for the packaged v0.6/v0.7 client workflow.

This distinction is documented rather than claiming the packaged binary collects evidence it does not yet collect.
