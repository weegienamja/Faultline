# Faultline Remote Probe

The remote probe provides the second network vantage point in Faultline v0.4.

Its job is deliberately narrower than the Windows endpoint agent: independently test whether the same session target is reachable from another network, then contribute that evidence using a probe-scoped credential.

## Requirements

- Node.js 20 or newer
- network access to the Faultline control plane
- network access to the diagnostic target

The probe is portable and does not depend on PowerShell, `ping`, `traceroute` or packet-capture drivers.

## Authenticated use

Create a diagnostic session first:

```bash
npm run session -- \
  --target microsoft.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Faultline prints a probe command containing a session ID and a short-lived probe credential:

```bash
npm run probe -- \
  --session FL-6A1B2C3D4E \
  --token fl_pr_... \
  --api-base https://faultline.example.com \
  --name london-probe
```

The probe retrieves safe session metadata from:

```text
GET /api/sessions/:id
```

It then independently measures the session target and submits the result to:

```text
POST /api/probe-runs
```

The control plane verifies that the supplied credential belongs to the **probe role** for that session before accepting the result.

## Options

```text
--session <id>       Diagnostic session ID
--token <value>      Probe session credential
--api-base <url>     Faultline control-plane base URL
--name <value>       Friendly probe name
--dry-run            Collect without uploading
--json               Print the full payload
```

The probe token can alternatively be supplied through:

```text
FAULTLINE_PROBE_TOKEN
```

## Evidence collected

The current remote probe measures:

- DNS resolution success
- DNS lookup time
- resolved IP addresses
- target TCP reachability
- TCP connection time
- target HTTP reachability when applicable
- HTTP response time and status
- probe hostname and operating-system platform

It does not currently collect remote ICMP loss, jitter or traceroute data.

## Why this improves diagnosis

A single endpoint cannot reliably distinguish every target-service problem from a path that only affects that user.

A second vantage point gives Faultline a direct comparison:

```text
Endpoint fails     Remote succeeds
       \             /
        \           /
         correlation
              |
              v
   Endpoint path / policy
```

If both independent paths fail while the endpoint still has general internet access, the evidence shifts toward the target service instead.

## Probe ordering

v0.4 expects the endpoint contribution first.

If a probe attempts to attach before endpoint telemetry exists, the server returns a conflict response rather than creating a misleading remote-only incident.

This ordering can be relaxed later if Faultline introduces a more complete session state machine.

## Choosing a real second vantage point

Running the endpoint agent and remote probe on the same computer validates the software workflow but provides little diagnostic independence.

For meaningful comparison, run the probe from something such as:

- a VPS in another network
- a machine in a different office
- a home connection separate from the affected user
- a small hosted probe instance
- eventually, a registered Faultline probe fleet

## Session security

The probe credential is independent from the endpoint credential.

It:

- is random, high-entropy bearer material
- is scoped to one diagnostic session
- is accepted only for the remote-probe role
- expires with the session
- is stored only as a hash by the control plane

The raw probe credential is shown when the session is created. Treat it as a temporary secret.

When the control plane is remote, send the token only over HTTPS.

## Privacy

The remote probe does not capture packet payloads, user credentials or application content. Its payload can include the probe hostname, platform, target addresses and timing data.

## Current limitations

The probe is currently an on-demand CLI process rather than a registered long-lived service. It has no durable probe identity, health heartbeat or regional scheduling.

Those are logical future extensions once the single-session authentication model has been exercised in real deployments.
