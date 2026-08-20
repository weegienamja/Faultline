# Diagnosing intermittent network failures

Intermittent network faults are difficult because the useful evidence often disappears before troubleshooting begins. A manual test taken five minutes later can show a healthy network even though the failure was real.

The first goal is therefore not to explain the fault. It is to preserve the state around it.

## Start the Flight Recorder

```bash
npm run recorder -- example.com
```

The Flight Recorder keeps a bounded rolling window of lightweight network state. When a trigger fires it freezes the evidence around the event and performs one deeper capture.

The resulting chronology separates:

```text
BEFORE -> TRIGGER -> DURING -> DEEP CAPTURE -> AFTER
```

That can preserve:

- target reachability
- gateway and interface state
- IPv4 and IPv6 state
- resolver state
- observed changes between windows
- candidate conditions that can be tested later

## Treat changes as candidates

If DNS changed just before the failure, that does not prove DNS caused it. If a VPN route disappeared at the same time, that is still temporal association rather than a controlled result.

Faultline keeps those distinctions explicit. Recorder evidence tells you what changed around the event. Network Bisect can then test whether changing a candidate condition actually changes the outcome.

## Isolate a reproducible condition

If the failure is currently reproducible:

```bash
npm run bisect -- example.com
```

Network Bisect can vary conditions such as address family, resolver, resolved address, source interface, TLS version, ALPN, SNI and port. It confirms a candidate with interleaved baseline/variant trials so normal network drift is less likely to be mistaken for a repair.

If the baseline itself is inconsistent, the engine reports it as unstable and refuses to claim isolation.

## Run a live diagnostic during the fault

```bash
npm start
```

Open `http://localhost:3000`, unlock live data and test the target. Live Diagnostics can collect DNS, TCP, TLS, HTTP, ICMP, traceroute, adapter, Wi-Fi, VPN and resolver state, while independent public measurements and routing context remain separately labelled evidence.

## Preserve the incident

Once the event is captured, export a Portable Incident Capsule:

```bash
npm run capsule -- FLR-2026-0001
```

The capsule is a self-contained HTML evidence package that can include Recorder chronology, deterministic comparisons, Network Bisect experiments, provenance and integrity information. It opens directly from `file://` and does not need a running Faultline server.

## A practical investigation sequence

1. Keep the Recorder running while the intermittent fault is occurring.
2. Capture the transition instead of relying on a later healthy snapshot.
3. Review what changed before and during the trigger.
4. Convert plausible differences into explicit candidate conditions.
5. Use Network Bisect when the fault is reproducible enough for controlled testing.
6. Preserve the resulting chronology and experiments in an Incident Capsule.

This sequence does not guarantee a root cause. It does produce a much stronger escalation package than "it failed earlier but works now."

See [Flight Recorder](../FLIGHT_RECORDER.md), [Network Bisect](../NETWORK_BISECT.md), [Live Internet Data](../LIVE_INTERNET_DATA.md) and [Portable Incident Capsule](../INCIDENT_CAPSULE.md).
