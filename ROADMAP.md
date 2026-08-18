# Faultline roadmap

Faultline is being developed as an evidence-based network support platform rather than a generic monitoring product. The core direction is to make difficult connectivity incidents easier to diagnose, explain and hand off when the fault may sit across endpoint, LAN, ISP, transit, VPN or SaaS boundaries.

The diagnostic path remains deterministic and does not depend on an AI or LLM API.

## Roadmap principles

1. **Incident-first, not monitoring-first.** Faultline should be useful when a support engineer encounters a device or network they do not already manage.
2. **Evidence before blame.** Fault-domain conclusions must be backed by explicit observations from known vantage points.
3. **Cross-boundary support.** The product should make it easier for customers, MSPs, ISPs and SaaS vendors to contribute or consume evidence without sharing full administrative access.
4. **No false certainty.** Inferred topology, traceroute ownership and diagnosis confidence must distinguish observed facts from heuristics.
5. **Privacy by default.** Collect the minimum network metadata needed to diagnose the issue and make redaction possible before wider sharing.
6. **No AI dependency in the diagnosis path.** The same measurements should produce the same result.

---

## v0.1 - Diagnosis prototype ✅

**Goal:** prove that structured network evidence can be converted into an explainable fault domain.

Implemented:

- deterministic diagnosis engine
- explicit evidence rules
- fault domains for local network, DNS, VPN/routing, ISP/upstream, endpoint path/policy and target service
- confidence and recommended actions
- demo incident dashboard

**Milestone:** Faultline can explain *why* it believes a fault sits in a particular domain.

---

## v0.2 - Real endpoint telemetry ✅

**Goal:** replace demo-only metrics with observations from a real Windows endpoint.

Implemented:

- Windows endpoint collector
- gateway latency and packet loss
- DNS resolution and timing
- Wi-Fi signal when available
- VPN adapter discovery
- expected-route validation
- TCP and HTTP reachability
- loss and jitter measurements
- bounded traceroute observations

**Milestone:** Faultline can diagnose evidence collected from an actual affected machine.

---

## v0.3 - Two-vantage correlation ✅

**Goal:** compare the affected endpoint with an independent network vantage.

Implemented:

- portable remote probe
- endpoint + remote correlation
- explicit endpoint-only and two-vantage states
- endpoint-path/policy diagnosis when endpoint access fails but an independent probe succeeds

**Milestone:** Faultline can distinguish some endpoint/path problems from target-service problems using independent evidence.

---

## v0.4 - Persistent authenticated control plane ✅

**Goal:** make diagnostics durable and safe enough to host as a controlled prototype.

Implemented:

- persistent diagnostic sessions
- short-lived endpoint and one-off probe credentials
- role-scoped bearer authentication
- credential hashes at rest
- session expiry
- admin-protected live data
- Docker deployment
- persistent incident storage

**Milestone:** diagnostic sessions survive restarts and can be used across separate machines without exposing an unauthenticated ingestion API.

---

## v0.5 - Registered probe fleet ✅

**Goal:** replace anonymous one-shot remote probes with persistent managed vantage points.

Implemented:

- durable `PRB-...` identities
- hashed long-lived probe credentials
- authenticated heartbeats
- online / stale / offline / disabled health
- per-probe private job queues
- assigned diagnostic sessions
- long-running probe worker
- probe-fleet dashboard
- persisted probe registry

**Milestone:** a remote VPS can remain online as a known Faultline vantage and automatically pick up diagnostics assigned to it.

---

# v0.6 - Ephemeral diagnostics, topology and fleet safety

**Goal:** make Faultline dramatically easier to use during a real support ticket while giving engineers a visual understanding of the affected local network.

v0.6 should be the point where Faultline stops feeling like a collection of diagnostic commands and starts feeling like a support product.

## 0.6A - Ephemeral support diagnostics

A support engineer should be able to create a case and send a one-time link or code to a user whose machine is not already managed by Faultline.

Target workflow:

```text
Support ticket
     |
     v
Create diagnostic
     |
     v
One-time link / code
     |
     v
Affected user runs lightweight collector
     |
     v
Endpoint evidence + remote probe
     |
     v
Faultline diagnosis
```

Planned work:

- one-time diagnostic invitation links/codes
- clear consent screen describing exactly what will be collected
- short-lived endpoint enrolment
- automatic session association
- minimal install/run workflow
- expiry after the support case or configured TTL
- optional preview of evidence before upload

## 0.6B - Interactive inferred network topology

Faultline should build a best-effort local network map from endpoint evidence and present it as an interactive floating topology.

Example:

```text
                         Internet
                            |
                        ISP Router
                      /      |      \
                     /       |       \
              Work Laptop  Mesh A   Printer
                              |
                           Mesh B
                          /      \
                    Smart TV    Phone
```

The topology is a **diagnostic aid**, not decorative UI.

