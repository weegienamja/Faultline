# Faultline - Network Diagnostics & Troubleshooting

**Find the network condition that breaks a connection, without reconfiguring anything.**

Faultline is an open-source, local-first network troubleshooting and diagnostics tool for intermittent connectivity, DNS failures, IPv4/IPv6 differences, VPN routing problems, TLS issues and path-dependent network faults.

It is built around one question:

> What changed, which condition actually changes the outcome, and what evidence can I hand to the next person?

```bash
git clone https://github.com/weegienamja/Faultline-Network-Diagnostics.git
cd Faultline-Network-Diagnostics
npm install
npm run bisect -- github.com
```

No account. No cloud AI. No API key for the core workflow. No Docker required. Network Bisect makes real connections from your machine and varies conditions per connection rather than reconfiguring the host.

## Problems Faultline is built to investigate

Faultline is aimed at faults that are difficult to prove with a single ping or traceroute, especially when the outcome changes with network conditions.

Typical examples include:

- a website works on a mobile hotspot but fails on Wi-Fi
- IPv4 works while IPv6 fails, or the reverse
- changing DNS resolver changes whether a service resolves or connects
- a VPN is connected but an internal service is still unreachable
- one source interface works while another does not
- TLS, SNI or ALPN differences change the connection outcome
- an intermittent fault disappears before normal troubleshooting begins
- a network change appears related to a regression but needs evidence rather than assumption

See the [troubleshooting guides](docs/troubleshooting/README.md) for practical investigation paths.

## The product loop

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

The important boundary is that the first, second and fourth stages are deterministic evidence workflows. Faultline Analyst is optional interpretation and is never allowed to become the source of a finding.

## Why Faultline exists

When a service works on one network but not another, troubleshooting usually becomes a sequence of disruptive guesses:

```text
turn Wi-Fi off and on
try a hotspot
disconnect the VPN
change DNS
disable IPv6
try another machine
```

Those steps change the machine, often need admin rights, interrupt other traffic, and are usually not recorded. If something starts working, there is rarely a controlled retest to prove that the changed condition mattered.

Faultline tries to turn that process into an evidence problem instead.

## Network Bisect

`git bisect` finds the commit that changed a build. **Network Bisect** finds the network condition that changes whether a target works.

It can vary conditions such as:

- address family
- DNS resolver
- resolved address
- source interface
- TLS version
- ALPN
- SNI
- port

Conditions are applied per connection. The host network configuration is not rewritten.

The adaptive planner forms competing explanations, scores the experiment that best separates them, runs that experiment, eliminates explanations that no longer fit, and stops when the evidence has isolated a meaningful discriminator.

```text
Baseline
FAIL 3/3

Experiment
IPv4 only
PASS 3/3

Confirmation
A- B+ A- B+ A- B+

FAILURE CONDITION ISOLATED
Changing only the address family reproducibly changes FAIL to PASS.
```

The engine also refuses conclusions when the baseline is unstable, marks unreachable source interfaces as `INAPPLICABLE` instead of false failures, and distinguishes a target property from a local capability deficiency.

```bash
npm run bisect -- example.com
npm run bisect -- example.com --all
```

See [Network Bisect](docs/NETWORK_BISECT.md).

## Flight Recorder

Transient faults are difficult because the useful evidence has usually disappeared by the time troubleshooting starts.

The Flight Recorder keeps a bounded rolling window of lightweight network state. When a trigger fires, it freezes the evidence around the event and performs one deeper capture.

A recorded incident preserves:

- before, trigger, during and after chronology
- target reachability
- gateway and interface state
- IPv4 and IPv6 state
- resolver state
- observed changes between windows
- candidate conditions that Network Bisect can test
- explicit simulated provenance when a built-in scenario is used

An observed change is treated as a difference in time, not as proof of cause. Bisect remains the component that can establish that changing a condition changes the outcome.

```bash
npm run recorder -- example.com
npm run recorder -- --simulate ipv6-path-loss
```

See [Flight Recorder](docs/FLIGHT_RECORDER.md).

## Portable Incident Capsule

A completed incident can be exported as one self-contained HTML file.

The capsule can include:

