# Faultline Remote Probe

The remote probe provides the independent network vantage point in Faultline.

In v0.5 the preferred operating model is a **registered long-running worker** with durable identity and heartbeat health. The older one-off session probe remains available for ad hoc testing and backwards compatibility.

## Requirements

- Node.js 20 or newer
- network access to the Faultline control plane
- network access to diagnostic targets

The worker is portable and does not depend on PowerShell, `ping`, `traceroute` or packet-capture drivers.

## Registered worker mode

Register a probe once:

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Then run the returned probe identity continuously:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

The worker heartbeats, polls its assigned job queue, measures ready sessions, and uploads the remote evidence.

See [PROBE_FLEET.md](PROBE_FLEET.md) for the complete fleet model.

## Registered worker options

```text
--probe <id>          Registered probe ID
--token <value>       Registered probe credential
--api-base <url>      Faultline control-plane base URL
--watch               Keep polling after each cycle
--interval <seconds>  Poll interval, 15-300, default 30
--dry-run             Measure discovered jobs without uploading
--json                Print full measurement payloads
```

The token can be supplied through:

```text
FAULTLINE_PROBE_TOKEN
```

## One-off session mode

If a session was created without assigning a registered probe, Faultline still returns a short-lived `fl_pr_...` credential.

Run:

```bash
npm run probe -- \
  --session FL-6A1B2C3D4E \
  --token fl_pr_... \
  --api-base https://faultline.example.com \
  --name ad-hoc-probe
```

The one-off mode retrieves safe session metadata, measures that target once, submits the result and exits.

## Evidence collected

The remote probe currently measures:

- DNS resolution success
- DNS lookup time
- resolved IP addresses
- target TCP reachability
- TCP connection time
- target HTTP reachability when applicable
- HTTP response time and status
- worker hostname/platform/runtime metadata

It does not currently collect remote ICMP loss, jitter or traceroute data.

## Why this improves diagnosis

A single endpoint cannot reliably distinguish every target-service problem from a path that only affects that user.

```text
Endpoint fails     Remote succeeds
       \             /
        \           /
         correlation
              |
              v
   Endpoint path / policy
```

If both independent paths fail while the endpoint still has general internet access, evidence shifts toward the target service.

## Ordering

Faultline expects endpoint evidence before a remote result is attached.

For registered probes, a job is not exposed until endpoint evidence exists. For one-off probes, attempting to submit before endpoint evidence returns a conflict response.

## Choosing a useful vantage point

A remote probe should traverse a meaningfully independent path. Suitable locations include:

- VPS on another provider
- another office
- separate home broadband
- another cloud region/provider
- branch site

Running both vantage points from the same host validates software flow but provides little diagnostic independence.

## Security

### Registered mode

The durable registered-probe credential authenticates one probe identity. It can heartbeat, read that probe's jobs, and submit evidence for sessions assigned to it.

### One-off mode

The short-lived `fl_pr_...` token is scoped to a single diagnostic session and expires with it.

Both are bearer credentials. Use HTTPS for any non-local control plane.

## Privacy

The remote probe does not capture packet payloads, user credentials, browser history or application content. It can submit worker identity metadata, target addresses and timing data.

## No AI dependency

Remote measurements and their correlation are deterministic. No AI API is used by the probe or diagnosis engine.
