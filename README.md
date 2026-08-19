# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline is an incident-first portfolio/research prototype for connectivity failures that cross ownership boundaries and leave no single team with the complete evidence path.

```text
endpoint -> LAN/Wi-Fi -> VPN/firewall -> ISP/Internet -> application/service
```

Faultline collects scoped evidence from affected endpoints and independent vantages, applies deterministic fault-domain reasoning, preserves evidence in support cases, identifies statistically similar incidents, and supports controlled sharing across organisations.

## Implemented previews

- v0.1-v0.7: deterministic diagnosis, Windows telemetry, remote correlation, probe fleet, one-time diagnostics, topology and Connectivity Contracts
- Data Science: standardisation, evidence similarity, DBSCAN clustering and explicit outliers
- **v0.8:** support cases, multiple runs, provenance, before/after comparison and evidence exports
- **v0.9:** cross-party incident rooms with scoped external contributions
- **v1.0:** organisation/project tenancy with isolated cases and credential lifecycle
- **v1.1:** project-scoped Connectivity Contract catalog with version lifecycle and provenance
- **v1.2:** embedded diagnostics API, JavaScript SDK and end-user launch widget
- **v1.3:** service-desk ticket correlation and provenance-preserving update envelopes
- **v1.4:** dual-stack, explicit TLS, HTTP stage timing and bounded Windows path-MTU evidence

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## v1.4 Deeper diagnostics

The Node endpoint agent now adds `telemetry.deepDiagnostics` by default. It independently records A/AAAA resolution and IPv4/IPv6 TCP reachability, explicit TLS handshake/certificate/protocol evidence, client-side HTTP stage timings including TTFB, and a bounded Windows IPv4 path-MTU estimate.

Summary metrics include:

```text
ipv4Reachable
ipv6Reachable
tlsHandshakeOk
tlsHandshakeMs
targetTtfbMs
pathMtuBytes
```

Use `--no-deep` to skip this layer. The existing deterministic fault-domain rules remain authoritative; v1.4 adds evidence rather than inventing a second root-cause model.

The standalone packaged `Faultline.exe` still uses its self-contained collector and does not yet import this modular v1.4 collector. This limitation is explicit rather than claiming measurements the binary does not produce.

See [Deeper Diagnostics](docs/DEEP_DIAGNOSTICS.md).

## v1.3 Service Desk Integrations

Faultline can associate a case with ServiceNow, Jira Service Management, Zendesk, HaloPSA, Freshservice, ConnectWise or a generic webhook integration intent. Generated update envelopes include the external ticket ID, deterministic fault-domain summary, evidence link and evidence-package digest. No third-party credential is persisted and this preview does not claim live vendor certification.

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
        |
  endpoint agent + independent probes
        |
  baseline + deep protocol evidence
        |
 deterministic fault-domain diagnosis
        |
 evidence packages / Incident Intelligence / cross-party room
```

## Other design notes

- [Contract Catalog](docs/CONTRACT_CATALOG.md)
- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
- [Multi-Tenancy](docs/MULTI_TENANCY.md)
- [Windows client](docs/WINDOWS_CLIENT.md)
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

This remains a portfolio/research implementation rather than production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, v1 API authentication is not yet service-account scoped, vendor service-desk transports are adapter boundaries rather than live OAuth integrations, the Connectivity Contract evaluator remains target-scoped, deep v1.4 collection is currently in the Node endpoint agent rather than the packaged client, and the packaged Windows client is unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant MVP architecture         complete preview
v1.1  Connectivity Contract Ecosystem       complete preview
v1.2  Embedded Diagnostics API + SDK        complete preview
v1.3  Service Desk Integrations             complete preview
v1.4  Deeper Network / Protocol Diagnostics current preview
v1.5  Network Change Assurance              next
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
