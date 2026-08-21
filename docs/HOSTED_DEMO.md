# Hosted public demo

Faultline is a local-first product. The full thing runs on the network being
investigated, where it can read adapters, routes, resolvers and VPN state, keep
a rolling Flight Recorder buffer, and run Network Bisect against a live fault.

None of that is possible from a serverless function. The hosted demo therefore
does two things and is explicit about which is which:

| | What runs | Evidence class |
|---|---|---|
| **Live public diagnostic** | Real DNS, TCP, TLS and HTTP from the hosted deployment, plus genuine public-vantage and routing context | `observed` |
| **Recorded investigations** | Recorded scenarios replayed through the production Flight Recorder and Network Bisect engines | `simulated` |

There is no third category. Nothing on the demo is a measurement of the
visitor's own network, and nothing claims to be.

---

## The runtime capability model

One module decides what this deployment can observe:
[`src/runtime/capabilities.mjs`](../src/runtime/capabilities.mjs).

```
hosted = FAULTLINE_RUNTIME === "hosted"  OR  VERCEL is present
```

It is served at `GET /api/capabilities` (public, no credential, no secrets) and
stamped onto `<html>` when the server serves the page, so the browser's first
paint is already correct:

```html
<html lang="en" data-runtime="hosted" data-public-demo="true"
      data-vantage-label="VERCEL VANTAGE" data-vantage-region="lhr1">
```

The frontend reads that through `runtime` in
[`public/shell.js`](../public/shell.js). No panel sniffs for a hostname, and no
panel keeps its own idea of what is available — which is what stops one screen
saying `LOCAL` next to a reading taken in a datacentre.

On a hosted runtime the model reports, and the interface obeys:

| Capability | Hosted | Local |
|---|---|---|
| `serverVantage` / `publicInternetDiagnostics` | yes | yes |
| `distributedVantage` (Globalping, RIPEstat) | yes | yes |
| `endpointLocal`, `localEnvironment`, `windowsEndpointAgent` | **no** | yes |
| `icmpAndTraceroute` | **no** | yes |
| `endpointFlightRecorder` | **no** | yes |
| `durablePersistence` | **no** (`/tmp`, ephemeral) | yes |
| `analyst.available` | **no** (needs local Ollama) | yes |
| `adminApiProtected` | yes | yes |

## Vantage labelling

A hosted deployment never labels a measurement `LOCAL`. `vantageFor()` returns
`VERCEL VANTAGE` on Vercel, `HOSTED VANTAGE` on any other hosted platform, and
`LOCAL` only on a local install. Every measurement the demo renders carries that
label, and the run payload carries its own `vantage` object so the provenance
travels with the evidence rather than with the page that drew it.

The deterministic engine is written for an endpoint: it reasons about a default
gateway, ICMP loss and jitter, and where it has no input it falls back to a
healthy default. On a hosted run those inputs do not exist, so
`projectDiagnosisForVantage()` in [`src/demo/vantage.mjs`](../src/demo/vantage.mjs)
**partitions** the engine's output rather than editing it:

- `inScope` — findings whose inputs this vantage genuinely measured
- `notObservable` — findings whose inputs it did not, restated as `not-measured`
  with `requires: "Faultline Agent on the endpoint"`

So "Gateway packet loss — PASS — the local path to the default gateway is
stable" never reaches a visitor as evidence about a network nobody measured.
The fault domain, confidence and summary remain exactly what the engine decided.

---

## Live public diagnostic

`POST /api/demo/diagnose` — unauthenticated, constrained.

```json
{ "target": "github.com" }
```

It reuses the existing measurement engine
([`src/live/measure.mjs`](../src/live/measure.mjs)) and runs:

- **DNS** through the system resolver *and* 1.1.1.1 / 8.8.8.8 / 9.9.9.9, with
  the resolver-agreement comparison — a real measurement of resolver behaviour
- **TCP** connect timing to the validated address
- **TLS** handshake, negotiated version, cipher, ALPN and certificate facts
- **HTTP** status and time to first byte, over a bounded, re-validated redirect
  chain
- **Globalping** — a genuine second vantage, from public probes that are not
  this deployment
- **RIPEstat / IODA / PeeringDB** — public routing and ownership context, which
  is deliberately *excluded* from the deterministic engine's input so a
  third-party API can never move a fault domain

It does **not** run `collectLocalEnvironment()`, ping, traceroute, or any child
process at all.

### `/api/live/diagnostics` is unchanged

The existing operator diagnostic stays admin-authenticated. It can name any
target and it spawns ICMP and traceroute, so an unauthenticated version of it
would be an SSRF and resource-abuse primitive. The demo endpoint is a separate,
narrower route — not the same route with the check removed.

