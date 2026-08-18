# Faultline registered probe fleet

Faultline v0.5 introduces durable remote-probe identities. A registered probe is intended to run continuously from a network that provides a useful independent vantage point, such as a VPS, branch office, home connection, or regional cloud instance.

## Why register probes?

The earlier one-off probe model proved that a second vantage point improves fault isolation, but it had no persistent identity or operational health.

A registered probe adds:

- a durable `PRB-...` identity
- a long-lived bearer credential stored only as a SHA-256 hash by the control plane
- authenticated heartbeat state
- runtime metadata
- a private job queue
- explicit session assignment
- fleet health in the engineer dashboard

## Register a probe

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --tags uk,vps \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The command returns the probe credential once. Store that credential on the probe host as a secret.

Example environment variable:

```bash
export FAULTLINE_PROBE_TOKEN='fl_probe_...'
```

## Run a worker

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

Without `--watch`, the worker performs one heartbeat/job cycle and exits.

With `--watch`, it repeats the cycle. The default interval is 30 seconds:

```bash
npm run probe -- --probe PRB-8A1B2C3D4E --token "$FAULTLINE_PROBE_TOKEN" --watch --interval 30
```

Accepted interval range is 15 to 300 seconds.

## Worker lifecycle

```text
start
  |
  v
authenticate probe identity
  |
  v
POST heartbeat
  |
  v
GET assigned jobs
  |
  +-- no jobs -> sleep -> repeat
  |
  +-- jobs
        |
        v
     DNS/TCP/HTTP checks
        |
        v
     POST remote evidence
        |
        v
     correlated diagnosis
```

## Probe health

The worker does not declare itself healthy. The control plane derives health from the persisted `lastSeenAt` heartbeat timestamp.

| State | Meaning |
|---|---|
| `online` | heartbeat within 90 seconds |
| `stale` | last heartbeat between 90 seconds and 5 minutes |
| `offline` | no heartbeat for more than 5 minutes, or never seen |
| `disabled` | identity has been administratively disabled |

A worker polling the jobs endpoint also refreshes its last-seen timestamp because successful authenticated polling demonstrates control-plane reachability.

## Assign work to a probe

Create the diagnostic session with a registered probe ID:

```bash
npm run session -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The session stores `assignedProbeId`.

The probe job does not appear until endpoint evidence exists. This avoids asking remote workers to test sessions that the affected endpoint has not actually sampled yet.

A worker receives only sessions assigned to its own authenticated probe identity.

## Security boundary

The registered-probe token authorizes:

- reading that probe's public identity
- heartbeat for that probe
- reading that probe's job queue
- submitting remote evidence for sessions assigned to that probe

It does **not** authorize:

- creating sessions
- viewing the global live incident list
- reading another probe's queue
- submitting endpoint evidence
- submitting evidence for sessions assigned to another registered probe

The current token is intentionally long-lived so a daemon can stay running. Explicit revocation and rotation are not implemented yet.

## Running as a service

A production-style probe host should run the worker under a process supervisor rather than an interactive shell.

A simple systemd unit can use an environment file for the token:

```ini
[Unit]
Description=Faultline registered remote probe
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/faultline
EnvironmentFile=/etc/faultline-probe.env
ExecStart=/usr/bin/npm run probe -- --probe PRB-8A1B2C3D4E --api-base https://faultline.example.com --watch
Restart=always
RestartSec=5
User=faultline

[Install]
WantedBy=multi-user.target
```

`/etc/faultline-probe.env`:

```text
FAULTLINE_PROBE_TOKEN=fl_probe_...
```

Protect the environment file with operating-system permissions.

## Choosing probe locations

A useful probe fleet should represent meaningfully different network paths. Examples:

- London VPS
- Frankfurt VPS
- customer office
- home broadband
- branch location
- another cloud provider

Running multiple probes in the same subnet provides less diagnostic independence than placing them on distinct providers or access networks.

v0.5 still assigns one registered probe explicitly per diagnostic session. Tag- or geography-based automatic selection is future work.

## Privacy

A registered probe submits:

- probe identity
- runtime version/platform/hostname
- DNS results
- target TCP and HTTP timings
- resolved target addresses

It does not capture packet payloads, browser data, credentials, or application content.

## No AI dependency

Probe health, job assignment, reachability and correlation are all deterministic. No AI API is involved in probe operation or fault-domain diagnosis.
