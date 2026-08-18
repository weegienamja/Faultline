# Faultline Windows Agent

The Faultline endpoint agent collects local network evidence from Windows and contributes it to an authenticated diagnostic session.

The current repository also includes the first v0.6 topology preview. In addition to path diagnostics, the endpoint can build a passive best-effort map of the local network using Windows interface, Wi-Fi and neighbour-table state.

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or newer
- PowerShell and standard Windows networking utilities on PATH

The collector uses `Get-NetRoute`, `Get-NetAdapter`, `Get-NetIPAddress`, `Get-NetNeighbor`, `netsh`, `ping` and `tracert`. It does not require a packet-capture driver.

## Authenticated use

Create a diagnostic session first. The session can optionally be assigned to a registered remote probe:

```powershell
npm run session -- --target microsoft.com --probe PRB-8A1B2C3D4E --admin-token $env:FAULTLINE_ADMIN_TOKEN
```

Faultline prints an endpoint command containing a session ID and a short-lived endpoint credential:

```powershell
npm run agent -- --session FL-6A1B2C3D4E --token fl_ep_... --api-base http://localhost:3000
```

The agent uses the endpoint credential to retrieve safe session metadata, so target, port, VPN requirements and registered-probe assignment come from the session rather than being guessed by the endpoint.

It submits evidence to:

```text
POST /api/agent-runs
```

The control plane verifies that the credential belongs to the **endpoint role** for that session before accepting the payload.

If the session has `assignedProbeId`, the accepted endpoint evidence makes the session eligible for that registered probe's private job queue.

## Standalone dry run

Inspect endpoint collection without uploading:

```powershell
npm run agent -- --target microsoft.com --dry-run --json
```

An unauthenticated `--target` run cannot upload. This is deliberate.

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
--no-topology                Omit passive local-topology evidence
--dry-run                    Collect locally without uploading
--json                       Print the full payload
```

The endpoint token can alternatively be supplied through:

```text
FAULTLINE_ENDPOINT_TOKEN
```

## Passive topology discovery

Topology collection is enabled by default in the current preview.

Faultline reads:

- active local IPv4 address and prefix
- adapter MAC address
- default gateway
- Wi-Fi SSID/BSSID, signal, radio type and channel when available
- the existing Windows IPv4 neighbour table

It then builds `telemetry.topology`, which contains device nodes, links, confidence levels and the inferred affected path.

This initial implementation does **not** sweep the subnet or probe every private address. It only uses information already available from Windows.

Use:

```powershell
npm run agent -- --session FL-... --token fl_ep_... --no-topology
```

to omit topology evidence from the payload.

See [TOPOLOGY.md](TOPOLOGY.md) for the inference rules and privacy boundary.

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
- active interface metadata and IPv4 address
- adapter MAC address
- Wi-Fi signal, SSID/BSSID, radio type and channel when available
- passive local neighbour-table observations for topology
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

Each diagnostic session has a dedicated endpoint token.

The endpoint token:

- is random, high-entropy bearer material
- is scoped to one diagnostic session
- is accepted only for the endpoint role
- expires with the session
- is stored only as a hash by the control plane

A registered remote probe does not share this token. It authenticates using its own durable `fl_probe_...` credential and sees a session only after the administrator explicitly assigns that probe and endpoint evidence is ready.

When a remote Faultline server is used, send bearer credentials only over HTTPS.

## Two-vantage workflow

After endpoint evidence is accepted, the incident appears as **ENDPOINT ONLY**.

If a registered probe was assigned, its worker discovers the job automatically and contributes the second vantage. If no registered probe was assigned, use the one-off probe command printed during session creation.

When remote evidence arrives, the same session becomes **2 VANTAGES** and Faultline recalculates the diagnosis.

See [PROBE_FLEET.md](PROBE_FLEET.md) and [REMOTE_PROBE.md](REMOTE_PROBE.md).

## Interpretation caveats

ICMP is diagnostic evidence, not proof of ownership. Routers and services may rate-limit or block ICMP while forwarding production traffic normally. Faultline suppresses apparent 100% target ICMP loss when TCP or HTTP proves the target is reachable.

Traceroute hop timeouts do not automatically mean that hop is faulty. The dashboard labels the trace as an endpoint observation rather than ownership proof.

Topology relationships have a similar rule: the neighbour table can prove that Windows has learned about another local device, but it cannot prove the physical switch/AP chain. The topology model therefore records `observed` and `confidence` on relationships.

## Privacy

The agent does not capture packet payloads, user credentials, browser history or application content.

A submitted run can still contain operational network metadata such as:

- endpoint hostname
- private IPv4 address
- adapter and gateway MAC addresses
- Wi-Fi BSSID
- neighbouring-device IP/MAC pairs represented in the inferred topology
- VPN adapter names
- resolved target addresses
- traceroute hop addresses

Use standalone `--dry-run --json` mode to inspect the exact collector payload. Use `--no-topology` if local topology metadata should not be uploaded.

The planned ephemeral-diagnostic workflow should add an explicit evidence preview/consent step before upload.

## Validation status

Parser, diagnostic and topology helper functions are covered by automated tests using representative inputs. The collector remains Windows-specific, so the full operating-system probe path should continue to be exercised across real adapters, Wi-Fi chipsets, mesh systems and VPN clients before treating Faultline as production network software.