---

## Public endpoint security

Two independent controls apply, and a target has to pass both. See
[`src/demo/policy.mjs`](../src/demo/policy.mjs).

**1. Allowlist (on by default).** The hostname must be, or be a subdomain of, a
known public service. A suffix match is not a subdomain match, so
`notgithub.com` and `github.com.evil.test` are both refused. Configurable with
`FAULTLINE_DEMO_ALLOWLIST`.

**2. Address validation.** The hostname is resolved and **every** returned
address — v4, v6 and IPv4-mapped v6, all of them, not just the first — is
checked with `validateResolvedAddresses()`, the same boundary the registered
probe fleet uses. Loopback, RFC1918, CGNAT, link-local, ULA, multicast,
documentation, benchmark and reserved ranges are all refused.

Also enforced:

| Control | Behaviour |
|---|---|
| Scheme | `http` and `https` only |
| Port | 80 and 443 only; an explicit port in a bare target is refused |
| Literal addresses | never accepted — the demo tests hostnames |
| Userinfo | `user:pass@host` refused |
| Control characters | refused |
| Query / fragment | stripped from a URL target |
| Redirects | capped at 3; **each hop** re-checked against the allowlist and re-resolved and re-validated |
| Connection pinning | every stage connects to an address validated in this request, never a re-resolved name, so a DNS answer that changes afterwards cannot move the connection |
| Methods / headers / body | not caller-controlled anywhere |
| Local commands | none on this path |
| Timeouts | per stage (DNS 4s, TCP 4s, TLS 5s, HTTP 6s) and a whole-run budget |

## Rate limiting — and its honest limit

[`src/demo/limits.mjs`](../src/demo/limits.mjs) enforces three bounds:
per-client per minute, per-instance per minute, and maximum concurrent
diagnostics. The client key is the **rightmost** forwarded hop, because the
leftmost is caller-supplied and would mint a fresh bucket per request.

**This limiter is per Function instance.** Vercel scales instances
horizontally and no durable distributed store is provisioned for this
deployment, so it is a best-effort abuse control and **not** a globally reliable
quota. `/api/demo/capabilities` says so in `demo.rateLimit`, rather than leaving
an operator to assume a guarantee that does not exist.

What *does* hold globally regardless of instance count is the policy boundary
above. The worst case of exhausting the limiter is more requests to
`github.com`, not a scanner.

---

## Recorded investigations

Three faults that live on an endpoint's own network, so a hosted deployment
cannot reproduce them:

| Reference | Investigation | Discriminator the engine isolates |
|---|---|---|
| `FLR-DEMO-IPV6` | IPv6 path failure | `address-family` — IPv4 only changes FAIL to PASS |
| `FLR-DEMO-DNS` | DNS resolver disagreement | `resolver` — a public resolver changes FAIL to PASS |
| `FLR-DEMO-VPN` | VPN routing regression | `source-interface` — binding the physical NIC changes FAIL to PASS |

### These are replays, not fixtures of a result

[`src/demo/replay.mjs`](../src/demo/replay.mjs) runs the **production** engines
and replaces only the source of evidence, at the two seams the product already
provides for exactly this purpose:

| Engine | Seam | Already used by |
|---|---|---|
| Flight Recorder | `sampler` | `src/recorder/simulate.mjs` |
| Network Bisect | `trialRunner` | `isolate()` in `src/bisect/adaptive.mjs` |

Everything downstream is production code: the ring buffer, trigger detection,
cooldown, window freeze, BEFORE/DURING/AFTER assembly, the difference engine,
axis mapping, hypothesis formation, the adaptive planner, interleaved A/B
confirmation and verdict classification.

**Time** is the other substitution. A scenario plays out over a minute of wall
clock, which no HTTP request should wait for, so the recorder is driven by a
virtual clock through its existing `now` and `clock` parameters. Sixty seconds
of recorded behaviour resolves in milliseconds and the engine's arithmetic is
identical.

The Bisect "world model" is a pure function of the **connection plan** the real
planner produced. It never sees the hypothesis set, the score, or which
experiment is running — it answers "if you had connected like this, what would
have happened". The verdict is therefore something the engine derived, not
something written into the fixture.

### Provenance

It survives every hop, and it is derived rather than asserted:

```
sample        simulated: true, source: "simulation", scenario: <name>
incident      simulated: true, evidenceClass: "simulated"   (derived from the samples)
bisect        simulated: true, evidenceClass: "simulated", source: "replay"
attachment    simulated: true, "Neither is a measurement of a real network."
capsule       incident.simulated: true, integrity-tagged
UI            RECORDED DEMO INCIDENT / RECORDED SAMPLES /
              REPLAYED EXPERIMENT / SIMULATED EVIDENCE
```

