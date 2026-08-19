# Faultline roadmap

Faultline is an incident-first, evidence-based network support platform for diagnosing faults that cross ownership boundaries.

The product is deliberately narrower than a traditional monitoring platform. Faultline is built around the difficult support case where the endpoint, local network, VPN, ISP, Internet path and application may be owned by different teams and each party can see only part of the problem.

> **Core question:** when a network-dependent service is failing, where does the evidence show the fault begins, who owns that boundary, and what evidence can be handed to the responsible team?

The deterministic diagnosis path remains separate from statistical or machine-learning analysis.

## Product principles

1. **Incident-first, not monitoring-first.** Faultline should be useful when support encounters a device or network it does not already monitor.
2. **Evidence before blame.** Fault-domain conclusions must be traceable to explicit observations.
3. **Cross-boundary support.** Independent parties should be able to contribute useful evidence without sharing full administrative access.
4. **No false certainty.** Observed facts, inferred topology and statistical similarity must remain distinguishable.
5. **Privacy by default.** Collect only the network metadata required for the diagnostic.
6. **No AI dependency in root-cause reasoning.** The same measurements should produce the same deterministic diagnosis.
7. **Interoperability over lock-in.** Connectivity Contracts, evidence exports and integrations should remain usable across vendors.

---

# Completed foundation: v0.1-v0.7

The early roadmap established the technical foundation required for the next product phase.

| Version | Capability | Status |
|---|---|---|
| v0.1 | Deterministic fault-domain diagnosis | ✅ |
| v0.2 | Real Windows endpoint telemetry | ✅ |
| v0.3 | Endpoint + independent remote-vantage correlation | ✅ |
| v0.4 | Persistent authenticated control plane | ✅ |
| v0.5 | Registered remote-probe fleet | ✅ |
| v0.6 | One-time support workflow, topology, probe safety and packaged Windows client | ✅ preview |
| v0.7 | Versioned Connectivity Contracts | ✅ preview |
| Data Science preview | Incident similarity, DBSCAN clustering and explicit outlier handling | ✅ preview |

The project now has enough infrastructure. From v0.8 onward the roadmap focuses on making Faultline easier to use during real support incidents, easier to integrate into support operations and increasingly credible as a hosted product.

---

# v0.8 - Cases and Evidence Packages

**Goal:** turn isolated diagnostic runs into a complete support case that can be handed to another team.

## Planned capabilities

### Case workspace

- persistent case entity separate from individual diagnostic runs
- case title, customer, affected service, severity and status
- multiple diagnostic runs attached to one case
- engineer notes and timestamps
- case timeline showing evidence as it arrives
- before/after diagnostic comparison
- clear separation between:
  - observed evidence
  - inferred topology
  - deterministic diagnosis
  - statistical similarity

### Evidence packages

- exportable JSON evidence package
- human-readable HTML/PDF-style report output
- diagnostic summary and fault-domain conclusion
- Connectivity Contract results
- endpoint and remote-vantage comparison
- route and topology evidence
- Incident Intelligence pattern information where relevant
- timestamps and evidence provenance
- cryptographic hash/manifest for exported evidence

### Sharing and redaction

- expiring read-only case links
- explicit evidence selection before sharing
- redaction of local identifiers where appropriate
- no administrative access required for a recipient

## Exit criteria

An engineer can investigate a fault, attach several diagnostic runs to one case and produce a clean evidence package suitable for an **ISP, SaaS provider, MSP or internal escalation team**.

---

# v0.9 - Cross-Party Incident Rooms

**Goal:** allow separate organisations to contribute scoped evidence to the same support case.

## Planned capabilities

### Participants

- customer IT participant
- MSP/service-desk participant
- ISP/network-provider participant
- SaaS/application-provider participant
- Faultline independent-probe evidence

### Scoped collaboration

- one-time participant invitations
- read-only, contributor and case-owner permissions
- participant-specific evidence visibility
- no requirement to expose full network administration
- comments attached directly to evidence items
- requested counter-tests
- participant acknowledgements/challenges

### Evidence provenance

Every contribution records:

```text
who supplied it
which vantage generated it
when it was measured
which test produced it
whether it is observed or inferred
```

### Deterministic re-evaluation

When a new vantage contributes evidence, Faultline re-runs deterministic correlation and records how the conclusion changed.

## Exit criteria

A customer, MSP and external provider can work from the **same incident record** while exposing only the evidence each party has explicitly chosen to contribute.

---

# v1.0 - Hosted Commercial MVP

