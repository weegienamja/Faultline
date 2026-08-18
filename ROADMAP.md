# Faultline roadmap

Faultline is being developed as an evidence-based network support platform rather than a generic monitoring product. The core direction is to make difficult connectivity incidents easier to diagnose, explain and hand off when the fault may sit across endpoint, LAN, ISP, transit, VPN or SaaS boundaries.

The diagnostic path remains deterministic and does not depend on an AI or LLM API.

## Roadmap principles

1. **Incident-first, not monitoring-first.** Faultline should be useful when a support engineer encounters a device or network they do not already manage.
2. **Evidence before blame.** Fault-domain conclusions must be backed by explicit observations from known vantage points.
3. **Cross-boundary support.** Customers, MSPs, ISPs and SaaS vendors should be able to contribute or consume evidence without sharing full administrative access.
4. **No false certainty.** Inferred topology, traceroute ownership and diagnosis confidence must distinguish observed facts from heuristics.
5. **Privacy by default.** Collect the minimum network metadata needed to diagnose the issue.
6. **No AI dependency in the diagnosis path.** The same measurements should produce the same result.

---

## v0.1 - Diagnosis prototype ✅

Implemented deterministic fault-domain rules, evidence, confidence, recommended actions and demo incidents.

**Milestone:** Faultline can explain why evidence supports a particular fault domain.

## v0.2 - Real endpoint telemetry ✅

Implemented Windows gateway, DNS, Wi-Fi, VPN, route, TCP/HTTP, loss/jitter and traceroute collection.

**Milestone:** Faultline can diagnose evidence from an actual affected Windows machine.

## v0.3 - Two-vantage correlation ✅

Implemented portable remote probes and endpoint + independent-vantage correlation.

**Milestone:** Faultline can distinguish some endpoint/access-path problems from target-service problems.

## v0.4 - Persistent authenticated control plane ✅

Implemented persistent sessions, role-scoped credentials, hashes at rest, expiry, admin-protected live telemetry and Docker deployment.

**Milestone:** diagnostic sessions survive restarts and work across separate machines without unauthenticated ingestion.

## v0.5 - Registered probe fleet ✅

Implemented durable `PRB-...` identities, probe credentials, heartbeat health, per-probe job queues, registered workers and fleet UI.

**Milestone:** a remote VPS can remain online as a known Faultline vantage and pick up assigned diagnostics.

---

# v0.6 - Real support workflow

**Goal:** make Faultline usable during an actual support ticket rather than only as a collection of engineering commands.

## 0.6A - Ephemeral support diagnostics ✅ preview

Implemented:

- dashboard and CLI diagnostic creation
- one-time `fl_inv_...` invitation links
- explicit consent screen
- session expiry
- Network Map opt-out
- automatic case/session association
- invitation invalidation after claim

Remaining:

- optional evidence preview/redaction before upload
- broader UX and accessibility testing

## 0.6B - Interactive inferred network topology ✅ preview

Implemented:

- passive Windows neighbour discovery
- endpoint/default-gateway/Wi-Fi evidence
- star / tree / mesh / unknown inference
- observed vs inferred links
- draggable topology canvas
- device glyphs and confidence markers
- diagnosis-aware affected-path overlays

Remaining:

- OUI/vendor enrichment
- stronger device classification
- zoom/pan and filtering
- bounded consented discovery where justified
- router/controller integrations for authoritative topology

Potential later controller integrations include UniFi, Omada/OpenWrt, pfSense/OPNsense and other platforms where supported APIs exist.

## 0.6C - Probe fleet intelligence and safety ✅ preview

Implemented:

- explicit `public` and `private` registered-probe scopes
- country, region and tag scheduling metadata
- automatic health-aware probe selection
- least-loaded selection among matching online probes
- deterministic tie-breaking
- explicit probe-ID override
- dashboard diagnostics default to automatic public-probe selection
- invitation CLI country/region/tag/scope selectors
- draining and maintenance lifecycle states
- enable/disable controls
- registered-probe credential rotation
- registered-probe credential revocation
- bounded lifecycle audit events
- basic registered-probe submission rate limiting
- public-probe target-port allow-list
- blocking of loopback, RFC1918/private, link-local, CGNAT/shared, multicast, documentation and reserved address space
- IPv4-mapped IPv6 and translation-prefix checks
- validation of all DNS answers immediately before connection
- TCP pinning to a validated resolved address
- manual HTTP redirect handling with destination revalidation at every hop
- response-body discard and bounded connection/redirect behaviour
- JSON state migration to v3 with audit storage

The key trust rule is that a public probe does not trust a target merely because the control plane assigned it. The worker independently validates the destination immediately before connecting.

Remaining production hardening:

- distributed scheduler leases/claims for multi-process operation
- persistent/distributed rate limiting
- organisation quotas and per-target abuse controls
- production actor identity in audit events
- richer capability-aware scheduling
- carefully managed tenant-specific target policies

