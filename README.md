# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a recurring support gap: when a network-dependent application fails across ownership boundaries, each team can usually see its own infrastructure but nobody has a shared evidence set showing where the fault begins.

```text
Affected endpoint -> Wi-Fi/LAN -> ISP -> Internet -> application/service
```

Faultline creates a short-lived diagnostic case, collects evidence from the affected Windows endpoint and an independent remote probe, correlates those observations into a deterministic fault domain, and shows the evidence behind the conclusion.

It is intentionally an **incident-first support prototype**, not a replacement for continuous observability products.

## Current state

The repository contains the stable v0.5 registered-probe foundation plus working v0.6/v0.7 previews and a contained Data Science incident-intelligence layer.

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
- **Incident Intelligence preview** using standardisation, similarity scoring and DBSCAN clustering
- explicit outlier/noise handling instead of forcing every incident into a pattern
- Docker deployment
- zero third-party runtime dependencies

## No AI API by design

Faultline does **not** use an AI or LLM API in the diagnosis path or the incident-intelligence layer.

```text
same evidence -> same rules -> same diagnosis
```

The deterministic engine answers **where the evidence suggests the fault begins**. The Data Science layer answers a different question: **which other visible incidents have a similar measured evidence pattern?**

Fault-domain labels are deliberately removed before fitting the dashboard clustering model so the unsupervised analysis cannot simply rediscover the diagnosis already assigned by Faultline.

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
                                     |
                                     v
                       Incident Intelligence layer
                    similarity + DBSCAN + outliers
```

Detailed design notes:

- [Architecture](docs/ARCHITECTURE.md)
- [Ephemeral diagnostics](docs/EPHEMERAL_DIAGNOSTICS.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
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

A validated, versioned contract snapshot is stored with each diagnostic session. The affected user sees the selected contract and required checks before consenting.

Structured contract results are stored under:

```text
telemetry.connectivityContract
```

with summary features such as:

```text
contractPassed
contractPassRate
contractFailedRequired
contractFailureType
```

The first evaluator is intentionally **target-scoped**. Verified multi-endpoint vendor profiles remain later work.

See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

# Incident Intelligence

The dashboard now includes a **Related evidence patterns** panel.

It analyses only the incidents the current browser session is already allowed to see:

```text
locked dashboard       -> demo incidents
admin-unlocked         -> authorised live + demo incidents
```

The pipeline is classical, inspectable Data Science:

```text
raw incident telemetry
        |
        v
median imputation for missing numerical values
        |
        v
z-score standardisation
        |
        +-- binary network-state encoding
        +-- one-hot Connectivity Contract categories
        |
        v
weighted evidence distance
        |
        +--> pairwise similarity ranking
        |
        v
DBSCAN density clustering
        |
        +--> dense incident pattern
        +--> explicit noise / outlier
```

Current numerical features include gateway latency/loss, upstream loss, jitter, DNS/TCP/HTTP timings and contract summary values. Binary features include DNS, Internet, target, remote-vantage and VPN states.

The dashboard deliberately strips the deterministic fault-domain label before fitting clusters. Diagnosis remains available to the normal Faultline UI, but it does not drive evidence-pattern membership.

The demo dataset contains a repeatable three-case upstream-degradation family (`FL-1042`, `FL-1040`, `FL-1038`) and unrelated DNS, VPN and local-network cases that remain outliers at the preview threshold.

Similarity percentages are relative evidence-similarity scores, **not probabilities that two incidents share a root cause**.

See [docs/INCIDENT_INTELLIGENCE.md](docs/INCIDENT_INTELLIGENCE.md).

# Windows client

The packaged endpoint client uses Node's Single Executable Application mechanism and requires no separate Node/npm installation on the affected computer.

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

A **public** probe is intended for Internet-routable services and applies strict destination/port checks. A **private** probe is an explicitly trusted internal vantage.

The scheduler excludes disabled, revoked, stale/offline, draining and maintenance probes, filters by scope/country/region/tags, and selects the least-loaded eligible probe.

# Network Map

The Windows endpoint uses passive local evidence rather than sweeping the subnet:

- active IPv4 interface/address
- adapter MAC
- default gateway
- Wi-Fi SSID/BSSID/signal/channel when available
- existing IPv4 neighbour table

Faultline renders a draggable inferred graph and distinguishes observed from inferred relationships.

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
- browser consent does not expose endpoint credentials
- launcher credentials are one-use
- endpoint credentials expire with their session
- public probes enforce their own destination policy
- topology collection can be disabled before consent
- contract details are disclosed before consent
- incident intelligence creates no separate private-data API and uses only already-authorised incident data
- diagnosis, contract evaluation and intelligence explanations remain deterministic

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
- probe scheduling, safety and credential lifecycle
- topology inference
- invitation/consent/client credential exchange
- Connectivity Contract validation and persistence
- incident feature engineering and vector compatibility
- DBSCAN cluster/outlier behaviour
- similarity ordering
- proof that fault-domain labels do not influence dashboard clustering
- Windows packaged-client self-test

CI also builds the Docker image. A separate Windows job builds and executes the generated `Faultline.exe` self-test.

# Current limitations

Faultline is a portfolio/research prototype, not a production multi-tenant SaaS platform.

- JSON persistence and one-writer assumption
- one administrator security domain
- scheduler does not use distributed leases
- probe rate limiting is in-memory
- job delivery is polling-based
- remote probes currently provide generic reachability rather than executing full Connectivity Contracts
- v0.7 contract evaluation is target-scoped
- Windows client needs broader real-machine testing and is unsigned
- topology remains endpoint inference rather than authoritative discovery
- incident-intelligence parameters are prototype values fitted to a small visible evidence set
- similarity is descriptive, not a calibrated common-root-cause probability
- no time-window, ASN/provider or geography features yet

# Roadmap

The completed foundation now covers deterministic diagnosis, real endpoint telemetry, multi-vantage correlation, the remote-probe fleet, one-time Windows diagnostics, inferred topology, Connectivity Contracts and the first Incident Intelligence model.

The redesigned forward roadmap is:

```text
v0.8  Cases + Evidence Packages
v0.9  Cross-Party Incident Rooms
v1.0  Hosted Commercial MVP
v1.1  Connectivity Contract Ecosystem
v1.2  Embedded Diagnostics API + SDK
v1.3  Service Desk Integrations
v1.4  Deeper Network / Protocol Diagnostics
v1.5  Network Change Assurance
v1.6  Incident Intelligence v2
v1.7  Multi-Vantage Orchestration
v1.8  Authoritative Topology + Ownership Boundaries
v1.9  Enterprise Readiness
v2.0  Cross-Boundary Network Incident Platform
```

The immediate next milestone is **v0.8**, which turns individual diagnostic runs into support cases with multiple runs, before/after comparison, evidence provenance, exportable evidence packages and read-only sharing.

See [ROADMAP.md](ROADMAP.md) for the full v0.8-v2.0 deliverables and exit criteria.

## License

MIT
