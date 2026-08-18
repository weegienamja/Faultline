# Ephemeral support diagnostics

Faultline v0.6 introduces a one-time support workflow for devices that are not already managed by the platform.

The design is intentionally different from permanent endpoint monitoring. A support engineer creates a short-lived diagnostic session, sends one invitation link to the affected user, and the user explicitly activates endpoint access after reviewing the collection scope.

## Workflow

```text
Support engineer
      |
      | create one-time diagnostic
      v
Faultline control plane
      |
      | invitation link
      v
Affected user
      |
      | review + consent
      v
Invitation exchange
      |
      | one session-scoped endpoint token
      v
Windows collector
      |
      | endpoint + topology evidence
      v
Faultline session
      |
      +---- registered / one-off remote probe
      |
      v
Deterministic correlation
```

## Create from the dashboard

Unlock live data with the administrator credential and choose **New diagnostic**.

The form currently supports:

- target hostname or HTTP/HTTPS URL
- case title
- customer/support label
- 30 minute, 1 hour, 4 hour or 24 hour expiry
- optional registered-probe assignment

Faultline returns a one-time user link.

## Create from the CLI

```bash
npm run invite -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --title "Teams calls dropping" \
  --customer "ABC Ltd" \
  --ttl 60 \
  --admin-token "$FAULTLINE_ADMIN_TOKEN" \
  --api-base https://faultline.example.com
```

The CLI refuses to create a remote invitation link over plain HTTP. `http://localhost` remains allowed for local development.

## Invitation-secret handling

The raw invitation secret is generated once and stored by the control plane only as a SHA-256 hash.

The support link uses a fragment:

```text
https://faultline.example.com/diagnose#invite=fl_inv_...
```

URL fragments are handled by the browser and are not part of the normal HTTP request path. The browser removes the fragment from the address bar after reading it and uses the secret as a bearer credential only for the invitation API.

The invitation secret cannot submit endpoint evidence directly.

## Consent and claim

The `/diagnose` page shows:

- case title and target
- session expiry
- network evidence Faultline will collect
- evidence Faultline explicitly does not collect
- an independent control to disable Network Map/topology collection

The endpoint credential does not exist before consent.

When the user consents:

1. the control plane verifies the invitation secret
2. verifies that the session is still active
3. mints a new `fl_ep_...` endpoint credential
4. stores only its hash
5. records `claimedAt` and `consentedAt`
6. removes the invitation-secret hash
7. returns the raw endpoint credential once

The original invitation therefore cannot be claimed again.

## Current collector handoff

The current v0.6 preview returns the authenticated command required to run the existing Node.js Windows collector:

```powershell
npm run agent -- --session FL-1234567890 --token fl_ep_... --api-base https://faultline.example.com
```

If the user disables topology collection on the consent page, the generated command includes:

```text
--no-topology
```

This is the secure session/invitation foundation, but it is not yet the final zero-install user experience. The affected Windows device currently needs the Faultline repository and Node.js 20+ available.

A later v0.6 step should package the Windows collector so the user can launch the diagnostic without cloning the repository or handling a Node.js environment.

## API

### Preview an invitation

```text
GET /api/invitations
Authorization: Bearer fl_inv_...
```

This returns safe public session metadata and collection flags. It does not return endpoint credentials.

### Claim an invitation

```text
POST /api/invitations/claim
Authorization: Bearer fl_inv_...
Content-Type: application/json

{
  "consent": true
}
```

A successful response returns the endpoint credential once.

### Create an ephemeral session

Administrators use the existing session endpoint with:

```json
{
  "target": "microsoft.com",
  "ttlMinutes": 60,
  "ephemeral": true
}
```

Registered probes can still be assigned through `assignedProbeId`.

## Threat model and current limits

- invitation and endpoint credentials remain bearer credentials, so hosted deployments require HTTPS
- there is no platform-wide rate limiting yet
- this remains a single-administrator prototype
- an invitation is intentionally single-claim; losing the endpoint token after claim requires a new invitation
- the support page does not execute native Windows network commands from the browser
- topology can contain private LAN metadata, so users can disable topology before claiming the session

The core principle is that temporary support access should be narrower than permanent endpoint enrolment: one support case, one expiry window and one role-scoped endpoint credential.
