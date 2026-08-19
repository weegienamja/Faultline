# Flight Recorder

**Flight Recorder captures evidence that normally disappears before
troubleshooting begins.**

By the time someone opens a diagnostic tool, the thing that changed has usually
changed back. The route flapped, the VPN reconnected, the Wi-Fi roamed to
another AP — and all that remains is a user saying "it was broken a minute ago".
Flight Recorder keeps a short rolling window so that minute still exists.

It is deliberately **not** continuous monitoring, an NMS, or a time-series
database. The rolling sample buffer is minutes long and lives only in memory.
A *closed incident* is different: it is a finished evidence artefact, so it is
written to the Faultline store and survives a restart, like a diagnostic run or
a case.

---

## How it works

```
LIGHTWEIGHT SAMPLING
every 2–5 s
        ↓
trigger detected
        ↓
freeze the preceding buffer
        +
run one deeper diagnostic immediately
        +
continue lightweight capture
        ↓
BEFORE / DURING / AFTER
```

The split matters. Running TLS, HTTP, traceroute and public-intelligence lookups
every few seconds would make the recorder heavy enough to affect the network it
is observing. So the routine sample is cheap, and the expensive measurement runs
once, when something has already happened.

### Two sampling tiers

| Tier | Cadence | Cost | Contents |
|---|---|---|---|
| Fast | every tick | in-process only | interfaces, resolvers, target DNS, TCP per address family |
| Slow | every 5th tick | ~1.3 s, spawns PowerShell | adapter/route/Wi-Fi/VPN state, gateway ping, public IP |

Slow-tier values are carried forward between refreshes and keep their own
`observedAt` with `carriedForward: true`. A carried value is **never**
re-timestamped as though it had just been measured — doing so would manufacture
precision the recorder does not have, and would report a route change seconds
before it was actually seen.

The interval is a floor between ticks, not a fixed cadence: a slow tick delays
the next one rather than stacking behind it.

## What a sample contains

```
timestamp

LOCAL NETWORK   active interface · default gateway · default route and metric
                DNS servers · Wi-Fi SSID/BSSID · VPN presence

CONNECTIVITY    IPv4 · IPv6 · gateway latency and loss
                target DNS · target TCP · target latency
                Connectivity Contract status

PATH            public IP · resolved target address · path fingerprint

STATE           healthy / degraded / failed · trigger reasons
```

### Address families are answered honestly

IPv4 and IPv6 are probed separately, and the recorder uses `resolve4`/`resolve6`
rather than `lookup()`. That is not a detail. `lookup()` goes through
`getaddrinfo`, which filters answers by what the local stack can use: on a
machine with no working IPv6 it returns `ENOENT` for AAAA **even when the target
publishes AAAA records**. Reading that as "the target publishes no IPv6 address"
would report a local capability deficiency as a target property.

So three outcomes are kept distinct:

| Outcome | Meaning |
|---|---|
| `PASS` / `FAIL` | the target publishes an address of this family, and the connection did or did not complete |
| `INAPPLICABLE` | DNS answered: the target publishes no address of this family (a target property) |
| `UNKNOWN` | resolution itself failed; nothing was established either way |

### Contract sampling is asymmetric

A lightweight sample can afford a contract's `dns` and `tcp` checks but not its
`tls` and `http` checks. So a **FAIL is conclusive** — a failing required check
fails the contract regardless of what was skipped — while a **PASS is reported
as `PARTIAL`**, naming the checks that were not evaluated. The asymmetry is
stated rather than smoothed into "passing".

---

## Triggers

Five, deliberately few. A recorder that fires on everything captures nothing
useful.

| # | Trigger | Opens an incident |
|---|---|---|
| 1 | **Target reachability transition** (PASS → FAIL) | yes |
| 2 | **Connectivity Contract failure** (required check stops passing) | yes |
| 3 | **Gateway degradation** (loss/latency crosses a threshold) | yes |
| 4 | **Network-state change** (route, VPN, BSSID, DNS, interface, public IP) | no, by default |
| 5 | **Manual capture** | yes, and bypasses the cooldown |

A **network-state change is not a fault**. It is a marker that becomes highly
relevant when a failure happens near it, so it is recorded and shown but does
not by itself justify a deep capture. Enable `captureOnStateChange` if you want
it to.

Thresholds are crossings, not levels: a persistently lossy link does not
retrigger every tick. A cooldown means a flapping target produces one incident
rather than forty. Recovery (FAIL → PASS) closes an incident; it never opens one.

