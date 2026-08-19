# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline is an incident-first portfolio/research prototype for connectivity failures that cross ownership boundaries and leave no single team with the complete evidence path.

```text
endpoint -> LAN/Wi-Fi -> VPN/firewall -> ISP/Internet -> application/service
```

Faultline collects scoped endpoint and independent-vantage evidence, applies deterministic fault-domain reasoning, preserves evidence in support cases, identifies statistically similar incidents, and supports controlled sharing across organisations.

## Implemented previews

- v0.1-v0.7: deterministic diagnosis, Windows telemetry, remote correlation, probe fleet, one-time diagnostics, topology and Connectivity Contracts
- Data Science: evidence standardisation, similarity, DBSCAN clustering and explicit outliers
- **v0.8:** cases, multiple runs, provenance, comparison and evidence exports
- **v0.9:** cross-party incident rooms and external counter-evidence
- **v1.0:** organisation/project tenancy and scoped credential lifecycle
- **v1.1:** project Connectivity Contract catalog with immutable published versions
- **v1.2:** project API keys, versioned embedded-diagnostics API, dependency-free SDK and one-use browser embed tokens

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## Architecture

```text
Organization / Project
       |
       +--> Contract catalog
       +--> Project API keys ----> SDK / support backend
       |                              |
       |                         one-use embed token
       |                              |
       +--> Support cases <------ embedded widget
                |
       +--------+--------+
       |                 |
 Faultline.exe       Remote probes
       |                 |
       +--------+--------+
                |
      deterministic diagnosis
                |
     evidence + incident intelligence
                |
        cross-party room
```

## v1.2 Embedded Diagnostics

Project API keys are opaque `fl_api_...` credentials stored only as hashes. Supported scopes are:

```text
diagnostics:create
diagnostics:read
cases:read
evidence:read
```

Versioned API:

```text
POST /api/v1/diagnostics
GET  /api/v1/diagnostics/:sessionId
GET  /api/v1/cases/:caseId
GET  /api/v1/cases/:caseId/evidence
POST /api/v1/embed-tokens
```

`sdk/faultline.mjs` provides a dependency-free `FaultlineClient` for server-side use.

Browser integrations must **not** receive a project API key. A backend mints a short-lived, target-scoped `fl_embed_...` token and passes only that one-use credential to `public/faultline-widget.js`. The widget consumes it through `POST /api/embed/diagnostics` and opens the resulting consent invitation.

See [Embedded Diagnostics](docs/EMBEDDED_DIAGNOSTICS.md).

## Connectivity Contract catalog

Tenant projects support draft, published and deprecated contract versions. Published snapshots are not edited in place; a changed requirement becomes a new draft version. Provenance fields document where requirements came from without implying vendor certification.

See [Contract Catalog](docs/CONTRACT_CATALOG.md).

## Tenant boundary

The legacy `FAULTLINE_ADMIN_TOKEN` remains a platform/development credential. Tenant-facing organisation access uses hashed `fl_org_...` credentials, while embedded application access uses narrower project API keys.

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

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

Requires Node.js 20+.

## Security credentials

```text
Platform admin token      platform/development administration
Organization token        one organisation's tenant API
Project API key           scoped embedded/server integration
Embed token               one target, short TTL, one use
Diagnostic invitation     consent for one endpoint diagnostic
Launcher token            one exchange for endpoint access
Endpoint token            one short-lived evidence uploader
Registered probe token    one remote worker identity
Case-room token            one shared case and role
```

Raw organization, API, embed, endpoint, probe, invitation, launcher and case-room credentials are not persisted.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

Faultline remains a portfolio/research implementation, not production SaaS. Persistence is a single-writer JSON store, identity is credential-based rather than named-user SSO/RBAC, API usage is not metered, embed/API idempotency is not yet persisted, the contract evaluator remains target-scoped, and the Windows client is unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant MVP architecture         complete preview
v1.1  Connectivity Contract Ecosystem       complete preview
v1.2  Embedded Diagnostics API + SDK        current
v1.3  Service Desk Integrations             next
v1.4  Deeper Network / Protocol Diagnostics
v1.5  Network Change Assurance
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
