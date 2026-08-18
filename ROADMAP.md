# Faultline roadmap

Faultline is an incident-first, evidence-based network support prototype. It is designed around connectivity problems that cross endpoint, LAN, ISP, VPN, Internet and service ownership boundaries.

The deterministic diagnosis path remains separate from any future statistical or machine-learning analysis.

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

Future topology improvements include vendor enrichment, stronger device classification, zoom/filtering and optional authoritative controller integrations.

## 0.6C - Probe fleet intelligence and safety ✅

- public/private probe scopes
- country/region/tag metadata
- automatic health-aware scheduling
- least-loaded selection
- drain and maintenance states
- credential rotation and revocation
- lifecycle audit events
- public target/port policy
- DNS and redirect revalidation
- mapped/private address protections

Production-scale scheduler leases, distributed limits and tenant-specific policy remain future hardening.

## 0.6D - Packaged Windows client ✅

- standalone `Faultline.exe`
- Windows CI build and executable self-test
- `.faultline` handoff
- automatic credential exchange
- automatic collection/upload
- retry and recovery payload

Production hardening still includes code signing, stable binary distribution and broader Windows/enterprise testing.

---

# v0.7 - Connectivity Contracts ✅ preview

**Goal:** describe which application connectivity conditions are required instead of treating every incident as a single generic target test.

Implemented in the first preview:

- versioned Connectivity Contract schema
- session-level contract snapshots for reproducibility
- validation at the session creation boundary
- generic built-in profiles:
  - `basic-reachability`
  - `secure-web`
  - `web-api`
- target placeholders:
  - `$target.host`
  - `$target.port`
  - `$target.url`
- DNS/TCP/TLS/HTTP condition types
- dashboard contract picker
- CLI `--contract` and `--list-contracts`
- consent-page disclosure of the selected contract and required checks
- Windows-client contract evaluation
- deterministic contract pass/fail summary
- contract result evidence in the fault-domain output
- structured features for later incident analysis:
  - contract ID/version
  - pass rate
  - failed-required count
  - first failing check type

Current limitation: the v0.7 evaluator is deliberately **target-scoped**. Built-in profiles operate on the selected diagnostic target. Verified multi-endpoint vendor profiles and deeper remote-probe contract execution remain later work.

See [docs/CONNECTIVITY_CONTRACTS.md](docs/CONNECTIVITY_CONTRACTS.md).

**Milestone:** Faultline can answer both:

1. where the evidence suggests the fault begins, and
2. which required application connectivity condition failed.

---

# Next portfolio slice - Incident similarity and clustering

**Goal:** demonstrate meaningful Data Science on top of Faultline without replacing deterministic diagnosis.

This is intentionally a contained portfolio feature rather than a production ML platform.

Planned feature vector candidates:

```text
gateway latency/loss
upstream loss
jitter
DNS latency
TCP/HTTP timing
remote-vantage state
fault domain
Connectivity Contract ID/version
contract pass rate
first failing contract condition
VPN state
```

Planned first implementation:

- numerical feature standardisation
- categorical feature encoding where justified
- similarity score between incidents
- unsupervised clustering, likely starting with DBSCAN or hierarchical clustering
- explicit outlier/noise handling
- dashboard panel showing related incidents and common characteristics
- deterministic explanation of which features made cases similar
- synthetic labelled scenarios for repeatable tests/demo data

The model must not output the authoritative fault domain. Its purpose is to answer:

> **Have we seen other incidents with a similar evidence pattern?**

Potential UI:

```text
RELATED INCIDENT PATTERN

4 diagnostics show a similar evidence signature

Common features
- healthy local gateway
- elevated upstream loss
- remote target healthy
- same contract failure stage

Most similar
FL-1032 · 89% similarity
```

---

# Later portfolio/product directions

## Cases and evidence packages

- multiple runs per support case
- before/after comparison
- exportable evidence packages
- read-only sharing
- evidence provenance

## Cross-party troubleshooting

- scoped participant invitations
- evidence contributions from separate organisations
- comments/challenges and requested counter-tests
- immutable case timeline

## Deeper diagnostics

- carefully interpreted ICMP/path evidence
- richer jitter and latency distributions
- IPv4/IPv6 differential testing
- dedicated TLS timing
- HTTP TTFB
- path-MTU testing
- ASN/network-owner enrichment

## Connectivity profile ecosystem

- verified vendor profiles
- private organisation profiles
- profile schema/version tooling
- multi-endpoint contracts
- profile history

## Embedded support diagnostics

- diagnostic creation API/SDK
- embedded "Run connection diagnostic" flow
- support-ticket correlation IDs

## Network change assurance

Run the same Connectivity Contract before and after a firewall, VPN, DNS, proxy or SD-WAN change and show exactly which required behaviours changed.

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

> **When a network-dependent service is failing across an ownership boundary, what does the available evidence show, where does the fault most likely begin, and have we seen a similar evidence pattern elsewhere?**
