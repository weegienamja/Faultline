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
network *condition* that changes whether a target works — and it **chooses which
experiment to run next** instead of sweeping every test.

It varies conditions **per connection**, so the machine is never reconfigured:
address family, DNS resolver, resolved address, source interface, TLS version,
ALPN, SNI, port.

```text
  Baseline
  FAIL 3/3 — ECONNREFUSED

  Baseline fails consistently. Isolating which condition changes that.

  [1] IP address family: IPv4 only
      Highest discrimination score (6.6). Separates 10 live explanations into
      3 predicted outcomes (3/3/4).
      PASS 3/3 — HTTP 200

  Confirming (interleaved A/B; A = baseline)
      A- B+ A- B+ A- B+   held under alternation

  FAILURE CONDITION ISOLATED
  IP address family: IPv4 only changes FAIL to PASS

  Evidence supports a fault specific to ip address family. Changing only that
  condition reproducibly restores the connection.

  Experiments: 1 executed, 1 skipped as low-value, 0 inapplicable.
  12 real connection attempts. Stopping reason: ISOLATED.
```

**One experiment. Twelve connections.** The exhaustive sweep needs 33 for the
same target — and `--all` still gives you that when you want a full audit.

## Why this isn't just ping, traceroute, MTR or curl

Those tell you *that* a path is bad. They cannot tell you *which condition* makes
the difference, and they mislead you when a fault is intermittent. The engine is
built around exactly those failure modes:

- **It reasons about what to test next.** Every live explanation predicts an
  outcome for each candidate experiment. The engine runs the one that best
  *partitions* them, using the expected size of the surviving explanation set.
  A 3/3 split beats a 1/5 split. There are no probabilities and no model —
  [the formula is documented and tested](docs/NETWORK_BISECT.md).
- **It refuses bad conclusions.** An unstable baseline gets isolation *refused*
  with the flake rate reported, rather than blaming whichever variant happened to
  run during a good patch.
- **It controls for time.** Candidates are re-tested `A B A B`; a network that
  recovers mid-run shows up as *unconfirmed*, not as a cure.
- **It knows what is not evidence.** A host-only adapter with no route to the
  target is `INAPPLICABLE`, decided from the routing table — not a `FAIL` that
  competes with genuine findings.
- **It won't invent a fault.** With a healthy baseline the run becomes a
  *capability analysis*: `github.com` having no AAAA record is reported as a
  target property, while `example.com` having AAAA that this host cannot reach is
  reported as a local deficiency. Different conclusions, different evidence.

## Exit codes

```text
0  no fault / target property     2  failure was not condition-specific
1  a condition was isolated       3  evidence insufficient (intermittent/unconfirmed)
4  the run could not be performed
```

Adaptive planning is the default; `--all` runs the complete condition matrix.

## The rest of Faultline

Bisect is the fastest way in. Behind it is an evidence-based fault-isolation
control plane: run `npm start` and open <http://localhost:3000>.

```bash
npm start                          # dashboard on :3000
npm run bisect -- example.com      # condition isolation, no server needed
npm run recorder -- example.com    # rolling capture of a transient fault
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

An optional **[Faultline Analyst](docs/LOCAL_ANALYST.md)** explains that evidence
in natural language. It runs locally through Ollama, reads through read-only
tools, produces no findings of its own, and no cloud AI is involved. Faultline
works identically without it.

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
- **Network Bisect:** adaptive fault isolation — competing hypotheses, deterministic experiment selection, reproducibility gating and paired confirmation

- **Flight Recorder:** bounded in-memory capture of the minutes around a fault — before/during/after windows, observed differences, and candidate conditions handed to Network Bisect
- **Faultline Analyst:** optional local-only AI that explains evidence, cites it, and is architecturally barred from producing findings

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence,
and never uses a cloud AI service anywhere.

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

- [Design system](docs/DESIGN_SYSTEM.md)
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
- [Flight Recorder](docs/FLIGHT_RECORDER.md)
- [Faultline Analyst (local AI)](docs/LOCAL_ANALYST.md)
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

The optional Analyst adds no credential. Its routes reuse the platform admin
token, its only outbound destination is a validated loopback Ollama endpoint,
its tools are read-only, and cloud-backed models are excluded from use. See
[Faultline Analyst](docs/LOCAL_ANALYST.md#security-boundaries).

SDK credentials belong in the support application's backend. The user-facing widget receives only a one-time invitation URL. Service-desk credentials are not stored by Faultline.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

This remains a portfolio/research implementation rather than production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, v1 API authentication is not yet service-account scoped, vendor service-desk transports are adapter boundaries rather than live OAuth integrations, the Connectivity Contract evaluator remains target-scoped, deep v1.4 collection is currently in the Node endpoint agent rather than the packaged client, change-assurance regression labels are deterministic evidence comparisons rather than causal inference, the packaged Windows client is unsigned, and the optional local Analyst
explains evidence rather than determining anything — its retained evidence is
per-process and its suggestions are hypotheses, not findings.

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
