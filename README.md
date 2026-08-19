# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline is an incident-first portfolio/research prototype for the support gap that appears when a connectivity failure crosses ownership boundaries and no single team can see the complete path.

```text
endpoint -> LAN/Wi-Fi -> VPN/firewall -> ISP/Internet -> application/service
```

Faultline collects scoped evidence from affected endpoints and independent vantages, applies deterministic fault-domain reasoning, preserves evidence in support cases, identifies statistically similar incidents, and supports controlled sharing across organisations.

## Implemented previews

- v0.1-v0.7: deterministic diagnosis, Windows telemetry, remote correlation, authenticated control plane, probe fleet, one-time diagnostics, inferred topology and Connectivity Contracts
- Data Science: standardisation, evidence similarity, DBSCAN clustering and explicit outliers
- **v0.8:** support cases, multiple runs, evidence provenance, before/after comparison, redacted JSON and print-ready exports
- **v0.9:** scoped cross-party incident rooms with observer/contributor roles and counter-evidence provenance
- **v1.0:** organisation/project tenancy, tenant-scoped cases and rotatable/revocable organisation credentials

Faultline does **not** use an AI/LLM API in diagnosis or Incident Intelligence.

## Current architecture

```text
Platform admin
     |
     +--> Organizations
             |
             +--> Projects
                    |
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

## v1.0 tenant boundary

The legacy `FAULTLINE_ADMIN_TOKEN` remains a platform/development credential for existing workflows. Tenant-facing access uses separate `fl_org_...` credentials.

```text
POST /api/organizations              platform admin
GET  /api/organizations              platform admin
POST /api/organizations/:id/rotate   platform admin
POST /api/organizations/:id/revoke   platform admin

GET  /api/tenant                     organization credential
POST /api/tenant/projects
GET  /api/tenant/projects
POST /api/tenant/cases
GET  /api/tenant/cases
GET  /api/tenant/cases/:id
POST /api/tenant/cases/:id/diagnostics
GET  /api/tenant/cases/:id/evidence
```

Tenant cases carry explicit `organizationId` and `projectId` fields. A tenant credential cannot retrieve another organization's case. Legacy unscoped cases remain platform-admin only.

See [Multi-Tenancy](docs/MULTI_TENANCY.md).

## Other design notes

- [Architecture](docs/ARCHITECTURE.md)
- [Cases & Evidence Packages](docs/CASES_AND_EVIDENCE.md)
- [Cross-Party Incident Rooms](docs/CROSS_PARTY_ROOMS.md)
- [Connectivity Contracts](docs/CONNECTIVITY_CONTRACTS.md)
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

Then open `http://localhost:3000`.

## Security model

```text
Platform admin token      legacy/platform administration
Organization token        one organisation's tenant API
Diagnostic invitation     consent for one endpoint diagnostic
Launcher token            one exchange for endpoint access
Endpoint token            one short-lived evidence uploader
Registered probe token    one remote worker identity
Case-room token            one shared case and role
```

Raw organisation, endpoint, probe, invitation, launcher and case-room credentials are not persisted; hashes are stored instead.

## Tests

```bash
npm run check
npm test
```

CI also builds the Docker image and separately builds and executes the packaged Windows `Faultline.exe` self-test.

## Current limitations

This is still a portfolio/research implementation, not production SaaS. Persistence is a single-writer JSON store, tenant identity is credential-based rather than named-user SSO/RBAC, request limiting is not distributed, and the Windows client remains unsigned.

## Roadmap

```text
v0.8  Cases + Evidence Packages             complete preview
v0.9  Cross-Party Incident Rooms            complete preview
v1.0  Multi-Tenant Hosted MVP architecture  current
v1.1  Connectivity Contract Ecosystem       next
v1.2  Embedded Diagnostics API + SDK
v1.3  Service Desk Integrations
v1.4  Deeper Network / Protocol Diagnostics
v1.5  Network Change Assurance
```

See [ROADMAP.md](ROADMAP.md).

## License

MIT
