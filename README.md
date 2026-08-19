# Faultline

**Find the network condition that breaks a connection, without reconfiguring anything.**

```bash
git clone https://github.com/weegienamja/Faultline.git
cd Faultline && npm install
npm run bisect -- github.com
```

No account. No API key. No server. No Docker. Every line of output is a real
connection made from your machine.

---

## The problem

When something "doesn't work on this network", isolation is manual and
disruptive:

```text
turn Wi-Fi off and on        try your phone hotspot
disconnect the VPN           change your DNS to 8.8.8.8
disable IPv6                 try from another machine
```

Every step reconfigures the machine, often needs admin rights, interrupts
everything else, and is undone before anyone records what happened. On a managed
endpoint most are impossible. And when one appears to help, nobody re-tests to
check whether the network simply recovered on its own.

## What Faultline does instead

`git bisect` finds the commit that broke a build. **Network Bisect** finds the
network *condition* that breaks a connection — by varying one condition at a
time **per connection**, leaving the operating system untouched.

```text
  CONDITION                     VARIANT                           RESULT n     DETAIL
  ----------------------------------------------------------------------------------
  baseline                      baseline (system defaults)        PASS  2/2   HTTP 200
  IP address family             IPv4 only                         PASS  2/2   HTTP 200
  IP address family             IPv6 only                         FAIL  0/2   tcp: ENETUNREACH
  DNS resolver                  resolver 1.1.1.1                  PASS  2/2   HTTP 200
  Specific resolved address     address 2606:4700:10::6814:179a   FAIL  0/2   tcp: ENETUNREACH
  Local source interface        via Ethernet (192.168.0.95)       PASS  2/2   HTTP 200
  Local source interface        via Ethernet 2 (192.168.56.1)     FAIL  0/2   tcp: ENETUNREACH
  TLS version                   TLS 1.2 only                      PASS  2/2   HTTP 200

  CONDITION ISOLATED
  IP address family: IPv6 only flips PASS to FAIL

  Evidence supports: the failure is reproducibly associated with
  ip address family = IPv6 only.

  Interleaved confirmation (A=baseline, B=IPv6 only): A+ B- A+ B-
  Difference held under alternation.
```

Eight condition axes are varied per connection, so nothing on the machine
changes: **address family**, **DNS resolver**, **specific resolved address**,
**local source interface** (VPN vs direct, without disconnecting the VPN),
**TLS version**, **ALPN**, **SNI** and **port**.

## Why this isn't just ping and traceroute

`ping`, `traceroute` and `mtr` tell you *that* a path is bad. They cannot tell
you *which condition* makes the difference, and they will happily mislead you
when a fault is intermittent. Network Bisect is built around that problem:

- **Reproducibility gating** — every condition runs N times and only a unanimous
  result counts. If the baseline itself is unstable, bisection is **refused**
  rather than blaming whichever variant ran during a good patch.
- **Interleaved paired confirmation** — the winner is re-tested `A B A B` so a
  network that recovers mid-run shows up as *unconfirmed* instead of as a cure.
- **Duplicate collapsing** — conditions that produce an identical connection are
  reported once, attributed to the most general axis.
- **Honest classification** — `github.com` publishing no AAAA record is reported
  as a property of the target, never as "your IPv6 is broken". Omitting SNI
  breaking a name-based host is flagged as expected, not as a fault.

Read the design: **[Network Bisect](docs/NETWORK_BISECT.md)**.

## Exit codes

```text
0  no fault reproduced          2  failure was not condition-specific
1  a condition was isolated     3  evidence insufficient (intermittent/unconfirmed)
```

## The rest of Faultline

Bisect is the fastest way in. Behind it is an evidence-based fault-isolation
control plane: run `npm start` and open <http://localhost:3000>.

```bash
npm start                          # dashboard on :3000
npm run bisect -- example.com      # condition isolation, no server needed
```

It also does real live measurement (DNS across four resolvers, TCP, TLS
certificate and cipher, HTTP TTFB, ICMP, traceroute with public-hop ASN
enrichment), deterministic fault-domain diagnosis, support cases with portable
evidence packages, cross-party incident rooms, Connectivity Contracts, and
public Internet context from RIPEstat, Globalping, RIPE Atlas, IODA and
PeeringDB — all credential-free.

