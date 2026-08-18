# Faultline architecture

Faultline is designed around one principle: **diagnosis should come from evidence collected at explicit vantage points, not from an LLM guessing at telemetry.**

## v0.1

```text
Browser dashboard
      |
      v
Node HTTP API -----> deterministic diagnosis engine
      |                         |
      |                         v
      +-----------------> evidence + fault domain + actions
```

The current release ships with realistic demo incidents. The same engine is exposed through `POST /api/diagnose`, so endpoint agents and remote probes can feed real measurements into the product without changing the UI contract.

## Intended data plane

```text
Endpoint Agent                     Faultline Cloud                     Service
+----------------+                 +----------------+                 +-----------+
| LAN / Wi-Fi    |  measurements   | Correlation    |  probe results  | SaaS /    |
| DNS / routes   | --------------> | + diagnosis    | <-------------- | customer  |
| VPN / path     |                 | + evidence     |                 | workload   |
+----------------+                 +----------------+                 +-----------+
```

### Endpoint measurements

Planned agent telemetry includes:

- default gateway reachability and latency
- packet loss and jitter
- DNS resolution timing
- IPv4 and IPv6 reachability
- TCP and TLS connection timing
- HTTP timing
- route table state
- VPN adapter and expected route state
- path observations such as traceroute/MTR-style hops

### Cloud probe measurements

Remote probes provide an independent control path. This lets Faultline distinguish a local endpoint problem from a target-service or wider network problem.

## Diagnosis model

The diagnosis engine assigns evidence-weighted scores to fault domains:

- local network
- DNS
- VPN / route state
- ISP / upstream path
- target service

The highest supported domain becomes the likely diagnosis. Confidence is derived from the strength and agreement of the available evidence.

This is intentionally deterministic in v0.1. An LLM may later explain a completed diagnosis in customer-friendly language, but it should not invent the diagnosis itself.

## Security direction

Future agents should minimise collection by default. Faultline needs network state and timings, not user payload content. Diagnostic sessions should be short-lived, scoped to a case, and designed so that an organisation can contribute evidence without exposing credentials or full internal topology.
