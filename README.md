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

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## Architecture

```text
Platform admin
     |
     +--> Organizations
             |
             +--> Projects
                    |
                    +--> Connectivity Contract catalog
                    +--> Support cases
                            |
             +--------------+---------------+
             |                              |
      Faultline.exe                 Registered probes
      affected endpoint             independent vantages
             |                              |
             +--------------+---------------+
                            |
                   deterministic diagnosis
                            |
          +-----------------+-----------------+
          |                                   |
   evidence package                    Incident Intelligence
          |
   cross-party room
```

## v1.1 Connectivity Contract catalog

Contracts can now live inside a tenant project rather than only as repository built-ins.

```text
draft -> published -> deprecated
```

Published versions are treated as snapshots. A changed requirement is created as a new draft version rather than mutating a published version in place.

```text
GET  /api/tenant/projects/:projectId/contracts
POST /api/tenant/projects/:projectId/contracts
POST /api/tenant/projects/:projectId/contracts/:entryId/publish
POST /api/tenant/projects/:projectId/contracts/:entryId/deprecate
POST /api/tenant/projects/:projectId/contracts/:entryId/clone
GET  /api/tenant/projects/:projectId/published-contracts/:contractId
```

A case diagnostic may reference `catalogContractId` and optional `catalogContractVersion`; the selected published contract is copied into the diagnostic session for reproducibility.

Catalog entries can store provenance such as source, reference URL, verifier label and notes. Faultline does not claim a profile is vendor-certified merely because these fields exist, and the repo deliberately avoids invented Microsoft/Cisco/Slack requirements.

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

Raw organisation, endpoint, probe, invitation, launcher and case-room credentials are not persisted.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

This remains a portfolio/research implementation rather than production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, the contract evaluator remains target-scoped, and the packaged Windows client is unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant MVP architecture         complete preview
v1.1  Connectivity Contract Ecosystem       current
v1.2  Embedded Diagnostics API + SDK        next
v1.3  Service Desk Integrations
v1.4  Deeper Network / Protocol Diagnostics
v1.5  Network Change Assurance
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
