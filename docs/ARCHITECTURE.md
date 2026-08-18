# Faultline architecture

Faultline is designed around one principle: **diagnosis should come from explicit network evidence, not from a model guessing at telemetry.**

The project deliberately has no AI API dependency. Inputs are structured measurements and the diagnosis engine is deterministic, testable and explainable.

## v0.5 control plane

```text
                               Administrator
                                    |
                                    | admin credential
                                    v
                         +------------------------+
                         |   Faultline control    |
                         |        plane           |
                         +-----------+------------+
                                     |
               +---------------------+----------------------+
               |                                            |
               v                                            v
      diagnostic sessions                         registered probes
      short-lived endpoint                        durable identity
           credentials                             + heartbeat
               |                                            |
               v                                            v
      +----------------+                           private job queue
      | Windows agent  |                                    |
      | endpoint path  |                                    v
      +-------+--------+                            +----------------+
              |                                     | Remote worker  |
              | endpoint evidence                   | second network |
              |                                     +--------+-------+
              |                                              |
              +----------------------+-----------------------+
                                     |
                                     v
                         +------------------------+
                         | persistent run store   |
                         | correlation engine     |
                         | deterministic diagnosis|
                         +-----------+------------+
                                     |
                                     v
                    admin dashboard + probe fleet health
```

## Credential scopes

v0.5 has three primary trust scopes.

### Administrator

The admin credential can:

- register probes
- create diagnostic sessions
- assign sessions to registered probes
- inspect all probe health
- inspect live incidents

It should not be distributed to endpoint or probe hosts.

### Endpoint session credential

Each session receives a short-lived `fl_ep_...` credential. It can submit endpoint evidence for that one session only.

### Registered probe credential

Each registered remote vantage receives a durable `fl_probe_...` credential. It can:

- authenticate as one `PRB-...` identity
- send heartbeat/runtime metadata for that identity
- read only that identity's pending jobs
- submit remote evidence only for sessions assigned to that identity

The raw credential is returned once during registration. Faultline persists only its SHA-256 hash.

For backwards compatibility, an unassigned session can still receive the older short-lived `fl_pr_...` one-off probe credential.

## Registered probe model

A persisted registered probe contains fields such as:

```json
{
  "id": "PRB-8A1B2C3D4E",
  "name": "london-1",
  "location": "London, UK",
  "tags": ["uk", "vps"],
  "enabled": true,
  "tokenHash": "...",
  "createdAt": "...",
  "lastSeenAt": "...",
  "runtime": {
    "version": "0.5.0",
    "platform": "linux",
    "hostname": "lon-probe-1",
    "node": "v22.0.0"
  }
}
```

`tokenHash` is never exposed through the public probe representation.

## Probe health

Health is derived by the control plane from authenticated heartbeat timestamps:

```text
last heartbeat <= 90 seconds    online
last heartbeat <= 5 minutes     stale
older / never seen              offline
disabled identity               disabled
```

This prevents a worker from simply declaring itself healthy.

A successful authenticated job poll also refreshes `lastSeenAt`, because it proves the worker can reach and authenticate to the control plane.

## Assigned job model

A diagnostic session may contain:

```json
{
  "assignedProbeId": "PRB-8A1B2C3D4E"
}
```

The job becomes visible to that registered probe only after endpoint evidence exists and before remote evidence has been attached.

The queue therefore represents work that is actually ready for second-vantage collection:

```text
session created
    |
    v
endpoint not sampled ----------> no probe job
    |
endpoint evidence arrives
    |
    v
assigned probe job appears
    |
remote evidence arrives
    |
    v
job disappears
```

A registered probe cannot enumerate work assigned to another probe ID because the jobs endpoint authenticates against the requested probe identity.

## Registered worker lifecycle

```text
1. Probe process starts
2. GET /api/probes/:id to verify identity
3. POST /api/probes/:id/heartbeat
4. GET /api/probes/:id/jobs
5. For each ready job:
   a. independently resolve target DNS
   b. measure TCP reachability/timing
   c. measure HTTP when applicable
   d. POST /api/probe-runs using the registered credential
6. Correlation engine attaches trusted probe identity to the run
7. Worker sleeps and repeats when --watch is enabled
```

The server does not trust the worker to choose its own registered identity during evidence ingestion. For an assigned session, the control plane resolves the expected probe from `assignedProbeId` and authenticates the bearer token against that stored probe.

## Diagnostic-session lifecycle

For a registered-probe session:

```text
1. Admin registers a remote probe once
2. Probe worker begins heartbeating
3. Admin creates diagnostic session assigned to probe ID
4. Faultline returns a short-lived endpoint token
5. Endpoint fetches safe session metadata
6. Endpoint collects Windows evidence
7. POST /api/agent-runs
8. Assigned session enters registered probe's job queue
9. Probe worker independently measures target
10. POST /api/probe-runs with registered probe token
11. Correlation engine merges the two vantage points
12. Persistent run becomes 2 VANTAGES
13. Diagnosis is recalculated
14. Dashboard shows incident and probe fleet health
```

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

## Remote vantage

The portable remote worker uses Node.js networking APIs and runs on Windows, Linux and macOS with Node.js 20+.

It currently performs:

- DNS resolution and lookup timing
- TCP connection timing to the session target port
- HTTP response timing for HTTP(S) targets
- independent target reachability classification

It does not yet collect remote traceroute or ICMP path telemetry.

## Correlation contract

Endpoint measurements remain the main diagnostic input. Remote evidence contributes values such as:

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

There is no LLM in this path. The same telemetry should produce the same diagnosis and evidence trail.

## Persistence

v0.5 state format version 2 stores:

- sessions
- diagnostic runs
- registered probes

Default direct-Node path:

```text
data/faultline.json
```

Container path:

```text
/data/faultline.json
```

Existing v0.4 state is normalized by adding an empty probe registry on read.

Writes still use a temporary file followed by rename. The store remains intentionally single-process and is not a substitute for a transactional database.

## Dashboard access model

Demo incidents remain public.

Live diagnostic data and registered probe health require the administrator credential. The browser keeps that credential in `sessionStorage`, not in URLs or persistent local storage.

Live telemetry and probe metadata rendered through HTML templates are escaped before insertion.

## Transport security

Endpoint and registered-probe credentials are bearer tokens. Remote deployments must use HTTPS between collectors/workers and the control plane.

The Node service expects TLS termination at a reverse proxy, load balancer or hosting platform.

## Current trust limitations

v0.5 introduces durable probe identity but remains prototype-grade.

Not yet implemented:

- registered-probe credential rotation
- immediate probe-token revocation API
- organisation/user identity
- audit logging
- rate limiting
- push-based job delivery
- automatic probe selection by location/tag
- database-backed multi-instance concurrency
- configurable retention/redaction policies
- automatic TLS termination

## Next architecture choices

The strongest next directions are:

1. probe disable/revoke/rotate controls with audit events
2. scheduler-driven probe selection by region/tag and health
3. richer remote path measurements
4. database-backed multi-instance control plane
5. portable evidence-report export

None requires an AI dependency for core network diagnosis.
