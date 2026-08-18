# Faultline architecture

Faultline is designed around one principle: **diagnosis should come from evidence collected at explicit vantage points, not from an LLM guessing at telemetry.**

## v0.3

```text
Windows endpoint                                  Remote probe
     |                                                 |
     | endpoint telemetry                              | independent target checks
     v                                                 v
POST /api/agent-runs                          POST /api/probe-runs
     |                                                 |
     +------------------ Faultline API ----------------+
                              |
                              v
                     correlation engine
                              |
                              v
                  deterministic diagnosis
                              |
                              v
              evidence + fault domain + actions
                              |
                              v
                       browser dashboard
```

A live endpoint run is created first. Its run ID becomes the correlation key for a later remote-probe result. When the probe joins, Faultline recomputes the same incident using evidence from both vantage points.

Live state remains in process memory in v0.3.

## Endpoint vantage

The Windows collector uses operating-system networking tools and Node.js probes rather than packet interception.

It collects:

- active IPv4 default route
- active adapter metadata
- Wi-Fi signal when available
- active VPN-like adapters
- optional expected-route state
- gateway ICMP latency and loss
- DNS resolution and timing
- general internet TCP controls
- target TCP and HTTP timing
- target ICMP loss and jitter
- direct-IP checks after DNS resolution
- bounded traceroute observations

The endpoint payload also records the normalized target host, port and URL so a remote probe can test the same destination without guessing the target configuration.

## Remote vantage

The v0.3 remote probe is intentionally portable. It uses Node.js rather than operating-system commands and therefore runs on Windows, Linux and macOS with Node.js 20+.

It performs:

- DNS resolution and lookup timing
- TCP connection timing to the target port
- HTTP response timing for HTTP(S) targets
- independent target reachability classification

The remote probe does not yet collect remote traceroute or ICMP path data. Its current job is to answer a narrower question reliably: **can an independent network vantage reach the same target?**

## Correlation contract

Endpoint measurements remain the primary diagnostic input. A remote probe contributes two additional values to that contract:

```json
{
  "externalProbeHealthy": true,
  "externalProbeLatencyMs": 28
}
```

Those values are derived from the remote probe payload rather than supplied by the endpoint.

This supports useful comparisons:

```text
Endpoint fails + remote succeeds
    -> endpoint-specific path / policy evidence

Endpoint fails + remote fails + general internet healthy
    -> target-service evidence

Endpoint has upstream loss + remote succeeds
    -> reinforces endpoint ISP / transit evidence

Endpoint succeeds + remote succeeds
    -> stronger healthy confidence
```

## Live-run lifecycle

```text
1. Endpoint agent collects evidence
2. POST /api/agent-runs
3. Faultline creates LIVE-... run
4. Dashboard shows ENDPOINT ONLY
5. Remote probe GETs /api/agent-runs/:id
6. Probe independently measures the target
7. POST /api/probe-runs with runId
8. Correlation engine merges probe evidence
9. Diagnosis is recalculated
10. Dashboard shows 2 VANTAGES
```

Using the explicit run ID avoids accidentally correlating unrelated tests that happen to target the same hostname.

## Diagnosis model

The diagnosis engine assigns evidence-weighted scores to fault domains:

- local network
- DNS
- VPN / route state
- ISP / upstream path
- endpoint path / policy
- target service

The highest supported domain becomes the likely diagnosis. Confidence is derived from evidence strength and increases when an independent vantage point materially supports the conclusion.

The engine remains deterministic. An LLM may later explain a completed diagnosis in customer-friendly language, but it should not invent the underlying fault domain.

## Security and privacy direction

Faultline does not require packet payloads, credentials, browser history or application content.

A live endpoint run can contain interface metadata, private gateway information, resolved IP addresses, VPN adapter names and traceroute hop addresses. A remote probe can contain its hostname, platform, resolved target addresses and target timing data.

The v0.3 run ID is a correlation identifier, **not an authentication token**. The current service should therefore be treated as a local or controlled-network prototype.

A hosted version needs:

- authenticated, short-lived diagnostic sessions
- organisation and case scoping
- transport authentication
- configurable telemetry redaction
- persistent storage with retention controls
- an audit trail for contributed evidence
- registered probe identity and health

## Next architecture milestone

The next major step is to make the control plane durable and safe enough to host:

```text
Endpoint agents -> authenticated sessions -> persistent incident store
                                              ^
                                              |
                                  registered remote probes
```

After that, remote probes can gain richer path measurements and Faultline can generate portable evidence reports for support escalation.
