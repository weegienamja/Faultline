# Faultline Windows Agent

The Faultline agent is the first real telemetry source in the project. It collects endpoint-side network evidence and submits it to the local Faultline API for deterministic diagnosis.

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or newer
- PowerShell and the standard Windows networking utilities available on PATH

The collector uses `Get-NetRoute`, `Get-NetAdapter`, `netsh`, `ping` and `tracert`. It does not require a packet-capture driver.

## Basic use

Start Faultline in one terminal:

```bash
npm start
```

Then run the agent in another terminal:

```bash
npm run agent -- --target microsoft.com
```

The agent posts to:

```text
http://localhost:3000/api/agent-runs
```

The dashboard polls for new runs and should surface the new live incident automatically.

## Options

```text
--target <hostname|IP|URL>   Required diagnostic target
--port <number>              Target TCP port, default 443
--api <url>                  Alternate Faultline ingestion endpoint
--expected-route <CIDR>      Require an exact IPv4 route
--vpn-required               Mark the target as VPN-dependent
--no-trace                   Skip traceroute collection
--dry-run                    Collect locally without uploading
--json                       Print the full payload
```

### VPN example

```bash
npm run agent -- \
  --target 10.40.12.25 \
  --port 443 \
  --vpn-required \
  --expected-route 10.40.0.0/16
```

If a supported VPN adapter is active but the expected route is missing, the existing diagnosis engine can isolate the incident to the VPN / route fault domain.

## Evidence collected

The current collector can provide:

- active default gateway
- active interface metadata
- Wi-Fi signal percentage when available
- active VPN-like adapters
- DNS result and lookup time
- gateway packet loss and latency
- general internet TCP reachability
- target TCP connection timing
- target HTTP response timing when applicable
- target ICMP packet loss and jitter
- direct-IP reachability after DNS resolution
- bounded traceroute hops
- expected-route presence for VPN scenarios

## Interpretation caveats

ICMP is diagnostic evidence, not proof of ownership. Routers and services may rate-limit or block ICMP while forwarding production traffic normally. For that reason the collector suppresses apparent 100% target ICMP loss when TCP or HTTP proves the target is reachable.

Likewise, traceroute hop timeouts do not automatically mean that hop is faulty. The dashboard labels the trace as an endpoint observation rather than ownership proof.

A single endpoint also cannot conclusively distinguish every ISP/transit problem from a service-edge issue. A future remote probe will provide the second vantage point needed for stronger correlation.

## Privacy

The agent does not capture packet payloads, credentials or application content. A submitted run can still contain operational network metadata such as:

- hostname
- adapter names and descriptions
- private gateway address
- VPN adapter names
- resolved target addresses
- traceroute hop addresses

Use `--dry-run --json` to inspect the exact payload before sending it to any non-local API.

## Current validation status

The parser and helper functions are covered by automated tests using representative Windows command output. The collector is Windows-specific, so the full operating-system probe path should also be exercised on a real Windows endpoint before treating v0.2 as production-ready.