- Recorder chronology
- deterministic comparisons
- Network Bisect experiments
- final conclusions
- evidence provenance
- redacted network identifiers
- a SHA-256 content integrity digest

It opens directly with `file://`, needs no Faultline server, and makes no external network requests.

```bash
npm run capsule -- FLR-2026-0001
npm run capsule -- FLR-2026-0001 --redaction network-identifiers
```

See [Portable Incident Capsule](docs/INCIDENT_CAPSULE.md).

## Live Diagnostics

Run `npm start`, open <http://localhost:3000>, unlock live data, and test a real target.

Faultline can collect:

```text
LOCAL        DNS, TCP, TLS, HTTP, ICMP, traceroute, adapter, Wi-Fi, VPN and DNS state
GLOBALPING   real measurements from independent public vantage points
RIPESTAT     prefix, origin ASN, holder, RPKI, RIS and BGP context
RIPE ATLAS   public probe availability around a network
IODA         outage and anomaly signals
PEERINGDB    self-published network metadata
CF RADAR     optional outage annotations
```

Only Cloudflare Radar needs a token. The other public sources are credential-free.

Public Internet context is supporting evidence. It does not move the deterministic fault-domain conclusion unless the input is itself an actual measurement wired into the deterministic comparison, such as an independent Globalping vantage.

Private addresses, local hostnames, MAC addresses, SSIDs and VPN routes are not sent to public enrichment services.

See [Live Internet Data](docs/LIVE_INTERNET_DATA.md).

## Faultline Analyst

Faultline Analyst is optional and local-only. It runs through Ollama and explains evidence already collected by Faultline.

The browser does not choose arbitrary models, hosts or tools. The server exposes a read-only evidence interface, validates citations against retrieved evidence, and keeps deterministic findings separate from Analyst hypotheses.

Faultline works without the Analyst and no cloud AI service is required anywhere in the product.

See [Faultline Analyst](docs/LOCAL_ANALYST.md).

## Evidence semantics

Faultline deliberately distinguishes different kinds of claims in both the data model and the interface:

| Class | Meaning |
|---|---|
| Observed | A real measurement or state read from a real system |
| Deterministic comparison | A fixed comparison between observed states |
| Deterministic rule finding | A conclusion produced by fixed rules over measurements |
| Deterministic experiment | Faultline varied a condition and measured the outcome |
| Simulated | Scripted scenario data, not a measurement of the user's network |
| Interpretation | Analyst explanation or hypothesis |

A deterministic rule finding is not presented as a controlled experiment. A temporal association is not presented as causation. Simulated evidence is never presented as measured evidence.

## Current dashboard

The current frontend is organised around the workflow rather than a long list of panels:

- **Capture:** Live Diagnostics and Flight Recorder
- **Isolate:** Network Bisect and Topology & Paths
- **Explain:** Faultline Analyst
- **Preserve:** Cases, Evidence and Change Assurance
- **Manage:** Environment, Probe Fleet and Settings

The UI uses cascade layers, intrinsic layouts and container queries so panels respond to the space they actually receive. Evidence classes have distinct visual semantics, and the Flight Recorder is organised around incident chronology rather than a generic monitoring dashboard.

See [Design system](docs/DESIGN_SYSTEM.md).

## Other implemented capabilities

The repository also includes:

- deterministic fault-domain diagnosis
- Windows endpoint telemetry
- registered remote probes
- one-time endpoint diagnostics
- inferred and observed topology views
- Connectivity Contracts
- support cases with provenance
- cross-party incident rooms
- organisation and project tenancy boundaries
- embedded diagnostics API and JavaScript SDK
- service-desk correlation envelopes
- dual-stack and deeper protocol diagnostics
- Network Change Assurance
- evidence similarity and DBSCAN clustering

These are useful supporting capabilities, but the centre of gravity is now the Capture -> Isolate -> Explain -> Preserve investigation loop.

## Run locally

Requires Node.js 20+.

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

Useful commands:

```bash
npm run bisect -- example.com
npm run recorder -- example.com
npm run recorder -- --simulate ipv6-path-loss
npm run capsule -- FLR-2026-0001
npm run check
npm test
```

## Troubleshooting guides

These guides describe common network failure patterns and show where Faultline can collect or isolate useful evidence:

