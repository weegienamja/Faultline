# Faultline roadmap

Faultline is an incident-first, evidence-based network support prototype. It is designed around connectivity problems that cross endpoint, LAN, ISP, VPN, Internet and service ownership boundaries.

The deterministic diagnosis path remains separate from statistical or machine-learning analysis.

## Product principles

1. **Incident-first, not monitoring-first.** Faultline should be useful when support encounters a device or network it does not already monitor.
2. **Evidence before blame.** Fault-domain conclusions must be traceable to explicit observations.
3. **Cross-boundary support.** Independent parties should be able to contribute useful evidence without sharing full administrative access.
4. **No false certainty.** Observed facts, inferred topology and statistical similarity must remain distinguishable.
5. **Privacy by default.** Collect only the network metadata required for the diagnostic.
6. **No AI dependency in root-cause reasoning.** The same measurements should produce the same deterministic diagnosis.

---

## v0.1 - Diagnosis prototype ✅

Deterministic fault-domain rules, evidence, confidence, action guidance and demo incidents.

## v0.2 - Real endpoint telemetry ✅

Windows gateway, DNS, Wi-Fi, VPN, route, TCP/HTTP, loss/jitter and traceroute collection.

## v0.3 - Two-vantage correlation ✅

Independent remote probe plus endpoint correlation.

## v0.4 - Persistent authenticated control plane ✅

Persistent sessions, role-scoped credentials, expiry, admin-protected live data and Docker deployment.

## v0.5 - Registered probe fleet ✅

Durable probe identities, heartbeat health, private job queues and fleet UI.

---

# v0.6 - Real support workflow ✅ preview

The core support workflow is feature-complete as a prototype.

## 0.6A - Ephemeral support diagnostics ✅

- one-time invitation links
- explicit consent
- session expiry
- topology opt-out
- one-use launcher credential

## 0.6B - Interactive inferred topology ✅

- passive Windows neighbour discovery
- endpoint/gateway/Wi-Fi evidence
- star/tree/low-confidence mesh/unknown inference
- observed versus inferred links
- draggable Network Map

## 0.6C - Probe fleet intelligence and safety ✅

- public/private probe scopes
- country/region/tag scheduling metadata
- automatic health-aware and least-loaded selection
- drain and maintenance states
- credential rotation and revocation
- lifecycle audit events
- public target/port policy
- DNS and redirect revalidation
- mapped/private address protections

## 0.6D - Packaged Windows client ✅

- standalone `Faultline.exe`
- Windows CI build and executable self-test
- `.faultline` handoff
- automatic credential exchange
- automatic collection/upload
- retry and recovery payload

Production hardening still includes signing, stable distribution, distributed scheduling/limits and broader Windows testing.

---

# v0.7 - Connectivity Contracts ✅ preview

**Goal:** describe which application connectivity conditions are required instead of treating every incident as a single generic target test.

Implemented:

- versioned Connectivity Contract schema
- session-level snapshots for reproducibility
- validation at session creation
- generic `basic-reachability`, `secure-web` and `web-api` profiles
- `$target.host`, `$target.port` and `$target.url` placeholders
- DNS/TCP/TLS/HTTP conditions
- dashboard and CLI profile selection
- consent-page contract disclosure
- Windows-client contract evaluation
- deterministic pass/fail evidence
- structured pass-rate/failure-stage features

Current limitation: the first evaluator is target-scoped. Verified multi-endpoint vendor profiles and remote-probe contract execution remain later work.

See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

---

# Incident Intelligence - Data Science preview ✅

**Goal:** identify related support incidents from measured evidence without allowing ML to replace deterministic fault isolation.

Implemented:

- numerical feature median imputation
- z-score standardisation with bounded values
- explicit binary network-state encoding
- one-hot Connectivity Contract categorical evidence
- weighted mixed-feature distance
- pairwise incident similarity scores
- deterministic similarity explanations
- DBSCAN unsupervised clustering
- explicit DBSCAN noise/outlier handling
- dashboard Related evidence patterns panel
- demo-only analysis while locked
- authorised live+demo analysis after admin unlock
- repeatable three-case upstream-degradation demo cluster
- unrelated DNS, VPN and local-network demo outliers
- automated tests for feature space, cluster membership, similarity ordering and noise behaviour

A key methodological constraint is enforced in the dashboard model:

> **Fault-domain labels are removed before fitting the cluster model.**

The model therefore groups incidents using network evidence and Connectivity Contract outcomes rather than using the answer produced by the deterministic diagnosis engine as an input feature.

Current preview features include:

```text
gateway latency/loss
upstream loss
jitter
DNS latency
TCP/HTTP timing
endpoint/Internet/remote reachability states
VPN state
Connectivity Contract ID
contract pass rate
failed-required count
first failing contract condition
```

Current DBSCAN defaults:

```text
epsilon = 0.34
minPts  = 3
```

These are prototype parameters for a small visible evidence set, not universal network thresholds.

The model's purpose remains:

> **Have we seen other incidents with a similar evidence pattern?**

Similarity is descriptive and does not prove a shared root cause.

See [docs/INCIDENT_INTELLIGENCE.md](docs/INCIDENT_INTELLIGENCE.md).

---

# Next high-value portfolio work

The core technical story is now broad enough that future work should improve demonstration quality rather than continuously expand infrastructure.

## Cases and evidence packages

Potential next slice:

- group multiple diagnostic runs into one support case
- before/after comparison
- incident timeline
- exportable JSON/PDF evidence package
- clear observed vs inferred vs statistical evidence sections
- read-only sharing model

This would make the cross-organisation support gap especially easy to demonstrate because Faultline could produce an artefact suitable for handing to an ISP, SaaS provider or another support team.

## Data Science evaluation extensions

Useful follow-up analysis:

- compare DBSCAN with hierarchical clustering
- evaluate cluster cohesion/stability
- time-window features for emerging incident patterns
- ASN/provider and geography after reliable enrichment exists
- per-contract check-state vectors
- engineer-confirmed outcomes for evaluation only

## Deeper diagnostics

- IPv4/IPv6 differential testing
- dedicated TLS timing
- HTTP TTFB
- path-MTU testing
- richer path evidence
- ASN/network-owner enrichment

## Connectivity profile ecosystem

- verified vendor profiles
- private organisation profiles
- multi-endpoint contracts
- profile version/history tooling

## Network change assurance

Run the same Connectivity Contract before and after a firewall, VPN, DNS, proxy or SD-WAN change and show which required behaviours changed.

---

## What Faultline should not become

The project deliberately avoids becoming:

- a generic SNMP/NMS platform
- a SIEM
- a packet-capture warehouse
- a full APM suite
- a generic chatbot
- an LLM root-cause engine
- a clone of ThousandEyes/Catchpoint/Obkio

Faultline stays centred on the narrower support question:

> **When a network-dependent service is failing across an ownership boundary, what does the evidence show, where does the fault most likely begin, and have we seen a similar evidence pattern elsewhere?**