### Discovery inputs

Initial topology discovery should use safe local observations such as:

- endpoint IP and subnet
- default gateway
- ARP / neighbour table
- active interface and connection type
- Wi-Fi SSID/BSSID and signal
- reachable local devices where explicitly permitted
- reverse DNS / mDNS hints where available
- MAC OUI/vendor identification
- conservative service/port fingerprints
- known router, AP and mesh vendor patterns

### Device classification

Nodes should use small visual device types such as:

- Windows PC / laptop
- phone / tablet
- router / gateway
- firewall
- Ethernet switch
- wireless access point
- mesh node / extender
- printer
- NAS / server
- smart TV / media device
- games console
- unknown device
- Internet / ISP boundary

Every classification should carry a confidence level rather than pretending heuristic identification is certain.

Example:

```text
Bedroom Deco
Type: Mesh node
Confidence: Medium
Reason: TP-Link OUI + same LAN + matching mesh vendor pattern
```

### Topology inference

Faultline should attempt to classify the local topology as one of:

- star
- mesh
- tree / hierarchical
- mixed
- unknown

Relationships should be labelled by evidence quality:

```text
solid edge    observed / high confidence
dashed edge   likely wireless or inferred parent
dotted edge   weak heuristic relationship
```

If the endpoint cannot prove that two devices are directly connected, the UI must say so.

### Interactive graph

The Network Map should support:

- force-directed floating layout
- drag/reposition nodes
- zoom and pan
- device icons
- click/tap device details
- health status overlays
- highlight the affected endpoint
- highlight the path relevant to the current diagnosis
- filter unknown or low-confidence devices
- switch between simplified and engineer detail views

### Diagnostic overlays

The network map becomes substantially more useful when diagnosis is rendered directly on the topology.

Example local fault:

```text
Laptop ---- Mesh Node ---- Router ---- ISP
  red         amber         green      green
```

Example upstream fault:

```text
Laptop ---- Router ---- ISP ---- Transit ---- Service
 green       green       red       red        green
```

The topology should expose measurements such as Wi-Fi signal, gateway latency, packet loss and route observations where relevant.

### Mesh detection

Initial mesh detection should be heuristic and confidence-labelled. Later router/controller integrations can make it authoritative.

Potential later integrations include:

- UniFi
- TP-Link Omada / Deco where APIs permit
- OpenWrt
- pfSense / OPNsense
- supported ASUS / mesh platforms

Controller integrations should be additive. Faultline must remain useful without router credentials.

## 0.6C - Probe fleet intelligence and safety

Before the probe fleet grows, v0.6 should also harden how probes are selected and what they are allowed to test.

Planned work:

- choose probes by country/region/tag rather than only explicit probe ID
- health-aware probe scheduling
- basic workload-aware selection
- probe credential rotation
- explicit revoke/disable/drain controls
- audit events for probe lifecycle operations
- prevent remote probe jobs from targeting loopback, link-local, RFC1918/private or cloud-metadata addresses unless an explicitly trusted private-probe mode is introduced
- re-resolve redirects and DNS results to prevent public-to-private target bypasses
- bounded HTTP response handling
- resource/time limits per job

**v0.6 milestone:** a support engineer can launch a one-time diagnostic, see an interactive inferred map of the affected network, and have Faultline safely select an appropriate remote vantage.

---

# v0.7 - Connectivity Contracts and deeper remote diagnostics

**Goal:** make Faultline understand what a specific application actually requires from the network.

## Connectivity Contracts

Introduce an open machine-readable service profile, for example:

```yaml
service: Example SaaS
checks:
  - dns: api.example.com
  - tcp:
      host: api.example.com
      port: 443
  - https: https://api.example.com/health
  - websocket: wss://realtime.example.com
```

Initial profiles should target common support scenarios such as:

- generic website/API
- Microsoft 365
- Webex
- Slack

The goal is not to duplicate vendor documentation. Faultline should turn published connectivity requirements into repeatable tests.

## Deeper remote evidence

Expand registered probes beyond DNS/TCP/HTTP with carefully interpreted:

- ICMP latency/loss
- jitter
- traceroute
- IPv4 vs IPv6 comparison
- TLS handshake timing
- HTTP TTFB
- path-MTU checks where practical
- ASN/network-owner enrichment for public path hops

**Milestone:** Faultline can answer both "where is the fault?" and "which required application connectivity condition is failing?"

---

# v0.8 - Cases and evidence packages

**Goal:** convert diagnostics into support artefacts that can actually be used during escalation.

Planned work:

- persistent support cases around one or more diagnostic sessions
- incident timeline
- case notes/status
- multiple endpoint or probe runs within a case
- before/after evidence comparisons
- exportable evidence report
- JSON export
- shareable read-only evidence link
- cryptographic hash/signature for exported evidence
- clear observed vs inferred distinction in reports