**Goal:** move Faultline from a strong prototype to a pilotable hosted product.

## Control plane

- PostgreSQL-backed persistence
- organisations and workspaces
- named users
- role-based access control
- tenant isolation
- production authentication
- secure secrets/credential lifecycle
- retention controls
- organisation quotas
- usage metering

## Reliable execution

- durable probe job queue
- worker claims/leases rather than single-process polling assumptions
- retry/dead-letter handling
- multiple control-plane instances
- distributed rate limits
- health and operational metrics

## Endpoint distribution

- Authenticode-signed Windows client
- stable download/release channel
- client version reporting
- controlled update mechanism
- Windows 10/11 validation
- locked-down enterprise endpoint testing

## Hosted probe network

Initial managed public vantage locations, for example:

```text
UK
Western Europe
North America
```

Customer-owned private probes remain supported.

## Commercial readiness

- plan/usage limits
- basic administrative billing/entitlement model
- onboarding workflow
- privacy/retention settings
- operational runbooks
- backup and restore process

## Exit criteria

Faultline can support a **small number of real pilot organisations** without relying on development-only deployment assumptions.

---

# v1.1 - Connectivity Contract Ecosystem

**Goal:** evolve Connectivity Contracts from generic target checks into a reusable application-connectivity standard.

## Profile registry

- versioned public contract registry
- private organisation contracts
- contract validation CLI/tooling
- schema migration/version compatibility
- reusable test fixtures
- contract history and changelog

## Richer condition types

Potential additions:

- multiple service endpoints
- WebSocket connectivity
- TLS/SNI requirements
- UDP service requirements where measurable safely
- resolver-specific DNS conditions
- HTTP header/redirect expectations
- proxy-required or proxy-forbidden paths

## Verified vendor profiles

Add profiles only where requirements can be verified against authoritative vendor documentation.

Potential candidates:

- Microsoft 365 / Teams
- Cisco Webex
- Slack
- selected SaaS applications commonly seen in support environments

Faultline should not guess vendor requirements or allow stale profiles to silently become authoritative.

## Exit criteria

An engineer can select an application profile and Faultline can test the **actual set of network conditions that application requires**, not merely one hostname.

---

# v1.2 - Embedded Diagnostics API and SDK

**Goal:** let existing support products launch Faultline without requiring an engineer to open the Faultline dashboard first.

## API

- create diagnostic session
- create one-time invitation
- select Connectivity Contract
- select probe policy
- query case/run status
- retrieve structured evidence
- receive completion events

## SDK/widget

Initial developer tooling:

- TypeScript/JavaScript SDK
- embeddable **Run network diagnostic** component
- support-ticket correlation IDs
- configurable consent text
- branded or white-label diagnostic entry point where appropriate

## Events

- diagnostic started
- endpoint completed
- remote vantage completed
- diagnosis changed
- evidence package ready

## Exit criteria

A support portal can start a Faultline diagnostic and consume the result **without requiring the engineer to manually recreate the case in Faultline**.

---

# v1.3 - Service Desk and Support Integrations

**Goal:** make Faultline part of the support workflow rather than a separate destination.

## Initial integration targets

Prioritise a small number rather than implementing shallow connectors everywhere.

Candidates:

- ServiceNow
- Jira Service Management
- Zendesk
- HaloPSA
- Freshservice
- ConnectWise

## Integration workflow

```text
Support ticket
     |
     v
Launch Faultline diagnostic
     |
     v
User completes diagnostic
     |
     v
Faultline case + evidence generated
     |
     v
Evidence summary/link attached to original ticket
```

## Planned capabilities

- ticket/case correlation
- launch diagnostic from ticket
- attach evidence-package link
- post fault-domain summary
- update ticket when new evidence changes the conclusion
- preserve Faultline provenance rather than copying raw telemetry blindly

## Exit criteria

An engineer can remain primarily inside their normal service-desk platform while Faultline handles the diagnostic workflow behind it.

---

# v1.4 - Deeper Network and Protocol Diagnostics

**Goal:** improve Faultline's ability to distinguish failures that generic reachability cannot explain.

## Planned diagnostic depth

### Dual-stack comparison

- IPv4 versus IPv6 reachability
- DNS A versus AAAA behaviour
- route differences
- application success/failure by address family

### TLS

- dedicated TLS handshake timing
- certificate-chain result
- SNI behaviour
- protocol/version outcome

### HTTP/application edge

- DNS timing
- TCP timing
- TLS timing
- time to first byte
- redirect chain
- status result

