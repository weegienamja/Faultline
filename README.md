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

## Current build: v0.3

Faultline now supports **two-vantage diagnostics**. A Windows endpoint agent collects local-path evidence, then a portable remote probe can independently test the same target and attach its result to the existing live run.

The diagnosis is recalculated when the second vantage point arrives.

### What is implemented

- commercial-style incident dashboard
- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- portable remote probe for Windows, Linux and macOS with Node.js 20+
- live-run correlation by explicit run ID
- default-gateway latency and packet-loss measurement
- DNS resolution and lookup timing
- target TCP and HTTP observations
- endpoint packet-loss and jitter calculation
- Wi-Fi signal collection when available
- VPN adapter discovery and optional expected-route validation
- bounded endpoint traceroute collection
- remote target DNS, TCP and HTTP checks
- explicit endpoint-only versus two-vantage state in the dashboard
- evidence explaining why the diagnosis changed
- automated tests covering diagnosis, endpoint parsing, probe target handling and correlation
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

## Run a two-vantage diagnostic

### 1. Collect the endpoint side

The endpoint collector currently targets Windows 10/11.

```bash
npm run agent -- --target microsoft.com
```

The agent uploads the endpoint evidence and prints a live run ID, for example:

```text
Run LIVE-ME5X2F is now available in the Faultline dashboard.

Add an independent vantage point with:
  npm run probe -- --run LIVE-ME5X2F --api-base http://localhost:3000
```

At this point the dashboard labels the incident **ENDPOINT ONLY**.

### 2. Add the independent remote side

Run the printed probe command from another machine or network:

```bash
npm run probe -- \
  --run LIVE-ME5X2F \
  --api-base http://FAULTLINE-SERVER:3000 \
  --name london-probe
```

The remote probe retrieves the target associated with that live run, independently performs DNS, TCP and HTTP checks, then submits its evidence to:

```text
POST /api/probe-runs
```

Faultline correlates the result with the endpoint measurements, recomputes the diagnosis and updates the same incident. The dashboard then labels the run **2 VANTAGES**.

> Running both commands on the same computer is useful for testing the workflow, but it is not an independent network vantage point. For meaningful path comparison, run the remote probe on a separate network, VPS or hosted probe.

## What the two sides contribute

```text
Windows endpoint                         Remote probe
      |                                      |
      +-- Gateway health                     +-- DNS resolution
      +-- Wi-Fi signal                       +-- Target TCP
      +-- DNS                                +-- Target HTTP
      +-- Internet controls                  +-- Independent reachability
      +-- VPN / route state                  |
      +-- Target TCP / HTTP                  |
      +-- Loss / jitter                      |
      +-- Traceroute                         |
      |                                      |
      +--------------- Faultline ------------+
                         |
                         v
                correlated diagnosis
```

This lets Faultline reason about cases that a single endpoint cannot separate cleanly.

For example:

```text
Endpoint cannot reach target
Remote probe can reach target
        -> Endpoint path / policy

Endpoint cannot reach target
Remote probe cannot reach target
General internet is healthy
        -> Target service

Endpoint shows upstream loss
Remote probe reaches target normally
        -> ISP / upstream endpoint path
```

The correlation remains deterministic. The remote probe is evidence used by the diagnosis engine, not an AI-generated opinion.

## Endpoint agent options

```text
--target <hostname|IP|URL>   Required diagnostic target
--port <number>              Target TCP port, default 443
--api-base <url>             Faultline server base URL
--api <url>                  Override the full ingestion endpoint
--expected-route <CIDR>      Require an exact IPv4 route
--vpn-required               Mark the target as VPN-dependent
--no-trace                   Skip traceroute collection
--dry-run                    Collect without uploading
--json                       Print the full payload
```

See [docs/AGENT.md](docs/AGENT.md).

## Remote probe options

```text
--run <id>                   Existing live run ID
--api-base <url>             Faultline server base URL
--name <value>               Friendly probe name
--dry-run                    Collect without uploading
--json                       Print the full payload
```

See [docs/REMOTE_PROBE.md](docs/REMOTE_PROBE.md).

## Test it

```bash
npm test
npm run check
```

The current suite covers the deterministic diagnosis engine, Windows command parsers, remote-probe target handling and two-vantage correlation logic.

## API

### Stateless diagnosis

```text
POST /api/diagnose
```

### Endpoint runs

```text
POST /api/agent-runs
GET  /api/agent-runs
GET  /api/agent-runs/:id
```

### Remote probe runs

```text
POST /api/probe-runs
GET  /api/probe-runs
```

A probe payload references the endpoint run through `runId`. The server then merges remote reachability into the endpoint diagnosis contract and recalculates the result.

## Important limitations

Faultline is still an early prototype.

- live runs are stored **in process memory only**
- restarting the server clears live and probe runs
- there is no authentication or organisation isolation yet
- a run ID is currently a correlation key, not a security token
- the Windows collector still needs real-world exercise across more adapters, VPN clients and Windows configurations
- the remote probe currently measures application reachability rather than full remote traceroute/ICMP path telemetry

Do not expose the current ingestion API directly to the public internet without adding authentication and transport controls.

## Privacy

Faultline does **not** capture packet payloads, credentials, browser history or application content.

Endpoint runs can contain operational metadata such as machine hostname, adapter details, private gateway address, VPN adapter names, resolved target addresses and traceroute hop addresses. Remote probes submit their hostname, platform, resolved addresses and target timing data.

Use `--dry-run --json` on either collector to inspect the payload before sending it to a remote Faultline server.

## Product direction

The next engineering priorities are:

1. persistent incident storage
2. authenticated, short-lived diagnostic sessions
3. a hosted probe/control-plane deployment model
4. configurable telemetry redaction
5. richer remote path measurements
6. evidence-report export

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the architecture and design direction.

## Status

Faultline v0.3 demonstrates the core product hypothesis: **correlating evidence from both sides of a network boundary can improve fault-domain isolation without requiring either side to expose full administrative access.**

It is not a replacement for production network observability or digital-experience monitoring platforms.

## License

MIT