See [docs/FLEET_SAFETY.md](docs/FLEET_SAFETY.md).

## 0.6D - Packaged Windows diagnostic client ✅ preview

Implemented:

- standalone `Faultline.exe` source
- Node Single Executable Application build configuration
- Windows CI build and packaged-binary self-test
- GitHub Actions executable artifact
- browser consent no longer receives endpoint upload credentials
- one-use `fl_launch_...` launcher credential
- `.faultline` browser-to-client handoff
- automatic handoff discovery from Downloads/executable directory
- one-time launcher → endpoint credential exchange
- best-effort handoff deletion after exchange
- automatic native Windows collection and evidence upload
- three-attempt upload retry
- token-free recovery payload on final upload failure
- deployment-configured Windows-client download URL

Remaining before production readiness:

- Authenticode code signing
- stable signed release/download channel
- real-world Windows 10/11 testing
- enterprise endpoint-control/SmartScreen testing
- graphical client shell if required
- custom URI/file-association flow for a cleaner one-click launch
- recovery-upload workflow

### v0.6 exit criteria

```text
Engineer creates diagnostic
        |
        v
User receives one link
        |
        v
User understands + consents
        |
        v
No developer tooling required on affected PC
        |
        v
Faultline.exe collects + uploads
        |
        v
Interactive topology appears
        |
        v
Safe remote probe selected
        |
        v
Evidence correlated into fault domain
```

The **core v0.6 workflow is feature-complete as a preview** once the 0.6C implementation passes the full CI pipeline. The remaining v0.6 work is production hardening rather than another major functional slice.

---

# v0.7 - Connectivity Contracts and deeper diagnostics

**Goal:** make Faultline understand what a specific application actually requires from the network.

Introduce an open machine-readable profile such as:

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

Initial profiles should cover generic web/API tests and common support scenarios such as Microsoft 365, Webex and Slack.

Expand remote evidence with carefully interpreted ICMP, jitter, traceroute, IPv4/IPv6 comparison, TLS timing, HTTP TTFB, path-MTU tests and public ASN/network-owner enrichment.

**Milestone:** Faultline can answer both where a fault begins and which application connectivity condition is failing.

---

# v0.8 - Cases and evidence packages

**Goal:** convert diagnostics into support artefacts that can be used during escalation.

Planned work:

- persistent support cases
- incident timeline and notes/status
- multiple runs per case
- before/after evidence comparison
- exportable PDF/JSON evidence packages
- read-only evidence sharing
- cryptographic hashes/signatures
- explicit observed vs inferred evidence markers

**Milestone:** an engineer can attach a Faultline evidence package to an ISP, SaaS or internal escalation ticket.

---

# v0.9 - Cross-party troubleshooting

**Goal:** let separate organisations contribute scoped evidence to the same case.

Potential participants include customer IT, MSP, ISP, SaaS vendor and Faultline independent probes.

Planned work:

- scoped participant invitations
- participant permissions
- evidence provenance
- comments/challenges attached to evidence
- requested counter-tests
- immutable event/audit timeline
- deterministic re-evaluation when new evidence arrives

**Milestone:** Faultline becomes a shared incident-evidence workspace rather than merely a diagnostic dashboard.

---

# v1.0 - Hosted commercial MVP

Planned capabilities:

- hosted control plane
- PostgreSQL-backed persistence
- organisations/users/workspaces
- production authentication and roles
- distributed rate limiting and audit records
- retention controls
- production credential lifecycle
- reliable job delivery
- stable signed endpoint client
- production probe scheduler
- cases/evidence workflow
- baseline Connectivity Contracts

**Milestone:** pilot organisations and first paying customer.

---

# v1.1 - Connectivity profile ecosystem

- versioned profile schema
- profile validation tooling
- community/vendor profiles
- organisation/private profiles
- profile test history
- potential `faultline.yaml` vendor convention

# v1.2 - Embedded support diagnostics

- diagnostic creation API/SDK
- embeddable "Run connection diagnostic" experience
- support-ticket correlation IDs
- webhook/event delivery

# v1.3 - Support integrations

Potential targets include ServiceNow, Jira Service Management, Zendesk, Freshservice, HaloPSA, ConnectWise, Teams and Slack.

The useful integration is launching a diagnostic and attaching evidence to an existing case, not generic alert forwarding.

# v1.5 - Network change assurance

Capture a functional baseline, run a firewall/VPN/SD-WAN/DNS/proxy change, repeat the same Connectivity Contracts and show exactly which required behaviours changed.

# v2.0 - Multi-vantage incident platform

Correlate multiple affected endpoints and multiple independent probes, identify regional/global patterns, represent ownership/demarcation boundaries and support organisation-owned private probes and provider-side evidence.

**Milestone:** Faultline becomes a broader network support and fault-arbitration platform.

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
