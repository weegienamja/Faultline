# Faultline Windows Agent

The Faultline endpoint agent collects local network evidence from Windows and submits it to the Faultline API for deterministic diagnosis.

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or newer
- PowerShell and standard Windows networking utilities on PATH

The collector uses `Get-NetRoute`, `Get-NetAdapter`, `netsh`, `ping` and `tracert`. It does not require a packet-capture driver.

## Basic use

Start Faultline:

```bash
npm start
```

Then run the endpoint agent:

```bash
npm run agent -- --target microsoft.com
```

The agent posts to `POST /api/agent-runs`. The server returns a `LIVE-...` run ID and the CLI prints the remote-probe command needed to add an independent vantage point.

## Options

```text
--target <hostname|IP|URL>   Required diagnostic target
--port <number>              Target TCP port, default 443
--api-base <url>             Faultline server base URL
--api <url>                  Override the full agent ingestion endpoint
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

If a supported VPN adapter is active but the expected route is missing, the diagnosis engine can isolate the incident to the VPN / route fault domain.

## Evidence collected

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
- normalized target host, port and URL for later remote correlation

## Two-vantage workflow

After upload, the endpoint agent prints a command similar to:

```bash
npm run probe -- --run LIVE-ME5X2F --api-base http://localhost:3000
```

Run that command from a different network or machine to attach an independent remote result to the same incident. See [REMOTE_PROBE.md](REMOTE_PROBE.md).

## Interpretation caveats

ICMP is diagnostic evidence, not proof of ownership. Routers and services may rate-limit or block ICMP while forwarding production traffic normally. Faultline suppresses apparent 100% target ICMP loss when TCP or HTTP proves the target is reachable.

Traceroute hop timeouts do not automatically mean that hop is faulty. The dashboard labels the trace as an endpoint observation rather than ownership proof.

## Privacy

The agent does not capture packet payloads, credentials or application content. A submitted run can still contain operational network metadata such as hostname, adapter details, private gateway address, VPN adapter names, resolved target addresses and traceroute hop addresses.

Use `--dry-run --json` to inspect the exact payload before sending it to any non-local API.

## Validation status

Parser and helper functions are covered by automated tests using representative Windows command output. The collector is Windows-specific, so the full operating-system probe path should still be exercised across real Windows adapters and VPN clients before treating v0.3 as production-ready.
