# Network troubleshooting guides

These guides cover failure patterns that are difficult to diagnose with a single ping, traceroute or packet capture taken after the fault has disappeared.

Faultline's approach is evidence-first: collect what the machine actually observed, compare conditions without rewriting host configuration, and keep temporal association separate from controlled evidence.

## Guides

- [Website works on a hotspot but not Wi-Fi](website-works-on-hotspot-not-wifi.md)
- [IPv4 works but IPv6 does not](ipv4-works-ipv6-does-not.md)
- [VPN connected but an internal service is unreachable](vpn-connected-internal-service-unreachable.md)
- [Diagnosing intermittent network failures](intermittent-network-failures.md)

## Useful Faultline workflows

### Test which network condition changes the outcome

```bash
npm run bisect -- example.com
npm run bisect -- example.com --all
```

[Network Bisect](../NETWORK_BISECT.md) varies conditions per connection and confirms a candidate discriminator with interleaved baseline/variant trials.

### Capture evidence around an intermittent failure

```bash
npm run recorder -- example.com
```

[Flight Recorder](../FLIGHT_RECORDER.md) keeps a bounded rolling history, freezes the window around a trigger and records candidate conditions for later testing.

### Inspect a real target from the dashboard

```bash
npm start
```

Open `http://localhost:3000`, unlock live data and run Live Diagnostics for DNS, TCP, TLS, HTTP, ICMP, path and local network state.

## Evidence boundary

Faultline does not treat "this changed at the same time" as proof of cause. A Recorder change is an observed difference. A Network Bisect discriminator is stronger because the condition is deliberately varied and the outcome is retested. Public routing or outage context remains supporting evidence unless it is itself a measured comparison used by the deterministic engine.