### Path behaviour

- path-MTU / fragmentation diagnostics where safe
- richer repeated route evidence
- latency/loss distributions rather than one aggregate
- careful traceroute interpretation

### Network ownership enrichment

- public ASN
- provider/network-owner metadata
- clear distinction between IP ownership and proven fault ownership

## Exit criteria

Faultline can identify **which stage of a modern application connection fails** and compare that evidence between independent vantage points.

---

# v1.5 - Network Change Assurance

**Goal:** show whether a network change actually altered the behaviour an application depends on.

## Workflow

```text
Baseline diagnostic
      |
      v
Network / firewall / VPN / DNS / SD-WAN change
      |
      v
Repeat same Connectivity Contract
      |
      v
Structured before/after comparison
```

## Planned capabilities

- named change window
- pre-change baseline
- post-change validation
- automatic comparison of contract checks
- route/path change summary
- latency/loss comparison
- topology difference where available
- regression detection
- exportable change-evidence package

## Example use cases

- firewall rule migration
- VPN split-tunnel change
- DNS resolver migration
- SD-WAN policy change
- proxy change
- ISP circuit migration
- SaaS allow-list update

## Exit criteria

An engineer can state **exactly which required network behaviours changed after a configuration change**, backed by repeatable evidence.

---

# v1.6 - Incident Intelligence v2

**Goal:** move from a small demonstration cluster model to useful historical incident-pattern analysis.

The deterministic fault-domain engine remains authoritative. Incident Intelligence remains a secondary analytical layer.

## Planned improvements

### Historical feature store

- analyse completed cases over time
- consistent feature-schema versions
- per-contract condition vectors
- provider/ASN features where available
- geographic/region features where appropriate
- time-window features

### Model evaluation

- compare DBSCAN with hierarchical clustering
- cluster cohesion metrics
- stability analysis across parameter changes
- explicit model/version metadata
- drift monitoring

### Emerging incident detection

Identify situations such as:

```text
12 unrelated customers
same provider/region
same contract failure stage
same 30-minute window
```

without automatically declaring a shared root cause.

### Engineer-confirmed outcomes

Confirmed resolutions may be stored for **evaluation and retrieval**, but should not silently become the root-cause decision mechanism.

## Exit criteria

Faultline can surface **recurring and emerging evidence patterns across historical support cases** while clearly separating statistical association from diagnosis.

---

# v1.7 - Multi-Vantage Orchestration

**Goal:** move beyond one endpoint plus one remote probe and reason across several independent network viewpoints.

## Planned capabilities

- multiple simultaneous public probes
- region-aware vantage selection
- customer-owned private probes
- organisation/provider-side probes
- capability-aware scheduling
- quorum/consensus view
- path-asymmetry awareness
- per-vantage Connectivity Contract execution
- evidence comparison matrix

Example:

```text
Affected endpoint        FAIL
Customer office probe    FAIL
London public probe      PASS
Frankfurt public probe   PASS
Service-side probe       PASS
```

Faultline should use that evidence to narrow the boundary without pretending every vantage follows an identical network path.

## Exit criteria

Faultline can distinguish **endpoint-local, site-wide, provider/regional and globally visible incidents** using several independent measurements.

---

# v1.8 - Authoritative Topology and Ownership Boundaries

**Goal:** combine endpoint inference with trusted infrastructure data where the customer explicitly provides it.

## Controller integrations

Potential integrations, where supported APIs exist:

- UniFi
- TP-Link Omada
- OpenWrt
- pfSense / OPNsense
- selected enterprise network controllers

## Authoritative evidence

Potential sources:

- controller topology
- LLDP/CDP-derived relationships where authorised
- VLAN/subnet context
- gateway/controller identity
- WAN/interface ownership

Faultline should merge this data with endpoint inference while marking the source of every relationship.

## Ownership/demarcation overlay

Network Map evolves from:

```text
Endpoint -> AP -> Gateway -> Internet
```

into something closer to:

```text
Customer endpoint
      |
Customer LAN
      |
Customer firewall
------ demarcation ------
ISP access
      |
Transit/provider
------ service edge -----
Application
```

## Exit criteria

A support case can show not only **where degradation appears**, but which administrative or commercial boundary that segment belongs to.

---

# v1.9 - Enterprise Readiness

**Goal:** harden Faultline for larger organisations and security-conscious deployments.

## Identity and access

- OIDC/SAML SSO
- SCIM provisioning where justified
- granular RBAC
- organisation/project boundaries
- service accounts/API credentials

