# Faultline architecture

Faultline is designed around one principle: **diagnosis should come from evidence collected at explicit vantage points, not from an LLM guessing at telemetry.**

## v0.2

```text
Windows endpoint
     |
     |  local telemetry
     v
Faultline Agent
     |
     |  POST /api/agent-runs
     v
Node HTTP API ---------> deterministic diagnosis engine
     |                              |
     |                              v
     +----------------------> evidence + fault domain + actions
     |
     v
Browser dashboard
```

The dashboard continues to include deterministic demo incidents, but v0.2 can also ingest measurements from the Windows endpoint collector. Live runs are held in process memory and automatically appear in the dashboard while the server is running.

## Endpoint collector

The Windows collector uses operating-system networking tools and Node.js probes rather than packet interception.

### Local operating-system state

PowerShell is used to read:

- the active IPv4 default route
- the adapter associated with that route
- active adapters that look like VPN interfaces
- IPv4 routes needed for an optional expected-route check

`netsh wlan show interfaces` provides best-effort Wi-Fi signal metadata.

### Active measurements

The agent performs:

- ICMP sampling to the default gateway
- DNS resolution and lookup timing for the target
- independent TCP control probes for general internet reachability
- TCP connection timing to the target
- HTTP response timing when the target is an HTTP(S) URL or hostname
- ICMP sampling to the target for loss and jitter
- direct-IP ICMP testing after DNS resolution
- a bounded `tracert` path observation unless disabled

The collector treats a target that answers TCP/HTTP but blocks ICMP as reachable rather than reporting 100% upstream loss.

## Agent ingestion contract

`POST /api/agent-runs` accepts a payload with three main sections:

```json
{
  "agent": {
    "name": "faultline-windows",
    "version": "0.2.0",
    "hostname": "ENDPOINT-01"
  },
  "incident": {
    "title": "Live diagnostic · example.com",
    "target": "example.com"
  },
  "metrics": {
    "gatewayLoss": 0,
    "gatewayLatencyMs": 3,
    "dnsResolved": true,
    "internetReachable": true,
    "upstreamLoss": 0,
    "jitterMs": 4,
    "targetReachable": true
  }
}
```

The server runs the same deterministic diagnosis engine used by the demo incidents, stores the run in memory, and returns the completed diagnosis.

## Diagnosis model

The diagnosis engine assigns evidence-weighted scores to fault domains:

- local network
- DNS
- VPN / route state
- ISP / upstream path
- target service

The highest supported domain becomes the likely diagnosis. Confidence is derived from the strength and agreement of the available evidence.

This remains deterministic. An LLM may later explain a completed diagnosis in customer-friendly language, but it should not invent the underlying fault domain.

## Multi-vantage direction

A single endpoint cannot prove every ownership boundary. The intended next architecture adds a remote probe:

```text
Endpoint Agent                      Faultline service                    Remote probe
+----------------+                 +----------------+                 +----------------+
| LAN / Wi-Fi    |  measurements   | Correlation    |  measurements   | Internet /     |
| DNS / routes   | --------------> | + diagnosis    | <-------------- | service edge   |
| VPN / path     |                 | + evidence     |                 | control path   |
+----------------+                 +----------------+                 +----------------+
```

That second vantage point is what can materially improve isolation between endpoint, ISP/transit and target-service problems. The v0.2 dashboard therefore reports external-probe data as **not collected** for live endpoint runs rather than inventing a result.

## Security and privacy direction

Faultline does not need packet payloads, credentials, browser history or application content. v0.2 collects network state and timing data only.

A live run can include interface metadata, private gateway information, resolved IP addresses, VPN adapter names and traceroute hop addresses. Anyone pointing the agent at a remote Faultline API should therefore understand where that telemetry is being sent.

Future hosted versions should add:

- signed, short-lived diagnostic sessions
- explicit organisation and case scoping
- transport authentication
- configurable telemetry redaction
- persistent storage with retention controls
- an audit trail for contributed evidence
