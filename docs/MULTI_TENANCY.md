# Multi-tenant MVP preview

Faultline v1.0 introduces explicit organization and project boundaries without pretending the JSON prototype is production SaaS infrastructure.

## Organization credential

A platform administrator creates an organization through:

```text
POST /api/organizations
```

The response returns a `fl_org_...` credential once. Only its SHA-256 hash is stored. Credentials can be rotated or revoked independently.

The legacy `FAULTLINE_ADMIN_TOKEN` remains a platform/development administrator credential so existing diagnostic and probe workflows stay compatible.

## Project scope

Each organization can contain projects. Tenant-facing cases are created inside one project and carry both:

```text
organizationId
projectId
```

Tenant APIs verify those fields before returning a case. A valid credential for organization A cannot fetch a case belonging to organization B.

## Tenant API

```text
GET  /api/tenant
POST /api/tenant/projects
GET  /api/tenant/projects
POST /api/tenant/cases
GET  /api/tenant/cases
GET  /api/tenant/cases/:id
POST /api/tenant/cases/:id/diagnostics
GET  /api/tenant/cases/:id/evidence
```

Evidence returned to a tenant uses network-identifier redaction by default.

## Platform administration

```text
POST /api/organizations
GET  /api/organizations
POST /api/organizations/:id/rotate
POST /api/organizations/:id/revoke
```

## Persistence

Prototype state schema v5 adds:

```text
organizations[]
projects[]
```

Existing v0.x state migrates by adding empty tenant collections. Legacy unscoped cases remain accessible to the platform administrator but are not automatically exposed through a tenant credential.

## Security boundary

The v1.0 preview demonstrates authorization scope, credential lifecycle and data isolation. It does not claim production-grade identity or storage.

Still future work:

- database-backed row-level tenancy
- named users and per-user RBAC
- OIDC/SAML/SCIM
- distributed request limiting
- managed key storage
- HA database/queue architecture
- formal penetration testing
