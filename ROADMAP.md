# Faultline roadmap

Faultline is a local-first, evidence-based network diagnostics project focused on one hard support problem:

> Find the network condition that breaks a connection, capture the evidence around it, and preserve enough context for another engineer to reproduce and inspect the result.

The roadmap is organised by capability rather than by release number. The repository has already moved beyond the old v1.5 sequence, and forcing every new idea into v1.6, v1.7 and v1.8 would make the roadmap less useful.

## Product loop

```text
CAPTURE
Flight Recorder
   |
   v
ISOLATE
Network Bisect
   |
   v
EXPLAIN
Faultline Analyst
   |
   v
PRESERVE
Portable Incident Capsule
```

The deterministic path remains separate from interpretation. Observed measurements, deterministic comparisons, deterministic rule findings, deterministic experiments, simulated evidence and Analyst interpretation are distinct classes.

## Product principles

1. Incident-first, not monitoring-first.
2. Evidence before blame.
3. Local use should remain useful without an account.
4. Do not reconfigure the host when a per-connection experiment can answer the question.
5. No false certainty about topology, ownership or causation.
6. No cloud AI dependency in diagnosis.
7. Analyst output can explain evidence but cannot become a finding.
8. Preserve enough provenance that another person can inspect what happened.
9. Prefer a small number of unusually useful diagnostic capabilities over a broad monitoring feature list.
10. Interoperability over vendor lock-in.

---

# Delivered on current main

| Capability | What is implemented | Status |
|---|---|---|
| Deterministic diagnosis | Fault-domain conclusions from observed measurements | Delivered |
| Windows endpoint telemetry | Adapter, route, gateway, Wi-Fi, VPN and resolver evidence | Delivered |
| Registered probes | Authenticated independent vantage points | Delivered preview |
| One-time diagnostics | Short-lived endpoint invitations and scoped collection | Delivered preview |
| Connectivity Contracts | Versioned, project-scoped connectivity requirements | Delivered preview |
| Cases and evidence | Multi-run cases, provenance, redaction and integrity-tagged exports | Delivered preview |
| Cross-party rooms | Scoped external contributions without control-plane access | Delivered preview |
| Organisation/project isolation | Tenant and project boundaries | Delivered preview |
| Embedded API and SDK | v1 API, JavaScript SDK and launch widget | Delivered preview |
| Service-desk correlation | Ticket correlation and provenance-preserving update envelopes | Delivered preview |
| Deeper diagnostics | Dual-stack, TLS, HTTP timing and bounded Windows path-MTU evidence | Delivered preview |
| Network Change Assurance | Named change windows and pinned baseline/post-change comparison | Delivered preview |
| Live Diagnostics | Real local measurement plus public Internet context | Delivered |
| Data Science | Similarity scoring, DBSCAN clustering and explicit outliers | Delivered preview |
| **Network Bisect** | Adaptive per-connection condition isolation with reproducibility gating and paired confirmation | **Delivered** |
| **Flight Recorder** | Bounded rolling capture, freeze-on-trigger, deep capture and before/during/after incident windows | **Delivered** |
| Recorder simulation | Reproducible scenarios using the same Recorder engine with explicit simulated provenance | Delivered |
| **Faultline Analyst** | Optional local Ollama explanation layer with read-only evidence tools and citation validation | **Delivered** |
| **Portable Incident Capsule** | Self-contained offline HTML incident package with evidence, experiments, provenance, redaction and integrity digest | **Delivered** |
| Modern evidence UI | Cascade layers, container queries, chronology-first Recorder UI and explicit evidence semantics | Delivered |

The previous roadmap still described intermittent capture and portable evidence as future gaps. Those gaps are now filled by Flight Recorder and Portable Incident Capsule.

---

# Current centre of gravity

Faultline should not compete with broad NMS, APM or observability suites on feature count.

Its strongest wedge is:

> **Find the condition that breaks a connection, then show the evidence that makes that conclusion reproducible.**

The next work should deepen that investigation rather than expand sideways into generic monitoring.

---

# Priority 1: Path Diff

**Problem:** Network Bisect can establish that a condition such as IPv4 versus IPv6 changes the outcome, but an engineer still has to manually compare what happened to the path under the working and failing conditions.

**Goal:** after Bisect isolates a discriminator, collect paired path observations and show where the working and failing paths observably diverge.

