# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a common support problem: every team can see its own part of a connection, but nobody has enough shared evidence to say where a fault actually begins.

Instead of producing another wall of network metrics, Faultline correlates observations into a likely **fault domain**, explains the evidence behind that decision, and recommends the next action.

## Why Faultline?

A typical connectivity incident crosses several ownership boundaries:

```text
Endpoint -> Wi-Fi/LAN -> ISP -> Internet transit -> SaaS / application
```

The end user sees a broken application. Internal IT sees a healthy LAN. The ISP sees an active circuit. The SaaS provider sees healthy servers.

Faultline is intended to bridge those viewpoints without requiring either side to hand over full administrative access.

## Current build: v0.2

Faultline now has a real Windows-first endpoint collector rather than relying exclusively on demo telemetry.

The current build includes:

- a commercial-style incident dashboard designed around fault-domain isolation
- deterministic diagnosis logic for local network, DNS, VPN, upstream and target-service failures
- a Windows endpoint agent that collects live network evidence
- default-gateway latency and packet-loss measurement
- DNS resolution and lookup timing
- general internet TCP reachability checks
- target TCP, HTTP and ICMP observations
- packet-loss and jitter calculation
- Wi-Fi signal collection when available
- VPN adapter discovery and optional expected-route validation
- bounded traceroute collection
- live agent ingestion through `POST /api/agent-runs`
- automatic display of new endpoint runs in the dashboard
- explicit `Not collected` state for external-probe evidence that does not exist yet
- four deterministic demo incidents for demonstrations
- automated tests for the diagnosis engine and Windows command parsers
- zero third-party runtime dependencies

## Run Faultline

Requires Node.js 20 or newer.

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

For development with automatic restarts:

```bash
npm run dev
```

## Run a live diagnostic

The endpoint collector currently targets Windows 10/11.

Start the Faultline server, then open a second terminal and run:

```bash
npm run agent -- --target microsoft.com
```

The agent will collect endpoint-side evidence, POST it to the local Faultline API, and print the resulting diagnosis. The dashboard polls for new runs and automatically surfaces the latest live diagnostic.

You can target a URL:

```bash
npm run agent -- --target https://example.com/health
```

Or test a VPN-dependent route:

```bash
npm run agent -- \
  --target 10.40.12.25 \
  --port 443 \
  --vpn-required \
  --expected-route 10.40.0.0/16
```

Inspect telemetry without uploading it:

```bash
npm run agent -- --target microsoft.com --dry-run --json
```

See [docs/AGENT.md](docs/AGENT.md) for the full collector options and interpretation caveats.

## What the Windows agent measures

```text
Windows endpoint
      |
      +-- Default route / active adapter
      +-- Wi-Fi signal
      +-- Gateway ping
      +-- DNS lookup
      +-- Internet control probes
      +-- VPN adapter / expected route
      +-- Target TCP / HTTP
      +-- Target loss / jitter
      +-- Traceroute
      |
      v
POST /api/agent-runs
      |
      v
Deterministic diagnosis
      |
      v
Faultline dashboard
```

The agent deliberately uses multiple signals. For example, if a destination blocks ICMP but still answers TCP or HTTP, Faultline does not treat the ICMP timeout alone as 100% upstream packet loss.

## Test it

```bash
npm test
npm run check
```

The automated suite covers both the fault-domain engine and collector parsing helpers. The Windows collector itself should still be exercised on a real Windows machine before treating this early prototype as production-ready.

## Diagnosis API

The original stateless diagnosis endpoint remains available:

```bash
curl -X POST http://localhost:3000/api/diagnose \
  -H "content-type: application/json" \
  -d '{
    "gatewayLoss": 0,
    "gatewayLatencyMs": 3,
    "dnsResolved": true,
    "internetReachable": true,
    "upstreamLoss": 8.4,
    "jitterMs": 71,
    "externalProbeHealthy": true,
    "targetReachable": true
  }'
```

The response contains a likely fault domain, confidence score, supporting evidence and recommended actions.

## Live-run API

The Windows collector submits a richer payload to:

```text
POST /api/agent-runs
```

Recent live runs can be inspected at:

```text
GET /api/agent-runs
```

v0.2 stores live runs **in process memory only**. Restarting the server clears them.

## Product direction

The next major step is the second side of the bridge: an independent remote probe.

```text
Endpoint Agent                     Faultline                      Remote Probe
     |                                |                                |
     +---------- telemetry ---------->|<---------- telemetry ----------+
                                      |
                                      v
                              correlated diagnosis
```

That second vantage point will allow Faultline to compare what the endpoint sees with what an independent location sees, materially improving isolation between local-network, ISP/transit and target-service faults.

After that, the product needs persistent incident storage, authenticated diagnostic sessions and configurable telemetry redaction.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture and design direction.

## Privacy and scope

Faultline does **not** capture packet payloads, credentials, browser history or application content.

Live endpoint runs can contain operational metadata such as the machine hostname, adapter details, private gateway address, VPN adapter names, resolved target addresses and traceroute hop addresses. Use `--dry-run --json` to inspect exactly what would be submitted before pointing the agent at a remote API.

## Status

Faultline is an early product prototype, not a replacement for production network observability or digital-experience monitoring platforms. v0.2 provides a real endpoint evidence source, while multi-vantage correlation and a hosted control plane remain future work.

## License

MIT
