# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a recurring support gap: when a network-dependent application fails across ownership boundaries, each team can usually see its own infrastructure but nobody has a shared evidence set showing where the fault begins.

```text
Affected endpoint -> Wi-Fi/LAN -> ISP -> Internet -> application/service
```

Faultline creates a short-lived diagnostic case, collects evidence from the affected Windows endpoint and an independent remote probe, correlates those observations into a deterministic fault domain, and shows the evidence behind the conclusion.

It is intentionally an **incident-first support prototype**, not a replacement for continuous observability products.

## Current state

The repository contains the stable v0.5 registered-probe foundation plus working v0.6 and v0.7 preview slices.

### Implemented

- deterministic fault-domain diagnosis
- Windows endpoint telemetry
- standalone `Faultline.exe` preview with no Node/npm requirement on the affected PC
- one-time diagnostic invitation and explicit consent flow
- one-use browser-to-client launcher credential
- two-vantage endpoint + remote-probe correlation
- persistent diagnostic sessions and telemetry
- registered remote-probe fleet
- automatic probe selection by scope, country, region and tags
- public/private probe trust scopes
- public-probe destination and redirect safety policy
- probe drain, maintenance, credential rotation and revocation
- bounded lifecycle audit events
- passive inferred local Network Map
- **v0.7 Connectivity Contracts** for application-specific DNS/TCP/TLS/HTTP conditions
- Docker deployment
- zero third-party runtime dependencies

## No AI API by design

Faultline does **not** use an AI or LLM API in the diagnosis path.

```text
same evidence -> same rules -> same diagnosis
```

The point is to produce support evidence that can be explained and challenged. Later statistical or machine-learning features can identify patterns across incidents without replacing the deterministic fault-domain decision.

## Architecture

```text
                            Faultline control plane
                     +--------------------------------+
                     | sessions + credentials         |
                     | probe registry + scheduler     |
                     | invitation/client handoff      |
                     | persistent evidence + audit    |
                     | deterministic correlation      |
                     +---------------+----------------+
                                     |
                    +----------------+----------------+
                    |                                 |
                    v                                 v
             Faultline.exe                     Registered probe
             affected endpoint                 independent vantage
                    |                                 |
          local path + topology                  safe target tests
          Connectivity Contract                 generic reachability
                    |                                 |
                    +----------------+----------------+
                                     |
                                     v
                           correlated fault domain
```

Detailed design notes:

- [Architecture](docs/ARCHITECTURE.md)
- [Ephemeral diagnostics](docs/EPHEMERAL_DIAGNOSTICS.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md)
- [Probe fleet](docs/PROBE_FLEET.md)
- [Fleet safety](docs/FLEET_SAFETY.md)
- [Topology](docs/TOPOLOGY.md)
- [Roadmap](ROADMAP.md)

## Run locally

Requires Node.js 20+ for the control plane.

```bash
npm start
```

For a stable admin credential:

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

PowerShell:

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_change_this_to_a_long_random_value"
npm start
```

Then open:

```text
http://localhost:3000
```

Demo incidents remain public. Use **Unlock live data** for live sessions and the probe fleet.

# One-time support diagnostic

## Engineer workflow

Use **New diagnostic** in the dashboard or the CLI.

```bash
npm run invite -- \
  --target https://example.com/health \
  --contract secure-web \
  --title "Application intermittently unavailable" \
  --customer "Example Ltd" \
  --ttl 60 \
  --admin-token "$FAULTLINE_ADMIN_TOKEN" \
  --api-base https://faultline.example.com
```

By default the CLI asks Faultline to choose the least-loaded matching online **public** probe.

Optional probe selectors:

```bash
npm run invite -- \
  --target https://example.com \
  --contract secure-web \
  --probe-country gb \
  --probe-region europe-west \
  --probe-tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Explicit registered probe:

```bash
npm run invite -- --target example.com --probe PRB-8A1B2C3D4E --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

One-off probe fallback:

```bash
npm run invite -- --target example.com --one-off-probe --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Faultline returns a short-lived link such as:

```text
https://faultline.example.com/diagnose#invite=fl_inv_...
```

Remote invitation links should use HTTPS. Plain HTTP is retained for localhost development.

## Affected-user workflow

```text
Open one-time link
      |
      v
Review diagnostic scope + Connectivity Contract
      |
      v
Explicit consent
      |
      v
Download .faultline handoff
      |
      v
Run Faultline.exe
      |
      v
One-use launcher -> endpoint credential
      |
      v
Collect + upload evidence
      |
      v
Independent probe adds second vantage
      |
      v
Fault-domain result
```

The browser never receives the endpoint upload credential.

The invitation secret is consumed after consent. A separate `fl_launch_...` credential is written into the downloaded handoff and exchanged once by `Faultline.exe`. The endpoint credential is created only during that native-client exchange.

# v0.7 Connectivity Contracts

Connectivity Contracts describe **what a particular application path requires from the network**.

List the built-in profiles:

```bash
npm run invite -- --list-contracts
```

Current generic profiles:

```text
basic-reachability   DNS + TCP
secure-web           DNS + TCP + TLS + HTTP
web-api              DNS + TCP + TLS + HTTP
```

Example contract:

