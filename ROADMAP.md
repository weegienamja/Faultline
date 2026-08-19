# Faultline roadmap

Faultline is an incident-first, evidence-based network support platform for diagnosing faults that cross ownership boundaries.

> **Core question:** when a network-dependent service is failing, where does the evidence show the fault begins, who owns that boundary, and what evidence can be handed to the responsible team?

The deterministic diagnosis path remains separate from statistical/ML analysis. Observed measurements, inferred topology, deterministic conclusions and statistical similarity remain distinct evidence classes.

## Product principles

1. Incident-first, not monitoring-first.
2. Evidence before blame.
3. Cross-boundary support without requiring shared administration.
4. No false certainty about topology, ownership or causation.
5. Privacy by default.
6. No AI/LLM dependency in root-cause reasoning.
7. Interoperability over vendor lock-in.

---

# Completed foundation

| Version | Main capability | Status |
|---|---|---|
| v0.1 | Deterministic fault-domain diagnosis | ✅ |
| v0.2 | Windows endpoint telemetry | ✅ |
| v0.3 | Endpoint + remote-vantage correlation | ✅ |
| v0.4 | Persistent authenticated control plane | ✅ |
| v0.5 | Registered probe fleet | ✅ |
| v0.6 | Ephemeral support workflow, topology, fleet safety, packaged Windows client | ✅ preview |
| v0.7 | Versioned Connectivity Contracts | ✅ preview |
| Data Science | Similarity scoring, DBSCAN clustering, explicit outliers | ✅ preview |
| v0.8 | Cases, multiple runs, evidence provenance and export packages | ✅ preview |
| v0.9 | Cross-party incident rooms and scoped evidence contribution | ✅ preview |
| v1.0 | Organisation/project tenancy and isolated case architecture | ✅ preview |
| v1.1 | Project Connectivity Contract catalog and immutable published versions | ✅ preview |
| v1.2 | Embedded diagnostics API, JavaScript SDK and launch widget | ✅ preview |
| v1.3 | Service-desk correlation and provenance-preserving update envelopes | ✅ preview |
| v1.4 | Dual-stack, TLS, HTTP-stage and path-MTU diagnostics | ✅ preview |
| v1.5 | Network Change Assurance | ✅ preview |
| Live data | Real local measurement, public Internet intelligence and bring-your-own-network | ✅ preview |

---

# v1.5 - Network Change Assurance ✅ preview

**Goal:** state exactly which measured application/network behaviours changed after a planned configuration change.

Implemented:

- named change windows stored with a support case;
- explicit pre-change baseline session;
- explicit post-change session;
- Connectivity Contract check-state comparison;
- IPv4, IPv6, TLS and contract pass/fail state transitions;
- gateway/upstream loss and latency deltas;
- DNS/TCP/HTTP/TLS/TTFB timing deltas;
- path-MTU comparison where v1.4 evidence exists;
- route-sequence difference detection;
- inferred topology signature comparison;
- deterministic regression/improvement lists;
- SHA-256 integrity-tagged change-assurance evidence package;
- audit events for change creation, baseline selection and comparison;
- SDK methods for the complete workflow.

Workflow:

```text
Named change window
      |
Pre-change diagnostic -> select baseline
      |
Perform network change
      |
Post-change diagnostic -> select validation run
      |
Compare contract + protocol + path evidence
      |
Regression / no-regression result
      |
Assurance package
```

Current limitation: a regression is an evidence difference, not proof that the change caused it.

See [docs/CHANGE_ASSURANCE.md](docs/CHANGE_ASSURANCE.md).

---

# Live Internet data and bring-your-own-network ✅ preview

**Goal:** let Faultline demonstrate its reasoning against real networks rather than
only synthetic demo scenarios, without adding an AI dependency or a paid API.

## Delivered

- real local measurement: DNS across the system resolver plus three public resolvers
  with agreement detection, TCP, TLS (version/cipher/certificate/chain), HTTP
  status/TTFB/redirect chain, ICMP latency/jitter/loss, traceroute, and
  adapter/Wi-Fi/VPN/route/DNS-server state
- explicit `unknown` / `not-measured` / `unsupported` states instead of invented values
- public Internet context from RIPEstat, Globalping, RIPE Atlas, IODA and PeeringDB,
  all credential-free; Cloudflare Radar optional behind a token
- Network Map extended past the local gateway with traceroute-proven public segments,
  labelled OBSERVED versus PUBLIC ROUTING METADATA
- Network Manifest import with preview, and enforcement that private targets require
  an authorised private probe
- privacy boundary: only globally routable addresses ever leave the control plane

## Boundary

Only observed measurements reach the deterministic engine. Globalping is wired to the
existing independent-vantage input because it is a genuine measurement; RIPEstat,
IODA, PeeringDB, RIPE Atlas and Cloudflare Radar are context and can never move a
fault domain.

---

# v1.6 - Incident Intelligence v2

**Goal:** evolve the current small visible-set clustering demo into historical incident-pattern analysis.

Planned:

