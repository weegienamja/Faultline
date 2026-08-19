# Embedded Diagnostics API and SDK

Faultline v1.2 preview exposes the existing case and diagnostic workflow through a stable developer-facing namespace.

## Design goal

A support portal should be able to create a diagnostic, correlate it to its own ticket/reference, hand the resulting one-time invitation to the affected user, and retrieve status/evidence without recreating the case manually in the Faultline dashboard.

The API is an adapter over the existing deterministic diagnostic engine. It does not create a second diagnosis path.

## API

The preview uses the existing admin bearer credential. A later production authentication layer can issue narrower service-account/API credentials without changing the resource model.

### Create an embedded diagnostic

`POST /api/v1/diagnostics`

```json
{
  "target": "https://example.com/health",
  "caseTitle": "Customer cannot reach service",
  "customer": "Example Ltd",
  "externalRef": "TICKET-1842",
  "ttlMinutes": 30,
  "ephemeral": true
}
```

The response includes the Faultline case/session identifiers and a one-time `/diagnose#invite=...` path. `externalRef` is preserved as a correlation value only; it does not influence diagnosis.

### Add another run

`POST /api/v1/diagnostics/:caseId/runs`

This is useful for retries, a different endpoint, or before/after evidence while keeping the same support case.

### Read status

`GET /api/v1/diagnostics/:caseId`

Returns case state, session count, completed run count and latest run timestamp.

### Read structured evidence

`GET /api/v1/diagnostics/:caseId/evidence`

Optional query: `?redaction=network-identifiers`.

### Read completion/evidence events

`GET /api/v1/diagnostics/:caseId/events`

The preview exposes the case timeline as a stable event envelope. v1.3 can use the same event model for support-system/webhook integrations.

## JavaScript SDK

`sdk/faultline-client.mjs` contains a dependency-free `FaultlineClient` wrapper:

```js
import { FaultlineClient } from "./sdk/faultline-client.mjs";

const faultline = new FaultlineClient({
  baseUrl: "https://faultline.example.com",
  token: process.env.FAULTLINE_API_TOKEN
});

const diagnostic = await faultline.createDiagnostic({
  target: "https://example.com",
  externalRef: "INC-12345"
});
```

The token belongs on the support application's backend, not in public browser JavaScript.

## Embeddable launch component

`public/faultline-widget.js` defines `<faultline-diagnostic-button>`.

It deliberately accepts an **already-created invitation URL** rather than an administrative credential:

```html
<script type="module" src="https://faultline.example.com/faultline-widget.js"></script>
<faultline-diagnostic-button
  invitation-url="https://faultline.example.com/diagnose#invite=fl_inv_..."
  label="Run network diagnostic">
</faultline-diagnostic-button>
```

That keeps case/session creation in the trusted support backend while giving a portal a reusable user-facing launch control.

## Security boundary

- API creation/retrieval is authenticated.
- The end-user widget receives only the one-time invitation URL.
- The browser still never receives the endpoint upload credential.
- Invitation consent and launcher-token exchange remain unchanged.
- External correlation identifiers do not affect the deterministic diagnosis.

## Current preview limitations

- the v1 API currently reuses the admin bearer credential instead of dedicated service-account scopes;
- completion events are pull/read endpoints, not outbound webhooks yet;
- the widget is intentionally minimal and does not create diagnostics itself;
- no vendor-specific ticketing connector is included in v1.2.
