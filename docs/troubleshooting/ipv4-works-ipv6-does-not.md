# IPv4 works but IPv6 does not

When a target works over IPv4 but fails over IPv6, the important distinction is whether the difference is a target property, a local capability problem or a path-specific network fault.

A failed IPv6 connection alone does not tell you which one.

## Reproduce the difference directly

```bash
npm run bisect -- example.com
```

Network Bisect can test the address-family axis without disabling IPv6 on the host. It applies the condition per connection, compares the result with the baseline and confirms a candidate discriminator with interleaved trials.

A full matrix is also available:

```bash
npm run bisect -- example.com --all
```

## Possible outcomes

### IPv4 passes and IPv6 consistently fails

If the result survives confirmation, Faultline can report address family as a reproducible discriminator. That establishes that changing the family changes the outcome. It does not automatically establish the root cause.

Useful follow-up evidence includes:

- whether the target publishes IPv6 addresses
- whether the local interface has usable IPv6 state
- whether the selected IPv6 route is valid
- where the IPv4 and IPv6 paths observably differ
- whether DNS returns different target sets by resolver
- whether the problem is stable or intermittent

### The target does not offer IPv6

That is a target property rather than evidence that the local network is broken. Faultline distinguishes target properties from local capability deficiencies so an unsupported family is not presented as a fault.

### The baseline changes between trials

If repeated trials disagree, Network Bisect refuses isolation and reports an unstable baseline rather than manufacturing a conclusion from noisy evidence.

## Capture transient dual-stack failures

If IPv6 only fails occasionally, start the Flight Recorder:

```bash
npm run recorder -- example.com
```

The Recorder tracks IPv4/IPv6 state, target reachability and changes around the trigger. A recorded change remains a temporal observation until a controlled experiment confirms that the condition changes the outcome.

## Inspect DNS and path evidence

Run the dashboard:

```bash
npm start
```

Live Diagnostics can collect DNS answers, TCP/TLS/HTTP state, ICMP, traceroute and adapter state for the real target. Public routing context can help explain what was observed but does not override the deterministic result.

## Avoid the common shortcut

Disabling IPv6 globally and seeing the application work is useful as a clue, but it changes the machine for every connection and usually changes more context than the one request being investigated. A per-connection comparison gives you a cleaner experiment and a record of what was actually tested.

See [Network Bisect](../NETWORK_BISECT.md), [Flight Recorder](../FLIGHT_RECORDER.md) and [Live Internet Data](../LIVE_INTERNET_DATA.md).