The first version should:

- collect path evidence under the confirmed A and B conditions
- keep the observations close together in time
- preserve source interface, address family, resolver and resolved destination
- compare local egress, destination address, visible hop sequence, ASN transitions and target reachability
- treat traceroute non-response as unknown or hidden, not as a failed hop
- handle ECMP and route variation with repeated observations rather than a single snapshot
- compare IPv4 and IPv6 semantically rather than pretending their literal address paths should match
- expose resolver-driven destination changes without attributing the path difference to the resolver alone
- label outcomes such as `SAME_OBSERVED_PATH`, `OBSERVED_PATH_DIFFERENCE`, `INSUFFICIENT_PATH_VISIBILITY`, `UNSTABLE_PATH` and `NOT_COMPARABLE`
- persist the paired observation as evidence that can be included in an Incident Capsule

The wording must stay conservative. "Observed path divergence" is valid. "The failure begins at hop 7" is not valid unless the evidence actually establishes that.

**Why it matters:** this turns a Bisect result from "IPv6 is the discriminator" into "IPv6 is the reproducible discriminator, and here is how the visible working and failing paths differ."

---

# Priority 2: Faultline Witness

**Problem:** many network arguments reduce to one side saying the service works and the other side saying it does not.

**Goal:** reproduce the same diagnostic from two or more endpoints or vantage points in the same investigation.

A first useful version should:

- create a bounded witness session for a target and time window
- let another endpoint join through a one-time scoped link
- run the same diagnostic stages independently from every vantage
- compare DNS, IPv4, IPv6, TCP, TLS and HTTP outcomes per vantage
- preserve the provenance of every participant
- state `reproduced` or `not reproduced` without inventing a LAN, ISP or service root cause
- reuse existing invitation, probe and case boundaries rather than introducing a second auth model
- include witness evidence in the Incident Capsule

Public probes can supplement a Witness session, but a public vantage should never be treated as equivalent to the affected endpoint.

---

# Priority 3: Evidence Topology and time scrubber

**Problem:** a static network map loses the most important dimension in a transient incident: time.

**Goal:** make topology an evidence view rather than a decorative diagram.

The useful shape is:

```text
endpoint -> gateway -> ISP / public path -> target
```

with evidence state attached to the path and a time control that can move through:

```text
BEFORE -> TRIGGER -> DURING -> DEEP CAPTURE -> AFTER / RECOVERY -> BISECT
```

Requirements:

- show OBSERVED and INFERRED relationships distinctly
- allow the Recorder incident chronology to drive the topology state
- keep confirmed Bisect experiments visually separate from the earlier temporal association
- support long IPv6 addresses, missing hops and unstable paths
- avoid a generic 3D router-map aesthetic
- preserve the current rule that ASN and ownership labels are public routing metadata, not proof of fault ownership

---

# Priority 4: Handshake Microscope

**Problem:** Wireshark is powerful, but it is much broader than the question Faultline is trying to answer.

**Goal:** optionally capture only the diagnostic flow and turn the relevant packet-level events into a compact connection timeline.

Useful evidence could include:

- SYN, SYN-ACK and ACK progression
- retransmissions and timeouts
- resets
- TLS ClientHello properties
- SNI
- TLS version and ALPN
- TLS alerts
- ICMP and ICMPv6 signals relevant to the tested flow
- Packet Too Big / MTU evidence where available

This should not become a packet-capture warehouse. Capture must be bounded, optional, privacy-aware and tied to one diagnostic flow.

---

# Priority 5: Fault Lab

**Problem:** an open-source diagnostic tool is easier to evaluate when users can reproduce meaningful faults without waiting for a real outage.

**Goal:** expand the Recorder simulation model into a deterministic diagnostic lab that exercises the same capture, isolation and evidence pipeline as real incidents.

Candidate scenarios:

- IPv6 black hole
- broken AAAA path
- resolver failure
- split DNS
- slow DNS
- VPN route takeover
- MTU black hole
- TLS version intolerance
- SNI failure
- certificate expiry
- intermittent loss
- flapping gateway
- connection reset
- asymmetric reachability

Simulation must remain visually and structurally distinct from measured evidence. If a scenario does not model path evidence, Faultline should not fabricate path evidence for it.

---

# Priority 6: Multi-platform and private-network parity

