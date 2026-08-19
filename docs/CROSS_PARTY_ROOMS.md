# Cross-party incident rooms

Faultline v0.9 lets a case owner share scoped network evidence with another organisation without granting access to the Faultline control plane.

## Participant roles

```text
observer
  read the shared redacted case and evidence

contributor
  read the shared case and append comments/counter-evidence
```

An admin creates a participant invitation with:

```text
POST /api/cases/:caseId/participants
```

The response returns a high-entropy `fl_case_...` credential once. Only its hash is stored in the case record. Participant credentials expire after a bounded TTL and can be revoked independently.

## External room

The returned fragment link uses:

```text
/case-room#token=fl_case_...
```

The browser removes the token from the URL after reading it and keeps it in same-tab/session storage. The room calls:

```text
GET  /api/case-room
POST /api/case-room/contributions
```

The participant receives the case timeline and a `network-identifiers` redacted evidence package. This does not expose the admin token, endpoint credential, probe credential or raw case-room credential hash.

## Counter-evidence

A contributor can append:

- observation
- counter-evidence
- question
- resolution update

Every contribution records:

- participant identity
- organisation
- time
- contribution type
- human-readable summary
- optional small structured measurement set

Counter-evidence is recorded as externally observed evidence in the case timeline. Other contribution types are annotations.

## Diagnosis boundary

External evidence never silently replaces the deterministic diagnosis. Faultline preserves both the existing conclusion and the new contribution so an engineer can see where parties agree or disagree.

A later multi-vantage correlation milestone can use structured contributed measurements as another known vantage, but that must remain evidence-driven and explicit.

## Revocation

```text
POST /api/cases/:caseId/participants/:participantId/revoke
```

Revocation clears the stored token hash immediately. Expired or revoked participant credentials no longer resolve to a case.

## Current limitations

- participant identity is invitation-based rather than federated login
- no file attachments are accepted in the preview
- contributions do not automatically trigger a new diagnosis
- case-room access is one case at a time
- legal-grade chain of custody and signed evidence arrive later
