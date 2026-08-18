# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a common support problem: every team can see its own part of a connection, but nobody has enough shared evidence to say where a fault actually begins.

Instead of producing another wall of network metrics, Faultline correlates observations into a likely **fault domain**, explains the evidence behind that decision, and recommends the next action.

## Why Faultline?

A typical connectivity incident crosses several ownership boundaries:

```text
Endpoint -> Wi-Fi/LAN -> ISP -> Internet transit -> SaaS / application
```

The end user sees a broken application. Internal IT sees a healthy LAN. The ISP sees an active circuit. The SaaS provider sees healthy servers.

Faultline is intended to bridge those viewpoints without requiring either side to hand over full administrative access.

## v0.1

The first build includes:

- a polished incident dashboard designed around fault-domain isolation
- deterministic diagnosis logic for local network, DNS, VPN, upstream and target-service failures
- evidence and confidence output rather than opaque scoring alone
- four realistic demo incidents for product demonstrations
- a `POST /api/diagnose` contract ready for future endpoint agents and cloud probes
- zero runtime dependencies
- automated diagnosis tests

## Run it

Requires Node.js 20 or newer.

```bash
npm start
```

Then open `http://localhost:3000`.

For development with automatic restarts:

```bash
npm run dev
```

## Test it

```bash
npm test
npm run check
```

## Example diagnosis request

```bash
curl -X POST http://localhost:3000/api/diagnose \
  -H "content-type: application/json" \
  -d '{
    "gatewayLoss": 0,
    "gatewayLatencyMs": 3,
    "dnsResolved": true,
    "internetReachable": true,
    "upstreamLoss": 8.4,
    "jitterMs": 71,
    "externalProbeHealthy": true,
    "targetReachable": true
  }'
```

The response contains a likely fault domain, confidence score, supporting evidence and recommended actions.

## Product direction

The demo data is deliberately replaceable. The next milestone is a lightweight endpoint collector that can provide real measurements for:

1. local gateway health
2. DNS resolution
3. internet reachability
4. packet loss and jitter
5. route and VPN state
6. target TCP/TLS/HTTP timings

A cloud probe can then provide an independent viewpoint, allowing the same diagnosis engine to compare both sides of a support boundary.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the intended architecture.

## Status

Faultline is an early product prototype. The current dashboard demonstrates the diagnosis model and product workflow; it is **not yet a replacement for production network observability platforms**.

## License

MIT
