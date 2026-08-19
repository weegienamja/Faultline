# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a support gap that appears when a network-dependent application fails across ownership boundaries. The endpoint, local network, VPN, ISP, Internet path and application may be owned by different teams, while each party can see only part of the failure.

```text
Affected endpoint -> Wi-Fi/LAN -> ISP -> Internet -> application/service
```

Faultline creates scoped diagnostics, collects endpoint and independent remote-vantage evidence, applies deterministic fault-domain reasoning, groups related evidence patterns statistically, and preserves the result in a support case that can be shared across organisational boundaries.

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
- **v0.8 Cases & Evidence Packages** with multiple diagnostics, evidence timeline, before/after comparison and redacted exports
- **v0.9 Cross-Party Incident Rooms** with scoped observer/contributor invitations, external evidence contributions, expiry and revocation
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
                     |
                     v
             Cross-party room
          scoped external evidence
```

Design notes:

- [Architecture](docs/ARCHITECTURE.md)
- [Ephemeral diagnostics](docs/EPHEMERAL_DIAGNOSTICS.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
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

Then open `http://localhost:3000`. Demo incidents remain public. Use **Unlock live data** for live diagnostics, probes and case workspaces.

## One-time diagnostic flow

```text
engineer creates diagnostic
    -> user opens one-time link
    -> reviews scope + Connectivity Contract
    -> explicit consent
    -> runs Faultline.exe
    -> endpoint evidence uploads
    -> independent probe adds second vantage
    -> deterministic fault-domain result
```

The browser never receives the endpoint upload credential.

## Cases and evidence packages

A diagnostic session is one measurement. A **case** is the support incident around those measurements.

```text
Support case
  |- diagnostic run 1
  |- diagnostic run 2
  |- engineer notes
  |- evidence timeline
  |- before/after comparison
  `- JSON / print-ready evidence export
```

Evidence is kept in explicit classes: observed, inferred, deterministic, statistical and engineer annotation. Dashboard exports redact local network identifiers by default and JSON packages include a canonical SHA-256 digest as an integrity aid.

See [docs/CASES_AND_EVIDENCE.md](docs/CASES_AND_EVIDENCE.md).

## v0.9 Cross-Party Incident Rooms

An engineer can issue an expiring, single-case `fl_case_...` credential to another organisation.

```text
observer
  -> read redacted shared case/evidence

contributor
  -> read shared evidence
  -> append observation/counter-evidence/question/resolution update
```

Only the credential hash is persisted. Invitations can be revoked independently. The external room receives network-identifier-redacted evidence and cannot access admin routes, probe management or endpoint/probe secrets.

Counter-evidence is appended with participant, organisation and time provenance. It does **not** silently replace the deterministic Faultline diagnosis.

See [docs/CROSS_PARTY_ROOMS.md](docs/CROSS_PARTY_ROOMS.md).

## Connectivity Contracts

Generic built-in profiles currently include `basic-reachability`, `secure-web` and `web-api`. A versioned contract snapshot is stored with each diagnostic and produces structured pass/fail features for support reasoning and Incident Intelligence.

See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

## Incident Intelligence

Faultline uses classical, inspectable Data Science:

```text
telemetry
  -> median imputation
  -> z-score standardisation
  -> binary + one-hot encoding
  -> weighted evidence distance
  -> pairwise similarity
  -> DBSCAN cluster or explicit outlier
```

Similarity is descriptive, not a probability of common root cause. See [docs/INCIDENT_INTELLIGENCE.md](docs/INCIDENT_INTELLIGENCE.md).

## Security model

```text
Admin token              control-plane administration
Invitation token         preview + consent for one endpoint diagnostic
Launcher token           one exchange for endpoint access
Endpoint token           one short-lived evidence uploader
Registered probe token   scoped remote worker identity
Case-room token           one case, observer/contributor role
```

Raw endpoint, probe, invitation, launcher and case-room secrets are not persisted.

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
- cross-party identity is invitation-based rather than federated login
- scheduler has no distributed leases
- probe rate limiting is in-memory
- remote probes do not yet execute full Connectivity Contracts
- packaged Windows client is unsigned and needs broader real-machine testing
- topology remains endpoint inference rather than authoritative physical discovery
- Incident Intelligence uses prototype parameters over a small visible dataset
- evidence digest is not a cryptographic signature or legal chain-of-custody system

## Roadmap

```text
v0.1-v0.7  core diagnostic foundation                  complete previews
Data Science preview  incident similarity + DBSCAN    complete
v0.8       cases + evidence packages                   complete preview
v0.9       cross-party incident rooms                  current
v1.0       hosted multi-tenant MVP                     next
v1.1       Connectivity Contract ecosystem
v1.2       embedded diagnostics API + SDK
v1.3       service desk integrations
v1.4       deeper network/protocol diagnostics
v1.5       network change assurance
v1.6+      deeper intelligence/orchestration/enterprise work
v2.0       cross-boundary network incident platform
```

See [ROADMAP.md](ROADMAP.md) for the full plan.

## License

MIT
