# Connectivity Contract catalog

Faultline v1.1 turns Connectivity Contracts from three built-in examples into a project-scoped, versioned catalog.

## Lifecycle

```text
draft -> published -> deprecated
```

A published contract snapshot is not edited in place. To change requirements, clone it into a new draft version, modify that draft, then publish the new version.

Project tenant routes:

```text
GET  /api/tenant/projects/:projectId/contracts
POST /api/tenant/projects/:projectId/contracts
POST /api/tenant/projects/:projectId/contracts/:entryId/publish
POST /api/tenant/projects/:projectId/contracts/:entryId/deprecate
POST /api/tenant/projects/:projectId/contracts/:entryId/clone
GET  /api/tenant/projects/:projectId/published-contracts/:contractId
```

A case diagnostic can select a published project contract using `catalogContractId` and optionally `catalogContractVersion`. Faultline copies the resolved contract into the diagnostic session, retaining the existing reproducible snapshot behaviour.

## Provenance

Catalog entries can record:

- source
- reference URL
- verifier label
- notes

These fields document where requirements came from. They do not magically make a profile vendor-certified.

## Vendor profiles

The repository deliberately does not invent Microsoft, Cisco, Slack or other service requirements. Vendor-specific profiles should only be added after their networking requirements are checked against current primary documentation.

## Scope

Catalogs are stored on a tenant project. An organisation credential cannot use or enumerate another organisation's project catalog.

## Current limitations

- the catalog is stored in the prototype JSON project record
- there is no marketplace/public registry
- there is no cryptographic signing of profiles
- the Windows evaluator is still target-scoped
- multi-endpoint service profiles are a later extension
