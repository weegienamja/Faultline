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

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## Architecture

```text
Support portal / service desk
        |
   Faultline v1 API + SDK
        |
        +--> ticket correlation / update envelope
        |
Platform / tenant control plane
        |
        +--> Connectivity Contract catalog
        +--> Support cases
                |
        +-------+------------------+
        |                          |
 Faultline.exe              Registered probes
 affected endpoint          independent vantages
        |                          |
        +------------+-------------+
                     |
            deterministic diagnosis
                     |
          evidence + Incident Intelligence
                     |
             cross-party room
```

## v1.3 Service Desk Integrations

Faultline can associate a support case with ServiceNow, Jira Service Management, Zendesk, HaloPSA, Freshservice, ConnectWise or a generic webhook integration intent.

```text
GET  /api/v1/integrations/service-desk/providers
POST /api/v1/diagnostics/:caseId/service-desk
GET  /api/v1/diagnostics/:caseId/service-desk
```

The generated update envelope contains the external ticket ID, deterministic fault-domain summary, confidence, latest session reference, redacted evidence link and evidence-package digest. It is designed to be consumed by a provider-specific transport rather than copying raw telemetry into a ticket.

Faultline does not persist third-party service-desk credentials and does not claim live vendor certification in this preview. HMAC signing helpers provide a safe boundary for later delivery workers/webhooks.

See [Service Desk Integrations](docs/SERVICE_DESK_INTEGRATIONS.md).

## v1.2 Embedded Diagnostics API + SDK

A support application can create and track a Faultline diagnostic without requiring an engineer to recreate the case in the dashboard.

```text
POST /api/v1/diagnostics
POST /api/v1/diagnostics/:caseId/runs
GET  /api/v1/diagnostics/:caseId
GET  /api/v1/diagnostics/:caseId/evidence
GET  /api/v1/diagnostics/:caseId/events
```

`externalRef` preserves the caller's own ticket/case identifier without influencing diagnosis. `sdk/faultline-client.mjs` provides the dependency-free client and `public/faultline-widget.js` provides a credential-free user launch component.

See [Embedded Diagnostics](docs/EMBEDDED_DIAGNOSTICS.md).

## v1.1 Connectivity Contract catalog

Published project contract versions are immutable snapshots. A changed requirement becomes a new draft version rather than mutating historical diagnostic meaning.

See [Contract Catalog](docs/CONTRACT_CATALOG.md) and [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md).

## Tenant boundary

The legacy `FAULTLINE_ADMIN_TOKEN` remains a platform/development credential. Tenant-facing access uses separate hashed `fl_org_...` credentials scoped to one organisation and its projects.

See [Multi-Tenancy](docs/MULTI_TENANCY.md).

## Other design notes

- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
- [Incident Intelligence](docs/INCIDENT_INTELLIGENCE.md)
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

The v1 API currently reuses the platform admin credential as a preview integration boundary. SDK credentials belong in the support application's backend. The user-facing widget receives only a one-time invitation URL. Service-desk credentials are not stored by Faultline.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

This remains a portfolio/research implementation rather than production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, v1 API authentication is not yet service-account scoped, service-desk provider transports are adapter boundaries rather than live OAuth integrations, the contract evaluator remains target-scoped, and the packaged Windows client is unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant MVP architecture         complete preview
v1.1  Connectivity Contract Ecosystem       complete preview
v1.2  Embedded Diagnostics API + SDK        complete preview
v1.3  Service Desk Integrations             current preview
v1.4  Deeper Network / Protocol Diagnostics next
v1.5  Network Change Assurance
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
