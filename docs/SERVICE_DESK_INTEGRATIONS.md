# Service Desk Integrations

Faultline v1.3 preview connects the diagnostic case model to an engineer's existing support-ticket workflow without pretending the repository has live credentials for third-party SaaS systems.

## Integration targets

The provider registry currently models ServiceNow, Jira Service Management, Zendesk, HaloPSA, Freshservice, ConnectWise and a generic webhook target.

These entries represent supported **integration intents**, not claims that every vendor REST endpoint is implemented or certified.

## Workflow

```text
Support ticket
     |
     v
Faultline API creates correlated case
     |
     v
Affected user runs one-time diagnostic
     |
     v
Faultline produces deterministic diagnosis + evidence
     |
     v
Service-desk update envelope
     |
     v
Host connector posts summary/link into original ticket
```

A case may store:

- provider ID;
- external ticket ID;
- optional external ticket URL;
- optional display label.

No service-desk access token is persisted in the case object.

## API

List target provider profiles:

`GET /api/v1/integrations/service-desk/providers`

Attach ticket correlation:

`POST /api/v1/diagnostics/:caseId/service-desk`

```json
{
  "provider": "servicenow",
  "externalTicketId": "INC0012345",
  "externalTicketUrl": "https://support.example/incidents/INC0012345"
}
```

Build an update envelope:

`GET /api/v1/diagnostics/:caseId/service-desk`

The envelope contains a concise deterministic fault-domain summary, case status, latest session reference, redacted evidence-report link and evidence-package digest where available.

## Provenance

Faultline deliberately separates a support-system update from the underlying evidence. The envelope records that diagnosis is deterministic and includes the evidence-package digest so a copied ticket comment does not become the primary source of truth.

## Signed delivery envelope

`signIntegrationEnvelope()` and `verifyIntegrationEnvelope()` provide an HMAC-SHA256 envelope for a future delivery worker/webhook boundary.

The preview does not make arbitrary outbound HTTP requests from the control plane. That avoids turning the diagnostic server into an SSRF-capable webhook relay before destination policy and secret storage are designed properly.

## SDK

`FaultlineClient` adds:

- `getServiceDeskProviders()`
- `configureServiceDesk(caseId, input)`
- `getServiceDeskUpdate(caseId, options)`

## Current limitations

- vendor-specific OAuth/API transport is deliberately outside this preview;
- provider entries are not claims of vendor certification;
- outbound webhook retry/dead-letter delivery is not implemented;
- service-desk secrets are not stored by Faultline;
- the integration API still uses the preview v1 authentication boundary.
