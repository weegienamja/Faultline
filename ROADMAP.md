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
| Network Bisect | Per-connection condition isolation with reproducibility gating and paired confirmation | ✅ |

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

# Direction

The version-numbered plan below v1.5 has been delivered. What follows is
organised by **capability**, not by release number, because the useful question
for an open-source network tool is "what can it isolate that I cannot isolate
easily today", not "what version is it".

Each theme states the problem it exists to solve. None of them require a hosted
product to be valuable.

---

## Intermittent faults

**Problem:** the fault clears before anyone can look at it. Continuous graphs
show *that* something happened; they rarely show *what changed*.

- bounded local ring buffer of network metadata (gateway, Wi-Fi, DNS, route,
  VPN state, loss, jitter, target reachability, path fingerprint)
- trigger on threshold breach, contract failure or an explicit hotkey
- freeze BEFORE / DURING / AFTER into one incident
- flake-rate measurement as a first-class result, not a footnote

Network Bisect already refuses to draw conclusions from an unstable baseline
and reports the flake rate instead. Capturing the unstable window is the next
step.

## Condition isolation

**Problem:** "works on my machine" and "try your hotspot" are guesswork.

Delivered as **Network Bisect**: per-connection variation of address family,
resolver, resolved address, source interface, TLS version, ALPN, SNI and port,
with reproducibility gating, interleaved paired confirmation and duplicate
collapsing.

Worth extending:

- MTU / DF-bit as a bisect axis, so black holes surface as a condition
- proxy vs direct where a proxy is configured
- combination search when no single factor explains the difference
- bisecting from a registered private probe as well as the local machine

## Path reasoning

**Problem:** several traceroutes are not an analysis.

- determine where working and failing paths meaningfully diverge
- attribute divergence to a shared network rather than a shared hop address
- distinguish OBSERVED hops from PUBLIC ROUTING METADATA (already enforced in
  the Network Map)
- treat a shared AS across failing paths as an escalation signal, never as proof

## Portable evidence

**Problem:** evidence dies inside whoever ran the tool.

- single-file incident capsule containing measurements, timeline, path
  fingerprints, deterministic conclusion, contract results and an integrity
  manifest
- offline viewer so a recipient needs no access to the originating control plane
- evidence packages and integrity digests already exist; portability is the gap

## Private and multi-platform collection

**Problem:** the interesting faults are inside networks the tool cannot reach,
on machines that are not Windows.

- Linux and macOS local collectors at parity with the Windows collector
- private-probe bisect and contract execution inside a customer network
- the packaged client currently carries its own self-contained collector rather
  than the modular one; converging them is outstanding

## Deterministic reasoning quality

**Problem:** confident wrong answers are worse than no answer.

- keep every conclusion traceable to the measurement that produced it
- keep OBSERVED, INFERRED, CORRELATED, EXTERNAL CONTEXT and DETERMINISTIC
  CONCLUSION distinct in the data model, not only in the wording
- continue to say "evidence supports", never "this caused the fault"
- no LLM in the diagnosis path, ever

---

# At a glance

**Delivered**

| Capability | Outcome |
|---|---|
| Deterministic diagnosis | Fault-domain reasoning from observed measurements, no model in the path |
| Endpoint + remote vantage | Windows telemetry, registered public/private probe fleet, correlation |
| Connectivity Contracts | Versioned, project-scoped application connectivity requirements |
| Cases and evidence | Multi-run cases, provenance, redaction, integrity-tagged export packages |
| Cross-party rooms | Scoped external contribution without control-plane access |
| Deeper diagnostics | Dual-stack, TLS, HTTP stage timing, bounded path-MTU |
| Change assurance | Named change windows, pinned baseline/post-change comparison |
| Live Internet data | Real local measurement plus RIPEstat, Globalping, RIPE Atlas, IODA, PeeringDB |
| **Network Bisect** | **Per-connection condition isolation with reproducibility gating** |

**Next, by capability rather than release number**

| Theme | The question it answers |
|---|---|
| Intermittent faults | What was happening in the seconds before it broke? |
| Condition isolation | Which single condition makes the difference? (extending Bisect) |
| Path reasoning | Where do working and failing paths actually diverge? |
| Portable evidence | Can someone else inspect this without my server? |
| Private / multi-platform | Can it run inside the network that is actually broken, on any OS? |
| Deterministic quality | Is every conclusion still traceable to a measurement? |

## What Faultline should not become

- generic SNMP/NMS;
- SIEM;
- packet-capture warehouse;
- full APM suite;
- generic chatbot;
- LLM root-cause engine;
- clone of continuous-observability platforms.

The project stays centred on one support question: **what does the evidence show, where does the fault most likely begin, who owns that boundary, and what should happen next?**