**Faultline does not use an AI/LLM API anywhere in diagnosis.** Every conclusion
is produced by deterministic rules over observed measurements and is traceable
to the evidence that produced it.

---

## Implemented previews

- v0.1-v0.7: deterministic diagnosis, Windows telemetry, remote correlation, probe fleet, one-time diagnostics, topology and Connectivity Contracts
- Data Science: standardisation, evidence similarity, DBSCAN clustering and explicit outliers
- **v0.8:** support cases, multiple runs, provenance and evidence exports
- **v0.9:** cross-party incident rooms with scoped external contributions
- **v1.0:** organisation/project tenancy with isolated cases and credential lifecycle
- **v1.1:** project-scoped Connectivity Contract catalog with version lifecycle and provenance
- **v1.2:** embedded diagnostics API, JavaScript SDK and end-user launch widget
- **v1.3:** service-desk ticket correlation and provenance-preserving update envelopes
- **v1.4:** dual-stack, explicit TLS, HTTP stage timing and bounded Windows path-MTU evidence
- **v1.5:** named change windows, pinned baseline/post-change runs, regression detection and integrity-tagged assurance packages

- **Live data:** real DNS/TCP/TLS/HTTP/ICMP/path measurement plus public routing, outage and network-ownership context
- **Network Bisect:** controlled per-connection condition isolation with reproducibility gating and paired confirmation

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## Live network and Internet data

Open <http://localhost:3000>, unlock live data, and run a diagnostic against a real
target (`example.com`, `1.1.1.1`, `https://example.com/health`). Faultline measures
DNS across four resolvers, TCP, TLS (version/cipher/certificate), HTTP TTFB, ICMP
and the network path from this machine, then adds public Internet context:

```text
LOCAL        DNS, TCP, TLS, HTTP, ICMP, traceroute, adapter/Wi-Fi/VPN/DNS state
GLOBALPING   live ping from public vantage points          no credential
RIPESTAT     prefix, origin ASN, holder, RPKI, RIS, BGP    no credential
RIPE ATLAS   connected public probes near the network      no credential
IODA         outage/anomaly signals                        no credential
PEERINGDB    self-published network metadata               no credential
CF RADAR     outage annotations                            optional token
```

Only Cloudflare Radar needs a credential (`FAULTLINE_CLOUDFLARE_RADAR_TOKEN`); it is
disabled and shows "Not configured" without one. Public enrichment only ever
transmits a globally routable IP or an ASN derived from it — private addresses,
local hostnames, MACs, SSIDs and VPN routes are never sent anywhere.

External context is **supporting evidence**. The deterministic engine remains the
only thing that decides a fault domain.

See [Live Internet Data](docs/LIVE_INTERNET_DATA.md).

## v1.5 Network Change Assurance

Faultline can now treat repeated diagnostic runs as an explicit pre-change/post-change workflow rather than simply comparing the oldest and newest case evidence.

```text
Create change window
      |
Select baseline diagnostic
      |
Make network change
      |
Select post-change diagnostic
      |
Compare required behaviours
      |
Regression / improvement result
      |
Export change-assurance package
```

The comparison includes Connectivity Contract check transitions, IPv4/IPv6/TLS state changes, latency/loss/TLS/TTFB/path-MTU deltas, observed route changes and inferred topology changes. A worsening measurement is reported as a regression candidate, not proof of causation.

```text
POST /api/cases/:caseId/change-windows
POST /api/cases/:caseId/change-windows/:changeId/baseline
POST /api/cases/:caseId/change-windows/:changeId/post-change
GET  /api/cases/:caseId/change-windows/:changeId/comparison
GET  /api/cases/:caseId/change-windows/:changeId/evidence
```

The JavaScript SDK exposes the same change workflow. Change-assurance packages contain a SHA-256 integrity digest and the audit stream records creation, baseline selection and comparison outcome.

See [Network Change Assurance](docs/CHANGE_ASSURANCE.md).

## v1.4 Deeper diagnostics