---

## The incident record

```
INCIDENT  FLR-2026-0007

Target      api.example.com:443
Triggered   20:46:18
            Target TCP reachability changed PASS → FAIL

────────────────────────────────────────────────────────────

BEFORE
  20:45:51   ok   PASS 31 ms   v6 PASS   gw 2 ms   Ethernet
  20:46:06   ok   PASS 28 ms   v6 PASS   gw 2 ms   Ethernet

DURING
  20:46:18  FAIL  FAIL ETIMEDOUT        gw 2 ms   Corp VPN

  DEEP CAPTURE
    DNS      pass
    TCP      fail
    TLS      not-measured
    External Independent vantage points reached the target
             while this endpoint did not.

AFTER
  20:46:46   ok   PASS 30 ms   v6 PASS   gw 2 ms   Ethernet

────────────────────────────────────────────────────────────

OBSERVED CHANGE

  The target became unreachable at 20:46:18. Compared with the
  last healthy sample at 20:46:06, the failing window differs
  by active interface and default route. The target was
  reachable again at 20:46:46.

  This is an observed temporal association, not proof that any
  listed change caused the failure.
```

### The epistemic rule

Temporal adjacency is the most seductive false signal in network
troubleshooting, so the boundary is enforced in code, not just in wording:

| | |
|---|---|
| ✅ Observed | the route changed at 20:46:17 |
| ✅ Observed | connections began failing at 20:46:18 |
| ✅ Deterministic comparison | the failing window differs from the preceding healthy window by route selection |
| ❌ Not produced | the route change caused the outage |

`observedChange.statement` states what was observed and how two windows differ.
It never states why, and it contains no causal vocabulary at all — the
qualification lives in `observedChange.note`, deliberately not repeated in the
statement, because a sentence that must contain the word "caused" in order to
deny causation is one careless edit away from asserting it. A test asserts the
statement is free of causal terms.

The record is also careful about what did *not* happen. A manual capture taken
while everything is working produces "the capture was requested while the target
was still reachable" — not "the failing sample", and no recovery claim.

---

## Handoff to Network Bisect

This is where the feature becomes more than a log.

The recorder can say *what differed*. It cannot say whether that difference
matters, because it only watched — it never varied anything. Network Bisect can,
because it runs controlled experiments with paired confirmation.

```
Recorder            "What changed?"
        ↓
Candidate differences
        ↓
Network Bisect      "Which change actually alters the outcome?"
        ↓
paired confirmation
        ↓
deterministic evidence
```

Each observed difference is mapped to the Bisect axis that can vary it:

| Observed change | Bisect axis |
|---|---|
| Active interface | `source-interface` |
| Default route | `source-interface` (the testable proxy for route selection) |
| VPN state | `source-interface` |
| DNS servers | `resolver` |
| Resolved target address | `address` |
| IPv4 / IPv6 capability | `address-family` |
| Default gateway, Wi-Fi SSID/BSSID, public IP | *(none)* |

Differences with no axis are reported as **observed but not testable** rather
than dropped. A public IP change is real evidence even though no experiment can
vary it, and saying so is more useful than implying it could be tested.

`POST /api/recorder/incidents/{id}/bisect` runs Bisect restricted to exactly the
axes the recorder observed changing, rather than re-deriving the whole matrix.
Bisect then reaches its own verdict independently — and may well find that none
of the candidates changes the outcome.

### Resolved addresses and CDNs

A CDN-hosted target returns a rotating subset of a stable address pool, so
comparing the first address would report "the target moved" on almost every
tick. Two answer sets that overlap are treated as the same pool; only fully
disjoint sets count as a repoint. The path fingerprint deliberately excludes the
resolved address — it describes how traffic *leaves* this machine, not where it
lands.

---

## Using it

### CLI

```bash
npm run recorder -- api.example.com
npm run recorder -- api.example.com --interval 3 --window 300
npm run recorder -- api.example.com --contract secure-web
npm run recorder -- mark --note "user reported slowness"
```

Local recording needs no server, matching `npm run bisect`. Ctrl+C stops it and
prints any incident still open rather than discarding it.

`mark` talks to a running control plane (`FAULTLINE_URL`,
`FAULTLINE_ADMIN_TOKEN`) — for when the engineer sees the problem before a
threshold does.

Flags: `--interval` (seconds, 2–30), `--window` (seconds, 60–600), `--contract`,
`--no-deep-capture`, `--capture-state-changes`, `--duration`.

