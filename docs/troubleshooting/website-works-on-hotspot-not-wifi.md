# Website works on a mobile hotspot but not Wi-Fi

A service that works through a phone hotspot but fails on Wi-Fi is not enough evidence to blame the Wi-Fi itself. The two paths may differ in DNS, IPv4/IPv6 availability, source interface, VPN policy, NAT behaviour, routing, MTU, filtering or the path taken to the target.

The useful question is narrower:

> Which network condition changes the connection outcome?

## Start with a reproducible target

Use the hostname or URL that actually fails rather than a generic connectivity check.

```bash
npm run bisect -- example.com
```

Network Bisect establishes a baseline, forms competing explanations and chooses condition changes that can separate them. It can test address family, DNS resolver, resolved address, source interface, TLS version, ALPN, SNI and port without rewriting the host's network configuration.

For a complete condition matrix:

```bash
npm run bisect -- example.com --all
```

## What to look for

### IPv4 passes while IPv6 fails

That is an observed address-family discriminator if the difference survives confirmation. It does not by itself prove where the IPv6 problem sits. The next useful evidence is the path, local IPv6 state and whether the target actually offers working IPv6.

### One DNS resolver changes the result

That can point to a resolver-dependent answer, resolution failure or different returned address set. Compare the resolved addresses before assuming the resolver itself is at fault.

### One source interface changes the result

A working hotspot and failing Wi-Fi may differ because of the interface, but they may also differ because each interface selects a different route, address family or policy path. Faultline treats unreachable source interfaces as `INAPPLICABLE` rather than as false network failures.

### TLS or ALPN changes the result

If the TCP path works but a particular protocol condition changes the application connection, the failure boundary may be above basic IP reachability.

## Capture the failure if it is intermittent

If the problem comes and goes, run the Flight Recorder while reproducing normal usage:

```bash
npm run recorder -- example.com
```

When the trigger fires, Faultline preserves the before/trigger/during/after chronology and candidate conditions that can be sent into Network Bisect.

## Use Live Diagnostics for surrounding evidence

```bash
npm start
```

Open `http://localhost:3000`, unlock live data and run a diagnostic against the failing target. The dashboard can collect local DNS, TCP, TLS, HTTP, ICMP, traceroute, adapter, Wi-Fi, VPN and resolver state, with public routing and outage context kept separate from deterministic findings.

## What not to conclude

"It works on hotspot" proves only that the outcome differs under a broader environmental change. The hotspot may have changed several variables at once. A stronger conclusion comes from changing one condition at a time and confirming that the outcome follows that condition under repeated alternation.

See [Network Bisect](../NETWORK_BISECT.md), [Flight Recorder](../FLIGHT_RECORDER.md) and [Live Internet Data](../LIVE_INTERNET_DATA.md).