The Node endpoint agent adds `telemetry.deepDiagnostics` by default: independent A/AAAA and IPv4/IPv6 TCP evidence, explicit TLS handshake/certificate/protocol data, HTTP stage timing/TTFB, and bounded Windows IPv4 path-MTU discovery. Use `--no-deep` to skip it.

The standalone packaged `Faultline.exe` still uses its self-contained collector and does not yet import this modular v1.4 collector. This limitation is explicit.

See [Deeper Diagnostics](docs/DEEP_DIAGNOSTICS.md).

## v1.3 Service Desk Integrations

Faultline can correlate a case with ServiceNow, Jira Service Management, Zendesk, HaloPSA, Freshservice, ConnectWise or a generic webhook integration intent. Generated update envelopes preserve the external ticket ID, deterministic fault-domain summary, evidence link and package digest. No third-party service-desk credential is persisted and this preview does not claim live vendor certification.

See [Service Desk Integrations](docs/SERVICE_DESK_INTEGRATIONS.md).

## v1.2 Embedded Diagnostics API + SDK

The v1 API lets a support application create a correlated case/diagnostic, add runs and retrieve status, evidence and case events. `sdk/faultline-client.mjs` provides a dependency-free client and `public/faultline-widget.js` provides a credential-free user launch component.

See [Embedded Diagnostics](docs/EMBEDDED_DIAGNOSTICS.md).

## Architecture

```text
Support portal / service desk
        |
   Faultline v1 API + SDK
        |
Platform / tenant control plane
        |
        +--> Contracts / cases / integrations
        +--> Change windows
        |
  endpoint agent + independent probes
        |
  baseline + deep protocol evidence
        |
 deterministic fault-domain diagnosis
        |
 evidence / Incident Intelligence / assurance comparison
        |
 cross-party escalation
```

## Design notes

- [Change Assurance](docs/CHANGE_ASSURANCE.md)
- [Deeper Diagnostics](docs/DEEP_DIAGNOSTICS.md)
- [Service Desk Integrations](docs/SERVICE_DESK_INTEGRATIONS.md)
- [Embedded Diagnostics](docs/EMBEDDED_DIAGNOSTICS.md)
- [Contract Catalog](docs/CONTRACT_CATALOG.md)
- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
- [Multi-Tenancy](docs/MULTI_TENANCY.md)
- [Network Bisect](docs/NETWORK_BISECT.md)
- [Live Internet Data](docs/LIVE_INTERNET_DATA.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Ephemeral diagnostics](docs/EPHEMERAL_DIAGNOSTICS.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Endpoint agent](docs/AGENT.md)
- [Remote probe](docs/REMOTE_PROBE.md)
- [Probe fleet](docs/PROBE_FLEET.md)
- [Fleet safety](docs/FLEET_SAFETY.md)
- [Topology](docs/TOPOLOGY.md)
- [Roadmap](ROADMAP.md)

## Run locally

Requires Node.js 20+.

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

## Security model

```text
Platform admin token      platform/development administration
Organization token        one organisation's tenant API
Diagnostic invitation     consent for one endpoint diagnostic
Launcher token            one exchange for endpoint access
Endpoint token            one short-lived evidence uploader
Registered probe token    one remote worker identity
Case-room token            one shared case and role
```

SDK credentials belong in the support application's backend. The user-facing widget receives only a one-time invitation URL. Service-desk credentials are not stored by Faultline.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

This remains a portfolio/research implementation rather than production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, v1 API authentication is not yet service-account scoped, vendor service-desk transports are adapter boundaries rather than live OAuth integrations, the Connectivity Contract evaluator remains target-scoped, deep v1.4 collection is currently in the Node endpoint agent rather than the packaged client, change-assurance regression labels are deterministic evidence comparisons rather than causal inference, and the packaged Windows client is unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant MVP architecture         complete preview
v1.1  Connectivity Contract Ecosystem       complete preview
v1.2  Embedded Diagnostics API + SDK        complete preview
v1.3  Service Desk Integrations             complete preview
v1.4  Deeper Network / Protocol Diagnostics complete preview
v1.5  Network Change Assurance              current preview
      Live Internet data + BYO environment  merged
v1.6  Incident Intelligence v2              next
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
