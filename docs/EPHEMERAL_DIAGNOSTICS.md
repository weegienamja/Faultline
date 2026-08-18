# Ephemeral support diagnostics

Faultline v0.6 introduces a one-time support workflow for devices that are not already managed by the platform.

The design is intentionally different from permanent endpoint monitoring. A support engineer creates a short-lived diagnostic session, sends one invitation link to the affected user, and the user explicitly activates a one-time client handoff after reviewing the collection scope.

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
Browser receives one-use launcher secret
      |
      | .faultline handoff file
      v
Faultline.exe
      |
      | exchange launcher once
      v
Session-scoped endpoint credential
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

The form supports:

- target hostname or HTTP/HTTPS URL
- case title
- customer/support label
- diagnostic expiry
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

## Invitation secret

The raw invitation secret is generated once and stored by the control plane only as a SHA-256 hash.

The support link uses a URL fragment:

```text
https://faultline.example.com/diagnose#invite=fl_inv_...
```

The browser removes the fragment from the visible address after reading it and uses the secret only for invitation preview/claim requests.

The invitation cannot submit endpoint evidence.

## Consent and launcher handoff

The `/diagnose` page shows:

- case title and target
- session expiry
- network evidence Faultline will collect
- evidence Faultline explicitly does not collect
- an independent control to disable Network Map/topology collection

The endpoint upload credential does **not** exist before or during browser consent.

When the user consents:

1. Faultline verifies the invitation and session expiry
2. records `claimedAt` and `consentedAt`
3. stores the user's topology choice
4. invalidates the invitation hash
5. creates a separate `fl_launch_...` one-use launcher credential
6. stores only the launcher hash
7. returns the raw launcher secret once to the browser

The browser writes a handoff file such as:

```json
{
  "version": 1,
  "sessionId": "FL-...",
  "apiBase": "https://faultline.example.com",
  "launchToken": "fl_launch_...",
  "createdAt": "..."
}
```

The handoff is sensitive until exchanged because it contains a live bearer secret, but it cannot upload evidence directly.

## Windows client exchange

`Faultline.exe` locates the newest matching `.faultline` file in its working directory, executable directory or the user's Downloads directory.

It then sends:

```text
POST /api/client/exchange
Authorization: Bearer fl_launch_...

{
  "sessionId": "FL-..."
}
```

On success the control plane:

1. validates that the launcher belongs to that session
2. verifies session expiry
3. creates the `fl_ep_...` endpoint credential
4. stores only its hash
5. clears the launcher hash
6. records `exchangedAt`
7. returns the endpoint credential once to the native client

The same launcher cannot be exchanged again.

After exchange the client attempts to delete the `.faultline` file and proceeds with collection/upload.

## Browser/client separation

The browser has enough access to:

- preview the invitation
- record consent
- create the one-time launcher handoff

It does **not** receive the endpoint upload credential.

The native client has enough access to:

- exchange the launcher once
- run native Windows diagnostics
- upload endpoint evidence for that session

This keeps the browser invitation role, launcher role and endpoint role distinct.

## API summary

### Preview

```text
GET /api/invitations
Authorization: Bearer fl_inv_...
```

### Consent / claim

```text
POST /api/invitations/claim
Authorization: Bearer fl_inv_...
Content-Type: application/json

{
  "consent": true,
  "includeTopology": true
}
```

The response contains the one-use launcher secret, not the endpoint secret.

### Client exchange

```text
POST /api/client/exchange
Authorization: Bearer fl_launch_...
Content-Type: application/json

{
  "sessionId": "FL-..."
}
```

### Create session

Administrators use:

```json
{
  "target": "microsoft.com",
  "ttlMinutes": 60,
  "ephemeral": true
}
```

Registered probes can still be assigned with `assignedProbeId`.

## Threat model and current limits

- all invitation, launcher and endpoint credentials are bearer credentials; hosted deployments require HTTPS
- the `.faultline` file must be treated as sensitive until exchanged
- launcher secrets are one-use and stored only as hashes
- endpoint credentials are minted only inside the native-client exchange
- there is no platform-wide rate limiting yet
- Faultline remains a single-administrator prototype
- the Windows client is currently unsigned
- the public client download URL is deployment-configured
- topology can contain private LAN metadata, so the user can disable it before claim

The core principle remains narrow temporary support access: one support case, one expiry window, explicit consent, one launcher exchange and one role-scoped endpoint credential.