- [Website works on a hotspot but not Wi-Fi](docs/troubleshooting/website-works-on-hotspot-not-wifi.md)
- [IPv4 works but IPv6 does not](docs/troubleshooting/ipv4-works-ipv6-does-not.md)
- [VPN connected but an internal service is unreachable](docs/troubleshooting/vpn-connected-internal-service-unreachable.md)
- [Diagnosing intermittent network failures](docs/troubleshooting/intermittent-network-failures.md)

The guides deliberately avoid treating correlation as proof. If changing a condition appears to restore connectivity, Network Bisect can retest that condition under controlled alternation before Faultline reports a discriminator.

## Architecture

```text
                 optional local Analyst
                         |
                         v
endpoint -> observed evidence -> deterministic diagnosis
   |                             |
   |                             +-> Network Bisect experiments
   |                             |
   +-> Flight Recorder           +-> Cases / Contracts / Change Assurance
             |                                  |
             +---------------------------> Incident Capsule

registered probes and public measurement vantages can add independent evidence
public routing and outage sources remain supporting context
```

## Security model

```text
Platform admin token      platform/development administration
Organization token        one organisation's tenant API
Diagnostic invitation     consent for one endpoint diagnostic
Launcher token            one exchange for endpoint access
Endpoint token            one short-lived evidence uploader
Registered probe token    one remote worker identity
Case-room token           one shared case and role
```

The optional Analyst reuses the platform admin boundary, accepts only a validated loopback Ollama endpoint, and exposes read-only tools.

SDK credentials belong in the support application's backend. The end-user widget receives only a one-time invitation URL. Service-desk credentials are not stored by Faultline.

## Current limitations

Faultline is an early-stage open-source network diagnostics project rather than a production SaaS platform.

Important limitations include:

- persistence is a single-writer JSON store
- tenant identity is credential-based rather than named-user SSO/RBAC
- the packaged Windows client still has a separate self-contained collector from the modular Node endpoint collector
- Linux and macOS collection do not yet have Windows parity
- several vendor integration surfaces are adapter boundaries rather than live vendor-certified OAuth integrations
- change-assurance regression labels describe evidence differences, not causal inference
- the packaged Windows client is unsigned
- Analyst retained evidence is process-local and its suggestions are hypotheses rather than findings

## What is next

The roadmap is now capability-first rather than version-number-first.

The highest-priority next feature is **Path Diff**: after Network Bisect isolates a discriminator, Faultline should compare the working and failing paths and show where they observably diverge without claiming that the first hidden or different hop is automatically the cause.

After that, the current direction includes multi-vantage **Faultline Witness**, evidence topology with a Recorder time scrubber, a bounded handshake microscope, a richer Fault Lab, and broader platform parity.

See [ROADMAP.md](ROADMAP.md).

## Design and implementation notes

- [Design system](docs/DESIGN_SYSTEM.md)
- [Network Bisect](docs/NETWORK_BISECT.md)
- [Flight Recorder](docs/FLIGHT_RECORDER.md)
- [Portable Incident Capsule](docs/INCIDENT_CAPSULE.md)
- [Faultline Analyst](docs/LOCAL_ANALYST.md)
- [Live Internet Data](docs/LIVE_INTERNET_DATA.md)
- [Change Assurance](docs/CHANGE_ASSURANCE.md)
- [Deeper Diagnostics](docs/DEEP_DIAGNOSTICS.md)
- [Embedded Diagnostics](docs/EMBEDDED_DIAGNOSTICS.md)
- [Service Desk Integrations](docs/SERVICE_DESK_INTEGRATIONS.md)
- [Contract Catalog](docs/CONTRACT_CATALOG.md)
- [Cases and Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
- [Endpoint agent](docs/AGENT.md)
- [Remote probe](docs/REMOTE_PROBE.md)
- [Probe fleet](docs/PROBE_FLEET.md)
- [Fleet safety](docs/FLEET_SAFETY.md)
- [Topology](docs/TOPOLOGY.md)
- [Troubleshooting guides](docs/troubleshooting/README.md)

## Tests

```bash
npm run check
npm test
```

The current suite contains 453 tests, with 451 passing and 2 skipped at the time of the frontend modernisation merge.

## License

MIT
