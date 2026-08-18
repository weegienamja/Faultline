# Probe fleet scheduling and safety

Faultline v0.6C adds automatic registered-probe selection and a hard distinction between **public** and **private** probe identities.

The purpose is to make remote-vantage selection automatic without turning a hosted Faultline fleet into an arbitrary network scanner.

## Probe scopes

### Public probes

A public probe is intended to test Internet-routable services from an independent external vantage.

Public probes enforce target policy locally in the worker. The control plane also performs early checks for literal targets, but worker-side enforcement is authoritative because DNS and redirects can change after a session is created.

Public probes currently allow TCP targets on:

```text
53
80
443
853
8080
8443
```

The allow-list is deliberately conservative for the v0.6 preview.

Public probes reject address space including:

- loopback
- RFC1918 private IPv4
- link-local
- CGNAT/shared space
- multicast
- reserved/documentation ranges
- IPv6 unique-local and link-local
- IPv4-mapped IPv6 that resolves back to blocked IPv4
- the well-known IPv4 translation prefix

The policy also explicitly blocks cloud-metadata-style link-local destinations such as `169.254.169.254` as part of the link-local range.

### Private probes

A private probe is an explicitly trusted vantage intended for an organisation-controlled internal network.

Private probes may target private address space and non-public ports. They should therefore only be deployed where that wider reach is intentional and authorised.

Register one with:

```bash
npm run probe:register -- \
  --name office-lan \
  --location "Glasgow office" \
  --country gb \
  --region scotland \
  --scope private \
  --tags internal,office \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

## Connection-time validation

For a public probe, target validation happens immediately before connection.

The worker:

1. validates the requested port
2. resolves all addresses for the hostname
3. rejects the entire answer set if any resolved address is blocked
4. connects TCP directly to a validated resolved address
5. performs HTTP using a validated address while preserving the original Host/TLS server name
6. follows redirects manually
7. resolves and validates the redirect destination again before connecting

This avoids relying on a single validation performed when the support session was created.

Mixed public/private DNS answer sets are rejected rather than selecting only the apparently safe address.

## Automatic scheduling

A session can request a probe selector instead of an explicit `PRB-...` ID:

```json
{
  "probeSelector": {
    "scope": "public",
    "country": "gb",
    "region": "europe-west",
    "tags": ["uk"]
  }
}
```

All selector fields except `scope` are optional. Scope defaults to `public`.

The scheduler considers only probes that are:

- enabled
- not revoked
- not in maintenance
- not draining
- currently `online`
- matching the requested scope/country/region/tags

Among matching candidates, Faultline chooses the probe with the fewest currently assigned unfinished sessions. Ties are resolved by most recent heartbeat and then stable probe ID ordering.

The selection metadata is persisted with the diagnostic session so an engineer can see whether the probe was assigned explicitly or automatically.

## Dashboard behaviour

The **New diagnostic** workflow now defaults to:

```text
Automatic · best online public probe
```

An engineer can still explicitly choose a registered probe or choose the one-off/assign-later path.

## CLI selectors

The invitation CLI also defaults to automatic public-probe selection.

Examples:

```bash
npm run invite -- \
  --target microsoft.com \
  --probe-country gb \
  --probe-region europe-west \
  --probe-tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Explicit override:

```bash
npm run invite -- --target microsoft.com --probe PRB-ABC123 --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

One-off fallback:

```bash
npm run invite -- --target microsoft.com --one-off-probe --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

## Lifecycle controls

Registered probes now support:

- enable/disable
- drain mode
- maintenance mode
- scope/country/region/tag updates
- credential rotation
- credential revocation

### Update lifecycle

```text
PATCH /api/probes/:id
Authorization: Bearer <admin>
```

Example:

```json
{
  "draining": true
}
```

A draining probe can continue authenticating and finish work that was already assigned, but the scheduler will not give it new sessions.

Maintenance probes remain registered and can heartbeat, but their job queue is withheld and they are excluded from scheduling.

### Rotate credential

```text
POST /api/probes/:id/rotate
Authorization: Bearer <admin>
```

The old credential becomes invalid immediately. The replacement raw credential is returned once and only its hash is persisted.

### Revoke credential

```text
POST /api/probes/:id/revoke
Authorization: Bearer <admin>
```

Revocation clears the stored token hash and disables the identity.

## Audit events

Faultline persists a bounded lifecycle audit log for events including:

- probe registration
- lifecycle changes
- credential rotation
- revocation
- session assignment

Administrators can inspect it at:

```text
GET /api/audit
```

The JSON prototype store is now state format v3. Existing v2 stores are normalised automatically and gain an empty audit collection.

## Resource controls

Current v0.6 protections include:

- 1 MB API request-body limit
- maximum 20 jobs returned per probe poll
- authenticated registered-probe submission rate limit
- bounded TCP/HTTP timeouts
- HTTP response bodies are not downloaded by remote probes
- maximum redirect count
- public port allow-list

These controls are intentionally conservative rather than pretending the prototype is a production-grade abuse-prevention system.

## Remaining production work

Before operating a large public fleet, Faultline still needs stronger controls such as distributed/rate-limit persistence, organisation quotas, per-target abuse controls, production audit identity, probe ownership boundaries, signed releases and production secrets management.

The core v0.6 rule is simpler: **a public probe must never trust a target merely because the control plane handed it a job. The probe validates the destination itself immediately before connecting.**
