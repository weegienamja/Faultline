# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a support gap that appears when a network-dependent application fails across ownership boundaries. The endpoint, local network, VPN, ISP, Internet path and application may be owned by different teams, while each party can see only part of the failure.

```text
Affected endpoint -> Wi-Fi/LAN -> ISP -> Internet -> application/service
```

Faultline creates a scoped diagnostic, collects evidence from the affected Windows endpoint and an independent remote probe, applies deterministic fault-domain reasoning, and preserves the evidence behind the conclusion.

It is an **incident-first portfolio/research prototype**, not a replacement for continuous observability platforms.

## Current state

Implemented previews now include:

- deterministic fault-domain diagnosis
- real Windows endpoint telemetry
- standalone `Faultline.exe` with one-time consent/credential handoff
- endpoint + independent remote-vantage correlation
- registered probe fleet with automatic scheduling and public-probe safety controls
- passive inferred Network Map
- versioned Connectivity Contracts for DNS/TCP/TLS/HTTP requirements
- Incident Intelligence using standardisation, similarity scoring and DBSCAN clustering
- **v0.8 Cases & Evidence Packages** with multiple diagnostics, evidence timeline, before/after comparison and shareable exports
- Docker deployment and Windows CI packaging
- zero third-party runtime dependencies

## No AI API by design

Faultline does not use an AI or LLM API in diagnosis or Incident Intelligence.

```text
same evidence -> same rules -> same deterministic diagnosis
```

The Data Science layer answers a separate question: **which other incidents have a similar measured evidence pattern?** Fault-domain labels are removed before clustering so the unsupervised model cannot simply rediscover the existing diagnosis.

## Architecture

```text
                              Faultline control plane
                    +-------------------------------------+
                    | cases + diagnostic sessions         |
                    | credentials + invitations           |
                    | probe registry + scheduler          |
                    | evidence + audit + correlation      |
                    +------------------+------------------+
                                       |
                    +------------------+------------------+
                    |                                     |
                    v                                     v
             Faultline.exe                         Registered probe
             affected endpoint                     independent vantage
                    |                                     |
          local path + topology                      safe target tests
          Connectivity Contract                     remote reachability
                    |                                     |
                    +------------------+------------------+
                                       |
                                       v
                              deterministic diagnosis
                                       |
                     +-----------------+-----------------+
                     |                                   |
                     v                                   v
               Support case                       Incident Intelligence
          timeline + evidence package            similarity + DBSCAN
```

Design notes:

- [Architecture](docs/ARCHITECTURE.md)
- [Ephemeral diagnostics](docs/EPHEMERAL_DIAGNOSTICS.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
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

Then open `http://localhost:3000`. Demo incidents remain public. Use **Unlock live data** for live diagnostics, probes and case workspaces.

## One-time support diagnostic

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

The affected-user flow is:

```text
one-time link
    -> review scope + Connectivity Contract
    -> explicit consent
    -> download .faultline handoff
    -> run Faultline.exe
    -> one-use launcher exchange
    -> collect + upload endpoint evidence
    -> independent probe adds second vantage
    -> deterministic fault-domain result
```

The browser never receives the endpoint upload credential.

## v0.8 Cases & Evidence Packages

A diagnostic session is one measurement. A **case** represents the support incident around those measurements.

The dashboard now supports:

```text
Support case
  |- title / customer / service / severity / status
  |- diagnostic run 1
  |- diagnostic run 2
  |- engineer notes
  |- evidence timeline
  |- before/after comparison
  `- evidence export
```

Case evidence is explicitly separated into:

- **observed** endpoint and remote-vantage measurements
- **inferred** topology evidence
- **deterministic** diagnosis and Connectivity Contract results
- **statistical** incident-pattern evidence
- **annotations** supplied by engineers

Exports are available as versioned JSON or print-friendly HTML. The dashboard applies network-identifier redaction by default before export. JSON packages contain a canonical SHA-256 digest as an integrity aid.

See [docs/CASES_AND_EVIDENCE.md](docs/CASES_AND_EVIDENCE.md).

## Connectivity Contracts

Built-in generic profiles currently include:

```text
basic-reachability   DNS + TCP
secure-web           DNS + TCP + TLS + HTTP
web-api              DNS + TCP + TLS + HTTP
```

A validated, versioned contract snapshot is stored with the diagnostic session. Structured results include `contractPassed`, `contractPassRate`, `contractFailedRequired` and `contractFailureType`.

The current evaluator remains target-scoped. See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

## Incident Intelligence

The dashboard uses classical, inspectable Data Science:

```text
telemetry
  -> median imputation
  -> z-score standardisation
  -> binary + one-hot feature encoding
  -> weighted evidence distance
  -> pairwise similarity
  -> DBSCAN cluster or explicit outlier
```

Similarity percentages are evidence-similarity scores, not probabilities that two incidents share a root cause. See [docs/INCIDENT_INTELLIGENCE.md](docs/INCIDENT_INTELLIGENCE.md).

## Probe fleet

Public probes are restricted to Internet-routable destinations and a conservative port policy. They independently revalidate DNS answers and HTTP redirects before connection. Private probes are explicitly trusted internal vantages.

The scheduler excludes disabled, revoked, stale/offline, draining and maintenance probes and can filter by scope, country, region and tags before choosing the least-loaded eligible probe.

## Security model

```text
Admin token
  -> manage live control-plane data

Invitation token
  -> preview + consent for one ephemeral diagnostic

Launcher token
  -> one exchange for endpoint access

Endpoint token
  -> upload evidence for one short-lived session

Registered probe token
  -> heartbeat, receive assigned jobs and submit evidence
```

Raw endpoint, probe, invitation and launcher secrets are not persisted. Public probes enforce their own destination policy, topology can be disabled before consent, and contract requirements are disclosed before collection.

## Tests and CI

```bash
npm run check
npm test
```

CI validates the Node test suite and Docker image. A separate Windows job builds `Faultline.exe`, runs its packaged self-test and uploads the executable artifact.

## Current limitations

Faultline remains a portfolio/research prototype:

- JSON persistence with a one-writer assumption
- one administrator security domain
- scheduler has no distributed leases
- probe rate limiting is in-memory
- remote probes do not yet execute full Connectivity Contracts
- packaged Windows client is unsigned and needs broader real-machine testing
- topology remains endpoint inference rather than authoritative physical discovery
- Incident Intelligence uses prototype parameters over a small visible dataset
- case evidence digest is not a cryptographic signature or legal chain-of-custody system

## Roadmap

Completed foundation:

```text
v0.1-v0.7  diagnosis, telemetry, multi-vantage correlation,
           probe fleet, one-time Windows diagnostics,
           topology and Connectivity Contracts
Data Science preview  incident similarity + DBSCAN
v0.8       cases + evidence packages                  <- current
```

Forward path:

```text
v0.9  Cross-Party Incident Rooms
v1.0  Hosted Multi-Tenant MVP
v1.1  Connectivity Contract Ecosystem
v1.2  Embedded Diagnostics API + SDK
v1.3  Service Desk Integrations
v1.4  Deeper Network / Protocol Diagnostics
v1.5  Network Change Assurance
v1.6+ deeper intelligence, orchestration, ownership and enterprise hardening
v2.0  Cross-Boundary Network Incident Platform
```

See [ROADMAP.md](ROADMAP.md) for deliverables and exit criteria.

## License

MIT