A report should answer:

- what failed?
- from which vantage points?
- when was it measured?
- what remained healthy?
- where does the combined evidence place the fault?
- what should the receiving team verify next?

**Milestone:** an engineer can attach a Faultline evidence package to an ISP, SaaS or internal escalation ticket.

---

# v0.9 - Cross-party troubleshooting

**Goal:** let separate organisations contribute scoped evidence to the same case without giving each other full platform access.

Potential participants:

- affected customer
- customer IT
- MSP
- ISP
- SaaS vendor
- Faultline independent probes

Planned work:

- scoped external participant invitations
- participant-specific permissions
- evidence provenance
- comments/challenges attached to evidence
- requested counter-tests
- immutable event/audit timeline
- diagnostic re-evaluation when new evidence is contributed

Potential workflow:

```text
Faultline: likely ISP/upstream fault
       |
       v
ISP challenges conclusion
       |
       v
Faultline requests defined counter-test
       |
       v
ISP/customer contributes new evidence
       |
       v
Deterministic diagnosis recalculated
```

**Milestone:** Faultline becomes a shared incident-evidence workspace rather than merely a diagnostic dashboard.

---

# v1.0 - Hosted commercial MVP

**Goal:** make Faultline usable by a real support team without repository access or command-line administration.

Planned platform capabilities:

- hosted control plane
- PostgreSQL-backed storage
- organisations and users
- customer/workspace separation
- engineer/admin/read-only roles
- production authentication
- rate limiting
- audit records
- retention controls
- proper secrets/credential lifecycle
- production probe scheduler
- reliable job delivery
- stable ephemeral diagnostic client flow
- Network Map integrated into live cases
- case/evidence workflow
- baseline service profiles

**Milestone:** first real pilot organisations and first paying customer.

---

# v1.1 - Service-profile ecosystem

**Goal:** make Connectivity Contracts reusable and extensible.

Planned work:

- versioned profile schema
- community/vendor profiles
- profile validation tooling
- custom organisation profiles
- private/internal application profiles
- profile test history

Potential longer-term direction: vendors publish a `faultline.yaml` describing what healthy connectivity to their application requires.

---

# v1.2 - Embedded support diagnostics

**Goal:** let another product or helpdesk launch Faultline directly from its own support workflow.

Planned work:

- API/SDK for diagnostic creation
- embeddable "Run connection diagnostic" experience
- support-ticket correlation IDs
- webhook/event delivery
- scoped diagnostic links

This creates a path for SaaS vendors and MSPs to make Faultline part of their own support experience.

---

# v1.3 - Support integrations

Potential integrations:

- ServiceNow
- Jira Service Management
- Zendesk
- Freshservice
- HaloPSA
- ConnectWise
- Microsoft Teams
- Slack

The important integration is not generic alert spam. It should let an engineer launch a diagnostic and attach the resulting evidence to an existing case/ticket.

---

# v1.5 - Network change assurance

**Goal:** extend Faultline from reactive fault isolation into functional network validation.

Workflow:

```text
Capture baseline
      |
Network/firewall/VPN/SD-WAN change
      |
Repeat identical Connectivity Contracts
      |
Compare functional differences
```

Use cases:

- firewall changes
- VPN changes
- DNS migrations
- SD-WAN changes
- proxy/TLS inspection changes
- ISP migrations

**Milestone:** Faultline can show which required service behaviours changed after a network modification.

---

# v2.0 - Multi-vantage incident platform

**Goal:** correlate patterns across many affected endpoints and independent vantage points.

Example:

```text
Glasgow endpoint A     FAIL
Glasgow endpoint B     FAIL
Edinburgh endpoint     FAIL
London public probe    PASS
Frankfurt public probe PASS
```

Compared with:

```text
All endpoints          FAIL
London public probe    FAIL
Frankfurt public probe FAIL
New York public probe  FAIL
```

The system should use these patterns to increase or decrease support for regional access-path, ISP/transit, policy and global service hypotheses.

Longer-term capabilities:

- multiple endpoints per incident
- multiple probes per incident
- regional fault patterns
- explicit network ownership/demarcation boundaries
- organisation-owned private probes
- richer topology/controller integrations
- service-provider or SaaS-side evidence contributions
- functional SLA/SLO evidence

**Milestone:** Faultline becomes a network support and fault-arbitration platform rather than a single-session diagnostic utility.

---

## What Faultline should not become

The roadmap deliberately avoids turning Faultline into:

- a generic SNMP/NMS platform
- a SIEM
- a packet-capture warehouse
- a full APM suite
- a generic chatbot
- an LLM root-cause engine
- a clone of ThousandEyes/Catchpoint/Obkio

Faultline should remain centred on a narrower question:

> **When a network-dependent service is failing across an ownership boundary, what does the available evidence show, where does the fault most likely begin, and what evidence can be handed to the team responsible?**
