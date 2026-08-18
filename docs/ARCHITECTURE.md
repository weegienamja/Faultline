# Faultline architecture

Faultline is designed around one principle: **diagnosis should come from explicit network evidence, not from a model guessing at telemetry.**

The project deliberately has no AI API dependency. The inputs are structured measurements and the diagnosis engine is deterministic, testable and explainable.

## v0.4 control plane

```text
                               Administrator
                                    |
                                    | admin bearer token
                                    v
                         +------------------------+
                         |   Faultline control    |
                         |        plane           |
                         +-----------+------------+
                                     |
                    create expiring diagnostic session
                                     |
                       +-------------+-------------+
                       |                           |
                 endpoint token                probe token
                       |                           |
                       v                           v
              +----------------+          +----------------+
              | Windows agent  |          | Remote probe   |
              | endpoint path  |          | second network |
              +-------+--------+          +--------+-------+
                      |                            |
                      | scoped evidence            | scoped evidence
                      +-------------+--------------+
                                    |
                                    v
                         +------------------------+
                         | persistent run store   |
                         | correlation engine     |
                         | deterministic diagnosis|
                         +-----------+------------+
                                     |
                                     v
                           admin live dashboard
```

## Diagnostic-session model

A diagnostic is scoped by a generated session ID such as:

```text
FL-6A1B2C3D4E
```

Session creation requires the server administrator credential. The control plane generates two independent random credentials:

```text
fl_ep_...    endpoint role
fl_pr_...    remote-probe role
```

The raw role credentials are returned to the administrator once. The persistent store records only SHA-256 hashes.

The two roles are intentionally separate:

- an endpoint credential can submit endpoint telemetry for its session
- a probe credential can submit the independent remote result for its session
- an endpoint credential cannot act as the probe
- a probe credential cannot act as the endpoint
- both roles expire with the diagnostic session

The administrator credential can inspect the control plane and create sessions but should not be distributed to endpoints or probes.

## Session lifecycle

```text
1. Admin creates session
2. Faultline returns endpoint + probe credentials
3. Endpoint fetches safe session metadata
4. Endpoint collects Windows evidence
5. POST /api/agent-runs with endpoint credential
6. Persistent run becomes ENDPOINT ONLY
7. Remote probe fetches the same safe session metadata
8. Probe independently measures the target
9. POST /api/probe-runs with probe credential
10. Correlation engine merges the two vantage points
11. Persistent run becomes 2 VANTAGES
12. Diagnosis is recalculated
13. Dashboard retrieves the live incident with admin auth
```

The endpoint contribution is currently required before the remote probe can attach. This keeps the v0.4 lifecycle simple and avoids presenting a remote-only result as a correlated incident.

## Endpoint vantage

The Windows collector uses operating-system networking tools and Node.js probes rather than packet interception.

It collects:

- active IPv4 default route
- active adapter metadata
- Wi-Fi signal when available
- active VPN-like adapters
- optional expected-route state
- gateway ICMP latency and loss
- DNS resolution and timing
- general internet TCP controls
- target TCP and HTTP timing
- target ICMP loss and jitter
- direct-IP checks after DNS resolution
- bounded traceroute observations

The endpoint can still run in standalone `--dry-run` mode without authentication. Uploading endpoint telemetry to the control plane requires a valid endpoint session credential.

## Remote vantage

The remote probe is intentionally portable. It uses Node.js networking APIs rather than platform-specific shell commands and therefore runs on Windows, Linux and macOS with Node.js 20+.

It performs:

- DNS resolution and lookup timing
- TCP connection timing to the session target port
- HTTP response timing for HTTP(S) targets
- independent target reachability classification

The remote probe does not yet collect remote traceroute or ICMP path data. Its current purpose is to answer a narrower question reliably: **can an independent network vantage reach the same target?**

## Correlation contract

Endpoint measurements remain the primary diagnostic input. A remote result contributes values derived by the correlation layer:

```json
{
  "externalProbeHealthy": true,
  "externalProbeLatencyMs": 28
}
```

Useful comparisons include:

```text
Endpoint fails + remote succeeds
    -> endpoint-specific path / policy evidence

Endpoint fails + remote fails + general internet healthy
    -> target-service evidence

Endpoint has upstream loss + remote succeeds
    -> reinforces endpoint ISP / transit evidence

Endpoint succeeds + remote succeeds
    -> stronger healthy confidence
```

## Deterministic diagnosis

The diagnosis engine assigns evidence-weighted scores to explicit fault domains:

- local network
- DNS
- VPN / route state
- ISP / upstream path
- endpoint path / policy
- target service

The strongest supported domain becomes the likely diagnosis. Confidence is based on evidence strength and increases when an independent vantage materially supports the conclusion.

There is no LLM in this path. That is intentional. A networking diagnosis should be reproducible from the same telemetry and its evidence should be inspectable in tests.

## Persistence

v0.4 replaces the previous in-memory live-run array with a persistent store.

Default direct-Node path:

```text
data/faultline.json
```

Container path:

```text
/data/faultline.json
```

The file stores:

- session metadata
- endpoint/probe token hashes
- endpoint telemetry
- remote-probe telemetry
- live run state

Writes use a temporary file followed by rename so a partially-written JSON document is not used as the primary state file.

The store is intentionally scoped to a **single-process prototype**. It is not a replacement for a transactional database and should not be shared by multiple Faultline server replicas.

## Dashboard access model

Demo incidents are available through a public endpoint so the product can still be viewed without credentials.

Live diagnostic data is protected by the administrator credential. The browser stores the token in `sessionStorage` after the engineer uses **Unlock live data**.

The token is therefore not placed in a query string or persisted in local storage across browser sessions.

Live values rendered through HTML templates are escaped before insertion into the page.

## Transport security

Session credentials are bearer tokens. They must not be sent across an untrusted network using plain HTTP.

The Node server currently expects HTTPS termination to happen at a reverse proxy, load balancer or hosting platform. See [DEPLOYMENT.md](DEPLOYMENT.md).

## Privacy boundary

Faultline does not need packet payloads, browser history, application content or user credentials.

A diagnostic can still contain operational metadata such as:

- endpoint hostname
- adapter descriptions
- private gateway address
- VPN adapter names
- resolved target addresses
- traceroute hops
- probe hostname/platform
- target connection timings

Future hosted versions should add configurable telemetry redaction before collection or upload.

## Current trust limitations

v0.4 is materially safer to host than v0.3, but the security model remains prototype-grade.

Not yet implemented:

- organisation/user identity
- role-token revocation before expiry
- credential rotation
- rate limiting
- audit logging
- multi-process database concurrency
- retention policies
- registered long-lived probe identity
- automatic TLS termination

## Next architecture milestone

The next valuable expansion is a registered probe model:

```text
                          Faultline
                             |
               +-------------+-------------+
               |                           |
       diagnostic sessions          registered probes
               |                           |
       endpoint evidence             health / identity
               |                           |
               +-------------+-------------+
                             |
                      richer correlation
```

That can then support probe health, regional selection, richer remote path measurements and portable evidence reports for support escalation.