## Security and governance

- comprehensive audit trail
- audit export
- configurable retention
- encrypted secrets with managed key support
- signed client releases
- SBOM generation
- dependency/build provenance
- security headers and hardened deployment defaults

## Reliability

- high-availability control plane
- database backup/restore validation
- queue resilience
- probe fleet health objectives
- operational alerting
- disaster-recovery procedures

## Deployment options

- hosted SaaS
- customer-controlled private probes
- evaluate private/self-hosted control-plane option for customers with strict data requirements

## Exit criteria

Faultline is technically credible for an **enterprise pilot/security review**, with the remaining gap primarily commercial scale and certification rather than prototype architecture.

---

# v2.0 - Cross-Boundary Network Incident Platform

**Goal:** complete the transition from diagnostic tool to a multi-party network incident and fault-arbitration platform.

v2.0 brings the earlier work together around one shared object: the **network incident case**.

## Core platform

A case can include:

```text
Affected endpoints
Customer/site probes
Managed public probes
ISP/provider evidence
Application/service evidence
Connectivity Contracts
Topology + ownership boundaries
Historical related incidents
Change history
Participant discussion
Evidence packages
```

## Cross-organisation fault isolation

Faultline should be able to express conclusions such as:

> Three affected endpoints and the customer's site probe show loss beginning beyond the managed firewall. Independent Faultline probes and the SaaS-side service check remain healthy. The evidence supports escalation to the access/provider path rather than the application service.

The important property is not just the conclusion. Every part of that statement must remain traceable to evidence from a known vantage.

## Platform capabilities

- multi-organisation incident rooms
- evidence provenance and chain of custody
- ownership/demarcation model
- multi-vantage correlation
- application Connectivity Contracts
- regional and historical incident intelligence
- support-system integrations
- API/SDK ecosystem
- before/after change assurance
- signed shareable evidence packages
- enterprise identity, audit and retention controls

## Product position

Faultline should not attempt to replace:

- traditional NMS/SNMP monitoring
- SIEM platforms
- packet-capture systems
- full APM suites
- Internet observability platforms designed primarily for continuous monitoring

The differentiator remains the support workflow between organisations:

> **Collect scoped evidence from independent sides of a network problem, determine which fault boundary the combined evidence supports, and give the parties a neutral case record they can act on.**

## v2.0 exit criteria

A real incident can move through the complete lifecycle:

```text
User reports failure
        |
        v
Support opens Faultline case
        |
        v
Affected endpoint diagnostic
        |
        +--> customer/private vantage
        +--> independent public vantages
        +--> application contract checks
        |
        v
Fault boundary isolated
        |
        v
Responsible external/internal party invited
        |
        v
Counter-evidence contributed
        |
        v
Conclusion re-evaluated
        |
        v
Evidence package attached to escalation
        |
        v
Resolution recorded
        |
        v
Historical pattern becomes available to future cases
```

At this point Faultline is no longer simply a network diagnostic utility. It is a **cross-boundary incident evidence platform**.

---

# Roadmap at a glance

| Version | Main outcome |
|---|---|
| **v0.8** | Cases, multiple runs and exportable evidence packages |
| **v0.9** | Cross-party incident rooms and evidence contributions |
| **v1.0** | Hosted, multi-tenant commercial MVP for pilot customers |
| **v1.1** | Reusable Connectivity Contract ecosystem and verified service profiles |
| **v1.2** | Embedded diagnostics API, SDK and support widget |
| **v1.3** | Service desk/ticketing integrations |
| **v1.4** | Deeper IPv4/IPv6, TLS, HTTP, MTU and ownership diagnostics |
| **v1.5** | Before/after network change assurance |
| **v1.6** | Historical Incident Intelligence and emerging-pattern detection |
| **v1.7** | Multi-vantage regional/private/provider correlation |
| **v1.8** | Authoritative topology and ownership/demarcation boundaries |
| **v1.9** | Enterprise identity, governance, reliability and security hardening |
| **v2.0** | Full cross-boundary network incident and evidence platform |

---

## What Faultline should not become

Faultline should remain disciplined about scope. It should not drift into being:

- a generic SNMP/NMS platform
- a SIEM
- a packet-capture warehouse
- a full APM suite
- a generic chatbot
- an LLM root-cause engine
- a clone of ThousandEyes, Catchpoint or Obkio

The long-term question remains:

> **When a network-dependent service is failing across an ownership boundary, what does the evidence show, where does the fault most likely begin, who owns that boundary, and what should happen next?**