```json
{
  "id": "secure-web",
  "version": 1,
  "name": "Secure web service",
  "checks": [
    { "id": "dns", "type": "dns", "required": true, "host": "$target.host" },
    { "id": "tcp", "type": "tcp", "required": true, "host": "$target.host", "port": "$target.port" },
    { "id": "tls", "type": "tls", "required": true, "host": "$target.host", "port": "$target.port" },
    { "id": "http", "type": "http", "required": true, "url": "$target.url", "maxStatus": 499 }
  ]
}
```

A validated, versioned snapshot is stored with the diagnostic session. The affected user sees the selected contract and required checks before consenting.

The packaged Windows client converts its network measurements into a structured result under:

```text
telemetry.connectivityContract
```

Summary metrics include:

```text
contractPassed
contractPassRate
contractFailedRequired
contractFailureType
```

Those fields deliberately create a clean feature set for later incident-similarity and clustering work.

### Current contract limitation

The first v0.7 evaluator is intentionally **target-scoped**. Built-in checks operate against the diagnostic target through `$target.host`, `$target.port` and `$target.url`.

The architecture can later support verified multi-endpoint vendor profiles, but the repository does not currently hard-code Microsoft, Cisco, Slack or other vendor requirements without validating those specifications first.

See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

# Windows client

The packaged endpoint client uses Node's Single Executable Application mechanism and requires no separate Node/npm installation on the affected computer.

Build on a suitable Windows/Node 26+ environment:

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
npm run build:windows-client
.\dist\Faultline.exe --self-test
```

GitHub Actions builds the executable on `windows-latest`, runs its embedded self-test and publishes it as a workflow artifact.

Configure the consent-page download URL with:

```text
FAULTLINE_WINDOWS_CLIENT_URL=https://downloads.example.com/Faultline.exe
```

The current binary is an unsigned preview. Authenticode signing and a stable release channel remain production-hardening work.

# Probe fleet

Register a public probe:

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --country gb \
  --region europe-west \
  --scope public \
  --tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Run the worker:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

## Public versus private probes

A **public** probe is intended for Internet-routable services. It rejects loopback, private, link-local, shared, documentation, multicast/reserved and mapped-private destinations and restricts ports to a conservative allow-list.

A **private** probe is an explicitly trusted internal-network vantage that may reach private address space and non-public ports.

Public workers independently validate the destination immediately before connection. DNS answer sets and HTTP redirects are revalidated rather than trusting the control-plane job blindly.

## Scheduling

The scheduler excludes probes that are disabled, revoked, stale/offline, draining or in maintenance. It can filter by scope, country, region and tags, then chooses the least-loaded eligible probe with deterministic tie-breaking.

## Lifecycle controls

```text
PATCH /api/probes/:id
POST  /api/probes/:id/rotate
POST  /api/probes/:id/revoke
GET   /api/audit
```

Supported states include online, stale, offline, draining, maintenance, disabled and revoked.

# Network Map

The Windows endpoint uses passive local evidence rather than sweeping the subnet:

- active IPv4 interface/address
- adapter MAC
- default gateway
- Wi-Fi SSID/BSSID/signal/channel when available
- existing IPv4 neighbour table

Faultline renders a draggable inferred graph and distinguishes observed from inferred relationships. Current topology labels include star, tree, low-confidence mesh evidence and unknown.

# Security model

```text
Admin token
  -> manage probes, create sessions, view live data

Invitation token
  -> preview + consent to one ephemeral diagnostic

Launcher token
  -> one exchange for the endpoint credential

Endpoint token
  -> upload evidence for one short-lived session

Registered probe token
  -> heartbeat, read own jobs, submit assigned evidence
```

Important properties:

- raw endpoint/probe/invitation/launcher secrets are not persisted; hashes are stored instead
- invitations cannot upload endpoint evidence
- browser consent does not expose endpoint credentials
- launcher credentials are one-use
- endpoint credentials expire with their diagnostic session
- public probes enforce their own destination policy
- topology collection can be disabled before consent
- contract details are disclosed before consent
- diagnostic and contract reasoning remains deterministic

# Tests and CI

```bash
npm run check
npm test
```

Coverage includes:

- fault-domain diagnosis
- endpoint parsing and telemetry
- two-vantage correlation
- session authentication and expiry
- persistent state and migration
- probe scheduling and target safety
- probe lifecycle/rotation/revocation
- topology inference
- invitation/consent/client credential exchange
- Connectivity Contract validation, placeholders and summaries
- contract persistence through the invitation/client exchange
- Windows packaged-client self-test

CI also builds the Docker image. A separate Windows job builds and executes the generated `Faultline.exe` self-test.

# Current limitations

Faultline is a portfolio/research prototype, not a production multi-tenant SaaS platform.

- JSON persistence and one-writer assumption
- one administrator security domain
- no named organisation/user accounts
- scheduler does not use distributed leases
- probe rate limiting is in-memory
- job delivery is polling-based
- remote probes currently provide generic DNS/TCP/HTTP reachability rather than executing full Connectivity Contracts
- v0.7 contract evaluation is target-scoped
- Windows client needs broader real-machine and enterprise-security testing
- packaged executable is unsigned
- topology remains endpoint inference rather than authoritative physical discovery
- no statistical incident-similarity layer yet

# Roadmap

The next portfolio-oriented step after v0.7 is a contained **incident similarity / clustering** layer. It will use structured features such as latency, loss, fault domain, remote-vantage state and Connectivity Contract outcomes to identify when independent diagnostics exhibit similar failure patterns.

That analysis will remain separate from deterministic root-cause reasoning.

See [ROADMAP.md](ROADMAP.md).

## License

MIT
