# VPN connected but an internal service is unreachable

A VPN client can report "connected" while an internal application still cannot be reached. That status only proves the tunnel established. It does not prove that the target route exists, the name resolves correctly, the selected interface can reach the destination or the application protocol succeeds.

## Test the actual internal target

Where the target is resolvable and reachable from the host environment, run Network Bisect against the service itself:

```bash
npm run bisect -- internal.example --all
```

The useful comparison is not "VPN on versus VPN off" by itself. Look for the specific condition that changes the outcome, such as source interface, resolver, resolved address, address family or protocol behaviour.

## Check the routing boundary

A common failure shape is:

```text
VPN tunnel: connected
Internal DNS: resolves
Expected internal route: absent
Target: unreachable
```

That is stronger evidence than the VPN status alone, but it is still a state observation. It tells you the expected route was not present at collection time. It does not prove why the route is absent.

Faultline's local diagnostics can record VPN, adapter, route and resolver state alongside the target result so the incident can be handed to the next person with the relevant evidence attached.

## Check DNS separately from reachability

Internal applications often depend on private DNS. Distinguish:

- hostname does not resolve
- hostname resolves to an unexpected address
- name resolves correctly but TCP cannot connect
- TCP connects but TLS or HTTP fails

Those are different failure boundaries and should not be collapsed into "VPN issue".

## Use Flight Recorder when the route disappears intermittently

```bash
npm run recorder -- internal.example
```

If a target transitions from pass to fail, the Recorder freezes network state around the event. It can preserve resolver, interface and route changes as candidates for later testing.

A route change at the same time as failure is a candidate, not proof of cause. Network Bisect is the stronger workflow when the condition can be varied safely and retested.

## Run Live Diagnostics for a current failure

```bash
npm start
```

Open `http://localhost:3000`, unlock live data and test the internal target. Local addresses, SSIDs and VPN routes are not sent to public enrichment services. Public enrichment is only used where the target data is safe and globally routable.

## Useful evidence to preserve

When escalating a VPN-related reachability problem, capture:

- target hostname and resolved address
- target port
- active interfaces
- VPN state
- expected route presence
- DNS resolver state
- IPv4/IPv6 result
- TCP/TLS/HTTP stage reached
- timestamps around the failure
- any confirmed Network Bisect discriminator

See [Network Bisect](../NETWORK_BISECT.md), [Flight Recorder](../FLIGHT_RECORDER.md), [Live Internet Data](../LIVE_INTERNET_DATA.md) and [Portable Incident Capsule](../INCIDENT_CAPSULE.md).