- historical feature store with schema versions;
- per-contract condition vectors;
- provider/ASN and geographic features where reliable;
- time-window features;
- comparison of DBSCAN and hierarchical clustering;
- cohesion/stability/drift evaluation;
- emerging-pattern detection across unrelated cases;
- engineer-confirmed resolutions for evaluation/retrieval only, never silent replacement of deterministic diagnosis.

**Exit:** Faultline can surface recurring and emerging evidence patterns across historical cases while clearly separating association from root cause.

---

# v1.7 - Multi-Vantage Orchestration

**Goal:** reason across more than one endpoint plus one remote probe.

Planned:

- several simultaneous public probes;
- region/capability-aware scheduling;
- customer/private and provider-side probes;
- per-vantage Connectivity Contract execution;
- evidence comparison matrix;
- path-asymmetry awareness;
- cautious quorum/consensus summaries.

Example:

```text
Affected endpoint       FAIL
Customer site probe     FAIL
London public probe     PASS
Frankfurt public probe  PASS
Service-side probe      PASS
```

**Exit:** distinguish endpoint-local, site-wide, provider/regional and globally visible failures using independent measurements.

---

# v1.8 - Authoritative Topology and Ownership Boundaries

**Goal:** combine endpoint inference with trusted infrastructure data supplied by the customer.

Potential integrations:

- UniFi;
- TP-Link Omada;
- OpenWrt;
- pfSense / OPNsense;
- selected enterprise controllers.

Planned evidence sources:

- controller topology;
- LLDP/CDP-derived relationships where authorised;
- VLAN/subnet context;
- WAN/gateway identity;
- administrative ownership and demarcation metadata.

Network Map should be able to show boundaries such as:

```text
Customer endpoint
      |
Customer LAN
      |
Customer firewall
------ demarcation ------
ISP/access provider
      |
Transit
------ service edge -----
Application
```

**Exit:** show both where degradation appears and which administrative/commercial boundary that segment belongs to.

---

# v1.9 - Enterprise Readiness

**Goal:** make the architecture credible for larger organisations and formal security review.

Planned:

- OIDC/SAML SSO;
- granular RBAC and service accounts;
- SCIM where justified;
- comprehensive audit export and retention controls;
- managed secret encryption;
- signed client releases;
- SBOM/build provenance;
- hardened deployment defaults;
- HA control plane and resilient queues;
- backup/restore and DR validation;
- hosted/private deployment evaluation.

**Exit:** credible enterprise pilot/security-review posture rather than development-only deployment assumptions.

---

# v2.0 - Cross-Boundary Network Incident Platform

**Goal:** bring the entire project together around the shared network incident case.

A v2 case can combine:

```text
Affected endpoints
Customer/private probes
Managed public probes
Provider/service evidence
Connectivity Contracts
Topology + ownership boundaries
Historical related incidents
Network change history
Participant discussion
Evidence packages
```

Core capabilities:

- multi-organisation incident rooms;
- evidence provenance/chain of custody;
- ownership/demarcation model;
- multi-vantage correlation;
- application Connectivity Contracts;
- regional/historical Incident Intelligence;
- support-system integrations;
- API/SDK ecosystem;
- network change assurance;
- shareable integrity-tagged evidence packages;
- enterprise identity/audit/retention controls.

The differentiator remains:

> **Collect scoped evidence from independent sides of a network problem, determine which fault boundary the combined evidence supports, and give the parties a neutral case record they can act on.**

## v2.0 exit flow

```text
User reports failure
        |
Support opens case
        |
Affected endpoint + independent vantages + contract checks
        |
Fault boundary isolated
        |
Responsible party invited
        |
Counter-evidence contributed
        |
Conclusion re-evaluated
        |
Evidence package attached to escalation
        |
Resolution recorded
        |
Pattern becomes available to future cases
```

---

# Roadmap at a glance

| Version | Outcome |
|---|---|
| **v0.8** | Cases + evidence packages ✅ |
| **v0.9** | Cross-party incident rooms ✅ |
| **v1.0** | Multi-tenant hosted architecture preview ✅ |
| **v1.1** | Connectivity Contract ecosystem ✅ |
| **v1.2** | Embedded API + SDK ✅ |
| **v1.3** | Service-desk integration layer ✅ |
| **v1.4** | Deeper protocol diagnostics ✅ |
| **v1.5** | Network Change Assurance ✅ |
| **v1.6** | Historical/emerging Incident Intelligence |
| **v1.7** | Multi-vantage orchestration |
| **v1.8** | Authoritative topology + ownership boundaries |
| **v1.9** | Enterprise readiness |
| **v2.0** | Full cross-boundary incident evidence platform |

## What Faultline should not become

- generic SNMP/NMS;
- SIEM;
- packet-capture warehouse;
- full APM suite;
- generic chatbot;
- LLM root-cause engine;
- clone of continuous-observability platforms.

The project stays centred on one support question: **what does the evidence show, where does the fault most likely begin, who owns that boundary, and what should happen next?**