### Dashboard

**Capture → Flight Recorder.** Start a recording, watch the rolling timeline,
capture an incident by hand, and open the before/during/after record. The panel
streams live over SSE.

### API

| Route | Purpose |
|---|---|
| `POST /api/recorder/start` | Begin recording a target |
| `POST /api/recorder/stop` | Stop; any open incident is preserved |
| `GET /api/recorder/status` | State, coverage, config, incident list |
| `GET /api/recorder/timeline` | Retained samples |
| `POST /api/recorder/mark` | Capture an incident now |
| `GET /api/recorder/incidents` | Captured incidents |
| `GET /api/recorder/incidents/{id}` | One full incident record |
| `POST /api/recorder/incidents/{id}/bisect` | Test the candidates with Network Bisect |
| `GET /api/recorder/stream` | Live events (SSE) |

All routes are admin-authenticated, matching the live and bisect routes:
recording makes repeated real outbound connections, so an open endpoint would be
a resource-abuse and SSRF primitive. Targets pass the same public-probe boundary
(allowed ports, no private or link-local destinations) as every other outbound
path.

One recorder runs per control plane. Starting a second while one is running is a
409.

---

## Retention and privacy

Two different lifetimes, and the distinction is the point:

| | Lifetime |
|---|---|
| Rolling sample buffer | memory only, minutes, discarded on exit |
| Closed incident | written to the Faultline store, survives a restart |

That is what keeps this a recorder rather than a time-series database: the
continuous stream is ephemeral, and only the frozen window around an actual
event becomes durable evidence.

* **The buffer is never persisted.** Only closed incidents are.
* **Bounded twice.** By window (60–600 s) and by a hard sample cap, so a
  misconfigured interval cannot exhaust memory before the window bound applies.
* **Bounded incidents.** Ten retained per process.
* **Measurements, not payloads.** The recorder records outcomes and network
  state; never packet contents, credentials or browsing activity.
* **No external contact by default.** The only destination is the target itself.
  Public IP sampling is off unless `samplePublicIp` is set, and is the one
  outbound call to anything else.
* **Persistence can be switched off.** `FAULTLINE_RECORDER_PERSIST=0` keeps
  incidents in memory only, restoring the fully ephemeral behaviour.

A persisted incident contains local network identifiers — interface names,
gateway and local addresses, DNS servers, Wi-Fi SSID/BSSID — because those are
the evidence. The store file is written `0600`. At most 20 incidents are kept on
disk, oldest evicted first.

Closed incidents are also placed on the Analyst's in-memory evidence registry so
the local Analyst can explain them. That retention disappears with the process
too.

---

## Faultline Analyst integration

The Analyst gains two read-only tools: `get_latest_recorder_incident` and
`get_recorder_incident`. The projection sheds sample bulk (boundary samples plus
counts) and preserves `classification: "temporal_association"` and the
qualifying note verbatim, with an explicit instruction not to describe any
difference as a cause.

Starter questions on the Flight Recorder screen: *What changed before this
broke? · What stayed healthy? · Which differences can Network Bisect test?*

---

## Configuration

| Option | Default | Range |
|---|---|---|
| `intervalMs` | 3000 | 2000–30000 |
| `windowMs` | 180000 | 60000–600000 |
| `afterWindowMs` | 60000 | 10000–300000 |
| `slowEveryTicks` | 5 | — |
| `cooldownMs` | 60000 | — |
| `maxIncidents` | 10 | — |
| `captureOnStateChange` | false | — |
| `samplePublicIp` | false | — |
| `FAULTLINE_RECORDER_PERSIST` | `1` | `0` disables incident persistence |

Gateway thresholds: 5% loss, 40 ms latency.

---

## Testing

```bash
npm test
```

Sampling, triggers, incident assembly and the engine are tested over injected
clocks and dependencies: no network, no PowerShell, no real timers. The route
tests exercise a real server process but reject before any recording starts,
except one case that records against an unresolvable host.

---

## Limitations

* Adapter, route, Wi-Fi and VPN collection is Windows-only, matching the rest of
  Faultline's local collection. On other platforms those fields are absent and
  the triggers that depend on them do not fire; connectivity sampling works
  everywhere.
* One recorder runs at a time. Closed incidents persist; the live buffer does not.
* The recorder observes. It does not experiment, and therefore never establishes
  cause — that is Network Bisect's job.
* A change that happens and reverts entirely between two ticks is not seen. A
  shorter interval narrows the gap at proportionate cost.
