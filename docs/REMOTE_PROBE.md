# Faultline Remote Probe

The remote probe provides the second network vantage point in Faultline v0.3.

Its job is deliberately narrower than the Windows endpoint agent: independently test whether the same target is reachable from another network, then attach that evidence to the existing live run.

## Requirements

- Node.js 20 or newer
- network access to the Faultline server
- network access to the diagnostic target

The probe is portable and does not depend on PowerShell, `ping`, `traceroute` or packet-capture drivers.

## Basic use

First create a live endpoint run:

```bash
npm run agent -- --target microsoft.com
```

The endpoint agent prints a run ID, for example `LIVE-ME5X2F`.

On a second machine or network:

```bash
npm run probe -- \
  --run LIVE-ME5X2F \
  --api-base http://FAULTLINE-SERVER:3000 \
  --name london-probe
```

The probe retrieves the target metadata for that run from:

```text
GET /api/agent-runs/:id
```

It then collects its own measurements and submits them to:

```text
POST /api/probe-runs
```

The server attaches the result to the endpoint run, recalculates the diagnosis and returns the correlated incident.

## Options

```text
--run <id>          Existing Faultline live run ID
--api-base <url>    Faultline server base URL
--name <value>      Friendly probe name
--dry-run           Collect without uploading
--json              Print the full payload
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

A second vantage point gives Faultline a comparison:

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

## Choosing a real second vantage point

Running the endpoint agent and remote probe on the same computer validates the software workflow but provides little diagnostic independence.

For meaningful comparison, run the probe from something such as:

- a VPS in another network
- a machine in a different office
- a home connection separate from the affected user
- a small hosted probe instance
- eventually, a registered Faultline probe fleet

## Privacy and security

The remote probe does not capture packet payloads or credentials. Its payload can include the probe hostname, platform, target addresses and timing data.

In v0.3, the live run ID is only a correlation identifier. It is **not a security token**. Do not expose the current ingestion API publicly without authentication and transport controls.

Use `--dry-run --json` to inspect the probe payload before uploading it.
