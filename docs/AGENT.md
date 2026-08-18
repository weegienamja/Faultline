# Faultline Windows Agent

The Faultline endpoint agent collects local network evidence from Windows and contributes it to an authenticated diagnostic session.

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or newer
- PowerShell and standard Windows networking utilities on PATH

The collector uses `Get-NetRoute`, `Get-NetAdapter`, `netsh`, `ping` and `tracert`. It does not require a packet-capture driver.

## Authenticated use

Create a diagnostic session first:

```powershell
npm run session -- --target microsoft.com --admin-token $env:FAULTLINE_ADMIN_TOKEN
```

Faultline prints an endpoint command containing a session ID and a short-lived endpoint credential:

```powershell
npm run agent -- --session FL-6A1B2C3D4E --token fl_ep_... --api-base http://localhost:3000
```

The agent uses the endpoint credential to retrieve safe session metadata, so the diagnostic target, port and VPN requirements come from the session rather than being independently guessed by the endpoint.

It then submits evidence to:

```text
POST /api/agent-runs
```

The control plane verifies that the credential belongs to the **endpoint role** for that session before accepting the payload.

## Standalone dry run

You can still inspect endpoint collection without uploading anything:

```powershell
npm run agent -- --target microsoft.com --dry-run --json
```

An unauthenticated `--target` run cannot upload to v0.4. This is deliberate.

## Options

```text
--session <id>               Authenticated diagnostic session
--token <value>              Endpoint session credential
--api-base <url>             Faultline control-plane base URL
--target <hostname|IP|URL>   Standalone target for dry-run collection
--port <number>              Standalone target TCP port, default 443
--expected-route <CIDR>      Standalone expected IPv4 route
--vpn-required               Standalone target requires VPN
--no-trace                   Skip traceroute collection
--dry-run                    Collect locally without uploading
--json                       Print the full payload
```

The endpoint token can alternatively be supplied through:

```text
FAULTLINE_ENDPOINT_TOKEN
```

## VPN sessions

VPN requirements should normally be defined when the session is created:

```powershell
npm run session -- `
  --target 10.40.12.25 `
  --port 443 `
  --vpn-required `
  --expected-route 10.40.0.0/16 `
  --admin-token $env:FAULTLINE_ADMIN_TOKEN
```

The endpoint agent receives that expected route from the authenticated session and validates it against the Windows IPv4 route table.

If the VPN is connected but the expected route is missing, the deterministic diagnosis engine can isolate the incident to the VPN / route fault domain.

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
- normalized target host, port and URL

## Session security

Each diagnostic session has a dedicated endpoint token that is separate from the probe token.

The endpoint token:

- is random, high-entropy bearer material
- is scoped to one diagnostic session
- is accepted only for the endpoint role
- expires with the session
- is stored only as a hash by the control plane

The raw endpoint credential is shown when the session is created. Treat it as a temporary secret.

When a remote Faultline server is used, send the token only over HTTPS.

## Two-vantage workflow

After endpoint evidence is accepted, the persistent incident appears as **ENDPOINT ONLY**.

Run the probe command that was printed during session creation from another machine or network. When that independent result arrives, the same session becomes **2 VANTAGES** and Faultline recalculates the diagnosis.

See [REMOTE_PROBE.md](REMOTE_PROBE.md).

## Interpretation caveats

ICMP is diagnostic evidence, not proof of ownership. Routers and services may rate-limit or block ICMP while forwarding production traffic normally. Faultline suppresses apparent 100% target ICMP loss when TCP or HTTP proves the target is reachable.

Traceroute hop timeouts do not automatically mean that hop is faulty. The dashboard labels the trace as an endpoint observation rather than ownership proof.

## Privacy

The agent does not capture packet payloads, user credentials, browser history or application content. A submitted run can still contain operational network metadata such as hostname, adapter details, private gateway address, VPN adapter names, resolved target addresses and traceroute hop addresses.

Use standalone `--dry-run --json` mode to inspect the exact collector payload.

## Validation status

Parser and helper functions are covered by automated tests using representative Windows command output. The collector remains Windows-specific, so the full operating-system probe path should continue to be exercised across real adapters and VPN clients before treating Faultline as production network software.