`buildIncident()` derives `simulated` from the samples themselves, so a replay
cannot be constructed as a real capture by a caller that forgets to say so.

### The full loop

Each investigation walks CAPTURE → ISOLATE → EXPLAIN → PRESERVE, using the same
chronology rail the real Flight Recorder draws, and ends at a downloadable
Incident Capsule (`GET /api/demo/incidents/:slug/capsule`, `?format=json` for
the payload).

Replays are deterministic and cached per Function instance, so every visitor
sees the same record with the same integrity digest.

### The Analyst

Not available on a hosted deployment, and the interface says exactly that:

> Faultline Analyst requires a local Faultline Agent running Ollama.

No cloud inference API is substituted. Network evidence is never sent to a
remote model. Every deterministic diagnosis on the demo is produced without it,
which is the point — the Analyst is an interpretation layer and never produces a
finding.

---

## API surface

| Route | Auth | Notes |
|---|---|---|
| `GET /api/capabilities` | none | Runtime capability model. No secrets. |
| `GET /api/demo/capabilities` | none | Capabilities + demo policy, allowlist and rate limits |
| `POST /api/demo/diagnose` | none | Constrained live diagnostic. Rate limited. |
| `GET /api/demo/incidents` | none | The three recorded investigations |
| `GET /api/demo/incidents/:slug` | none | Full replayed investigation |
| `GET /api/demo/incidents/:slug/capsule` | none | Incident Capsule, HTML or `?format=json` |
| `/api/live/*`, `/api/recorder/*`, `/api/bisect/*`, `/api/analyst/*`, `/api/cases/*`, `/api/probes`, `/api/sessions`, `/api/incidents`, `/api/audit` | **admin** | Unchanged |

The whole demo router is mounted only when the runtime says this deployment is
a public demo. On a local install with no demo flag these paths return 404 —
they are absent, not open.

---

## Environment

Set in the hosting platform's encrypted environment, never in the repository:

| Variable | Purpose |
|---|---|
| `FAULTLINE_ADMIN_TOKEN` | Protects the operator APIs. **Required** on a hosted deployment — see below. |
| `FAULTLINE_RUNTIME` | `hosted` or `local`. Defaults from `VERCEL`. |
| `FAULTLINE_PUBLIC_DEMO` | Enables `/api/demo/*`. Defaults from the runtime. |
| `FAULTLINE_DEMO_ALLOWLIST` | Comma/space separated hostnames. Optional. |
| `FAULTLINE_DEMO_RATE_PER_MIN` | Per-visitor cap. Optional, clamped 1–120. |
| `FAULTLINE_DEMO_RATE_INSTANCE_PER_MIN` | Per-instance cap. Optional, clamped 1–600. |
| `FAULTLINE_DEMO_MAX_CONCURRENT` | Concurrent diagnostics. Optional, clamped 1–16. |
| `FAULTLINE_DEMO_REQUEST_BUDGET_MS` | Whole-run budget. Optional, clamped 5s–60s. |
| `FAULTLINE_DATA_FILE` | Set to `/tmp/faultline.json` automatically on Vercel. |

### The admin credential on a hosted runtime

A local install with no `FAULTLINE_ADMIN_TOKEN` generates a development
credential and prints it at startup. A **hosted** runtime does not: a printed
credential is a published credential, and platform logs are not a secret
channel. A hosted deployment with no token configured instead derives an
unusable credential that nobody holds and logs:

```
No FAULTLINE_ADMIN_TOKEN is configured. Admin and operator APIs are unreachable
on this deployment.
```

The public demo does not need the token, and the token never appears in client
JavaScript, HTML, the repository, logs, or browser storage by default.

---

## Persistence

Hosted storage is `/tmp/faultline.json` on an ephemeral Function instance. It is
intentionally not durable, `capabilities().durablePersistence` is `false`, and
the interface says so:

> Hosted storage is /tmp on an ephemeral Function instance. Runs are returned to
> you directly and are not retained as an archive.

The demo does not depend on it: live runs are returned in the response, and
recorded investigations are rebuilt deterministically.

---

## Tests

| File | Covers |
|---|---|
| `tests/demo-policy.test.mjs` | Every SSRF and abuse shape the target policy must refuse |
| `tests/demo-runtime.test.mjs` | Capability model, vantage labelling, diagnosis scoping, rate limits |
| `tests/demo-investigations.test.mjs` | Replays really run the production engines, and provenance survives every hop |
| `tests/demo-routes.test.mjs` | The demo is usable without a credential and nothing else is |
