# Cases and evidence packages

Faultline v0.8 introduces a persistent **support case** above individual diagnostic sessions.

A diagnostic session answers a narrow question at one point in time. A case represents the support incident that may require several measurements, engineer notes, another organisation and a before/after comparison.

## Case model

A case records:

- title, customer and affected service
- severity and lifecycle status
- tags
- attached diagnostic session IDs
- engineer notes
- evidence timeline
- optional resolution

Timeline entries identify the evidence class as one of:

- `observed`
- `inferred`
- `deterministic`
- `statistical`
- `annotation`

This avoids presenting topology inference or statistical similarity as if it were directly observed network evidence.

## API

Admin-authenticated routes:

```text
POST  /api/cases
GET   /api/cases
GET   /api/cases/:id
PATCH /api/cases/:id
POST  /api/cases/:id/notes
POST  /api/cases/:id/diagnostics
GET   /api/cases/:id/compare
GET   /api/cases/:id/evidence
GET   /api/cases/:id/report
```

`POST /api/cases/:id/diagnostics` creates an ephemeral endpoint diagnostic by default and links the new session to the case.

Endpoint and remote-probe submissions append provenance events to the case timeline automatically.

## Evidence package

The JSON evidence export uses schema:

```text
faultline.case-evidence / version 1
```

It separates:

```text
observed
  endpoint + remote measurements

inferred
  local topology evidence

deterministic
  Faultline fault-domain + Connectivity Contract result

statistical
  related-pattern evidence supplied by the incident-intelligence layer
```

It also includes session provenance and an earliest-versus-latest diagnostic comparison.

The package carries a canonical SHA-256 digest. This is an integrity aid for the exported artifact, not a cryptographic signature or legal chain-of-custody guarantee.

## Redaction

Exports support:

```text
none
network-identifiers
strict
```

The dashboard uses `network-identifiers` by default, removing fields such as local addresses, MAC addresses, BSSID/SSID and endpoint hostnames from the shareable export.

## HTML / PDF workflow

`GET /api/cases/:id/report` produces a print-friendly HTML evidence view. The engineer can inspect it and use the browser's Print to PDF function when a PDF is required.

Faultline deliberately does not add a server-side PDF dependency for this preview.

## Before / after comparison

When a case contains two or more completed diagnostic runs, Faultline compares the earliest and latest evidence for selected numerical metrics, deterministic fault domain and Connectivity Contract outcome.

This comparison becomes the foundation for the dedicated change-assurance workflow planned for v1.5.

## Current limitations

- case access is still under the single administrator domain in v0.8
- external participant access arrives in v0.9
- JSON remains the prototype persistence layer
- export integrity uses SHA-256 only; signed evidence packages are later work
- statistical evidence is not yet persisted into a case automatically
