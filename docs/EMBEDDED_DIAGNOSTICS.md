# Embedded diagnostics API and SDK

Faultline v1.2 lets a support product create scoped diagnostics without exposing an organisation administrator credential.

## Project API keys

Organisation admins create API keys beneath a project. Keys are opaque `fl_api_...` credentials and are stored only as hashes.

Available scopes:

```text
diagnostics:create
diagnostics:read
cases:read
evidence:read
```

Management routes use the organisation credential:

```text
POST /api/tenant/projects/:projectId/api-keys
GET  /api/tenant/projects/:projectId/api-keys
POST /api/tenant/projects/:projectId/api-keys/:keyId/revoke
```

## Versioned API

Project API keys use:

```text
POST /api/v1/diagnostics
GET  /api/v1/diagnostics/:sessionId
GET  /api/v1/cases/:caseId
GET  /api/v1/cases/:caseId/evidence
POST /api/v1/embed-tokens
```

The API enforces project ownership of cases/sessions as well as the requested key scope.

## Server-side SDK

`sdk/faultline.mjs` contains a dependency-free `FaultlineClient` wrapper:

```js
import { FaultlineClient } from "./sdk/faultline.mjs";

const faultline = new FaultlineClient({
  baseUrl: "https://faultline.example.com",
  apiKey: process.env.FAULTLINE_API_KEY
});

const diagnostic = await faultline.createDiagnostic({
  target: "https://service.example.com/health",
  catalogContractId: "secure-web"
});
```

The API key belongs on the server, not in browser JavaScript.

## Browser embed flow

A server holding the project API key can mint a one-use `fl_embed_...` token:

```text
POST /api/v1/embed-tokens
```

The token is bound to a diagnostic target, expires within 30 minutes, and is consumed by:

```text
POST /api/embed/diagnostics
```

`public/faultline-widget.js` provides a small Web Component that can consume that one-use token and open the resulting endpoint invitation.

Example:

```html
<script type="module" src="https://faultline.example.com/faultline-widget.js"></script>
<faultline-diagnostic-button
  token="ONE_USE_EMBED_TOKEN"
  label="Run connection diagnostic">
</faultline-diagnostic-button>
```

The widget must receive a freshly minted embed token from the embedding product's backend. It must never contain a project API key.

## Current limitations

- no OAuth client-credentials flow yet
- API keys are project credentials, not named service accounts
- no idempotency-key persistence in this preview
- no usage metering/billing
- embed token creates a new case unless a scoped existing case ID was supplied when it was minted
