# Faultline Connectivity Contracts

Connectivity Contracts describe the network conditions an application path requires instead of treating every diagnostic as a single generic reachability test.

The v0.7 preview deliberately keeps the format small and deterministic. It does not use an AI or LLM API.

## Why they exist

A support ticket such as "the application is down" can hide different failures:

- the hostname does not resolve
- the required TCP port cannot be reached
- HTTPS cannot establish a usable TLS-backed request
- the server answers, but the HTTP path fails

Faultline already isolates broad fault domains. A Connectivity Contract adds a second question:

> Which required application connectivity condition failed?

## Contract snapshot model

A contract is versioned and copied into the diagnostic session when the session is created.

This matters because a later change to the profile must not silently reinterpret old evidence.

Example:

```json
{
  "id": "secure-web",
  "version": 1,
  "name": "Secure web service",
  "description": "Checks the DNS, TCP, TLS and HTTP conditions required to reach a conventional HTTPS service.",
  "checks": [
    { "id": "dns", "type": "dns", "label": "DNS resolution", "required": true, "host": "$target.host" },
    { "id": "tcp", "type": "tcp", "label": "TCP connection", "required": true, "host": "$target.host", "port": "$target.port" },
    { "id": "tls", "type": "tls", "label": "TLS handshake", "required": true, "host": "$target.host", "port": "$target.port" },
    { "id": "http", "type": "http", "label": "HTTP response", "required": true, "url": "$target.url", "maxStatus": 499 }
  ]
}
```

Supported preview check types are:

| Type | Meaning |
|---|---|
| `dns` | target hostname resolves |
| `tcp` | requested target TCP connection succeeds |
| `tls` | an HTTPS request proves a usable TLS-backed transaction occurred |
| `http` | an HTTP response is received within the configured status ceiling |

The initial profile evaluator is intentionally target-scoped. Built-in checks use `$target.host`, `$target.port` and `$target.url`. Multi-endpoint vendor profiles are future work.

## Built-in profiles

The repository ships three generic profiles:

- `basic-reachability`
- `secure-web`
- `web-api`

These are generic examples. They do not claim to represent Microsoft, Cisco, Slack or any other vendor's published network requirements.

The same profiles are exposed to the browser in `public/contracts.json` and defined for CLI/server validation in `src/contracts/registry.mjs`.

## Engineer workflow

The **New diagnostic** dialog loads the built-in profiles and defaults to Basic reachability. The engineer can select another profile or choose no contract.

CLI:

```bash
npm run invite -- --list-contracts
```

Then:

```bash
npm run invite -- \
  --target https://example.com/health \
  --contract secure-web \
  --admin-token "$FAULTLINE_ADMIN_TOKEN" \
  --api-base https://faultline.example.com
```

The complete contract snapshot is stored on the session and is visible to the affected user before consent.

## Endpoint evaluation

The v0.7 preview evaluates built-in contracts in the packaged Windows client using the measurements it already collects.

For a Secure web service contract:

```text
DNS measurement
      |
TCP measurement
      |
HTTPS transaction
      +---- proves TLS-backed request reached HTTP layer
      |
HTTP status
      |
      v
Connectivity Contract result
```

The result contains:

```json
{
  "contract": {
    "id": "secure-web",
    "version": 1,
    "name": "Secure web service"
  },
  "requiredChecks": 4,
  "passedRequired": 3,
  "failedRequired": 1,
  "passRate": 75,
  "passed": false,
  "firstFailureType": "http",
  "checks": []
}
```

The structured result is stored under:

```text
telemetry.connectivityContract
```

and summary features are copied into metrics:

```text
contractPassed
contractPassRate
contractFailedRequired
contractFailureType
```

Those fields are intentionally suitable for later statistical comparison and incident clustering.

## Interaction with fault-domain diagnosis

The contract does not replace the deterministic fault-domain engine.

If every required contract condition passes, the endpoint target is considered reachable.

If a required condition fails, endpoint target reachability becomes false. Faultline then uses the existing independent remote probe to determine whether the problem is specific to the affected path or also visible from another vantage point.

For example:

```text
Endpoint contract HTTP fails
Remote probe target healthy
        |
        v
Endpoint path / policy evidence
```

versus:

```text
Endpoint target fails
Remote probe target fails
        |
        v
Target-service evidence
```

The diagnosis evidence list also exposes the contract pass rate and first failing condition.

## Consent and privacy

The invitation page displays the selected contract name, version, description and required checks before the user activates the diagnostic.

Connectivity Contracts describe network tests only. They do not grant access to packet contents, files, passwords, browser history or application content.

## Validation

Contract validation occurs inside the session service, not only in the dashboard or CLI. Unsupported check types, duplicate check IDs, malformed ports and other invalid shapes are rejected before a session is persisted.

Current limits:

- at most 16 checks per contract
- at least one required check
- supported types are DNS, TCP, TLS and HTTP
- contract version must be a positive integer
- built-in v0.7 endpoint evaluation is target-scoped

## Why this helps the later Data Science work

Connectivity Contracts convert vague application failures into consistent structured features.

Instead of comparing only generic values such as latency and packet loss, later incident-similarity work can compare:

```text
contract id
contract version
contract pass rate
first failing check type
DNS/TCP/TLS/HTTP condition states
fault domain
remote-vantage state
```

That makes clustering and similarity analysis more meaningful while keeping the underlying diagnostic conclusions explainable.