**Problem:** the most useful faults often happen on systems and inside networks the current Windows-oriented collection path does not fully cover.

Work includes:

- Linux local collector parity
- macOS local collector parity
- route lookup and source-interface classification on each platform
- private-probe Network Bisect
- Connectivity Contract execution from private probes
- convergence between the packaged Windows collector and the modular Node collector

The aim is capability parity, not merely making the process start on another OS.

---

# Priority 7: Incident recurrence fingerprints

**Problem:** engineers repeatedly investigate incidents that look familiar but have no deterministic way to ask whether the evidence pattern has appeared before.

**Goal:** provide a transparent "have I seen this before?" comparison.

It should show:

- which evidence fields matched
- which fields differed
- whether the same discriminator was previously confirmed
- whether the previous incident was only temporally similar
- exact links back to the source incidents

This should build on the existing evidence similarity work without becoming an opaque ML root-cause score.

---

# Network Bisect extensions

These remain useful, but they are secondary to Path Diff and Witness because the current Bisect engine is already a complete usable feature.

Potential extensions:

- MTU / DF-bit as a controlled condition where the platform supports it safely
- proxy versus direct when a proxy is explicitly configured
- combination search when no single condition explains the outcome
- Bisect execution from a registered private probe
- broader source-interface semantics on Linux and macOS

Any new axis must preserve the current rule that the experiment changes only the connection under test and does not reconfigure the host.

---

# Existing supporting capabilities that should be hardened, not expanded for their own sake

## Cases and cross-party workflow

Keep improving provenance, redaction, retention and portability. Do not turn Faultline into a ticketing system.

## Connectivity Contracts

Keep them useful as reproducible expected-behaviour definitions. Do not turn the project into a generic policy platform.

## Change Assurance

Keep the distinction between "changed after the maintenance" and "caused by the maintenance" explicit.

## Faultline Analyst

Keep it local, optional and read-only. Improve explanation quality only when it makes deterministic evidence easier to understand. Do not expand it into an autonomous root-cause agent.

## Public Internet context

Continue treating RIPEstat, IODA, PeeringDB, RIPE Atlas and Cloudflare Radar as context. Only genuine measurement evidence should feed a deterministic comparison.

---

# Epistemic rules

These are product requirements, not wording preferences.

1. Observed measurement is authoritative for what was measured, not for why it happened.
2. A temporal difference is a deterministic comparison, not causation.
3. A deterministic rule finding is a reproducible derivation, not a controlled experiment.
4. A controlled experiment earns stronger wording only when Faultline deliberately varied a condition and reproduced the outcome difference.
5. Simulated evidence is never presented as measured evidence.
6. Analyst interpretation is never allowed to outrank deterministic evidence.
7. A hidden traceroute hop is unknown, not failed.
8. ASN ownership is routing metadata, not proof of fault ownership.
9. Evidence must remain traceable and reproducible.

---

# What Faultline should not become

- generic SNMP/NMS
- SIEM
- packet-capture warehouse
- full APM suite
- generic chatbot
- LLM root-cause engine
- continuous-observability clone
- speculative SaaS shell whose useful features only exist on a future roadmap

The test for a new feature is simple:

> Would a network engineer, sysadmin, support engineer or developer install this locally because it answers a painful question that is currently annoying to answer manually?

If the answer is no, it is probably not the right next feature.

---

# At a glance

| State | Capability | Question answered |
|---|---|---|
| Delivered | Flight Recorder | What happened around the transient fault? |
| Delivered | Network Bisect | Which condition reproducibly changes the outcome? |
| Delivered | Faultline Analyst | How can the collected evidence be explained without changing the finding? |
| Delivered | Portable Incident Capsule | Can another person inspect the investigation offline? |
| **Next** | **Path Diff** | **How do the working and failing paths observably differ?** |
| Planned | Faultline Witness | Does the same failure reproduce from another vantage point? |
| Planned | Evidence Topology + time | How did the visible network state change through the incident? |
| Planned | Handshake Microscope | What happened inside the diagnostic connection itself? |
| Planned | Fault Lab | Can the full investigation be reproduced safely on demand? |
| Planned | Multi-platform parity | Can the same investigation run on the affected OS and network? |
| Planned | Incident recurrence fingerprints | Have we seen materially the same evidence pattern before? |
