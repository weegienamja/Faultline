# Faultline registered probe fleet

Faultline's registered probe fleet provides durable independent network vantage points. v0.5 introduced persistent probe identities and private job queues; v0.6 adds automatic scheduling, public/private scope and lifecycle controls.

A registered probe is intended to run continuously from a useful network such as a VPS, branch office, customer site, private enterprise network or regional cloud instance.

## Registered-probe capabilities

A registered probe has:

- durable `PRB-...` identity
- bearer credential persisted only as a hash by the control plane
- authenticated heartbeat state
- runtime metadata
- country/region/tag scheduling metadata
- explicit `public` or `private` trust scope
- private job queue
- explicit or automatic session assignment
- drain and maintenance lifecycle state
- credential rotation and revocation
- fleet health in the engineer dashboard

## Register a public probe

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --country gb \
  --region europe-west \
  --scope public \
  --tags uk,vps \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The raw credential is returned once. Store it on the probe host as a secret.

```bash
export FAULTLINE_PROBE_TOKEN='fl_probe_...'
```

A public probe is intended for Internet-routable targets and enforces Faultline's public-target policy locally. See [FLEET_SAFETY.md](FLEET_SAFETY.md).

## Register a private probe

A private probe is an explicitly trusted internal-network vantage:

```bash
npm run probe:register -- \
  --name glasgow-office \
  --location "Glasgow office" \
  --country gb \
  --region scotland \
  --scope private \
  --tags office,internal \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Private scope permits private address space and non-public ports. It should only be used where that access is intended and authorised.

## Run a worker

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

Without `--watch`, the worker performs one heartbeat/job cycle and exits. With `--watch`, it repeats the cycle. The default interval is 30 seconds; accepted values are 15 to 300 seconds.

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
  +-- job
        |
        v
     apply local target policy
        |
        v
     DNS / TCP / HTTP checks
        |
        v
     POST remote evidence
        |
        v
     correlated diagnosis
```

The worker does not blindly trust the target in its job queue. A public worker independently resolves and validates the destination immediately before connecting and revalidates redirect destinations.

## Probe health and lifecycle

Health is derived from authenticated heartbeat age plus administrator-controlled lifecycle state.

| State | Meaning |
|---|---|
| `online` | heartbeat within 90 seconds and accepting work |
| `draining` | online but excluded from new automatic assignments |
| `stale` | last heartbeat between 90 seconds and 5 minutes |
| `offline` | no heartbeat for more than 5 minutes or never seen |
| `maintenance` | identity retained but jobs withheld and scheduling disabled |
| `disabled` | identity administratively disabled |
| `revoked` | credential hash removed and identity disabled |

Authenticated job polling refreshes the probe's last-seen timestamp because successful polling demonstrates control-plane reachability.

## Automatic scheduling

An engineer no longer needs to choose a probe ID for every diagnostic.

A session may request:

```json
{
  "probeSelector": {
    "scope": "public",
    "country": "gb",
    "region": "europe-west",
    "tags": ["uk"]
  }
}
```

The scheduler considers only matching probes that are online, enabled, not revoked, not in maintenance and not draining. It then selects the least-loaded candidate, using recent heartbeat and stable ID ordering for ties.

The support dashboard and `npm run invite` default to automatic public-probe selection.

CLI example:

```bash
npm run invite -- \
  --target microsoft.com \
  --probe-country gb \
  --probe-region europe-west \
  --probe-tags uk \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

## Explicit assignment

Explicit assignment remains available when the engineer needs a specific vantage:

```bash
npm run invite -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The session stores both `assignedProbeId` and selection metadata indicating whether the choice was explicit or automatic.

The job does not appear until endpoint evidence exists. This avoids asking remote workers to test sessions that the affected endpoint has not sampled yet.

## Credential rotation

Administrators can rotate a registered probe credential:

```text
POST /api/probes/:id/rotate
Authorization: Bearer <admin-token>
```

The old credential is invalidated immediately. The replacement credential is returned once and only its hash is persisted.

Update the secret on the worker host before restarting the worker with the replacement credential.

## Revocation

```text
POST /api/probes/:id/revoke
Authorization: Bearer <admin-token>
```

Revocation:

- clears the stored token hash
- disables the identity
- stops future authenticated worker access
- removes it from scheduling

## Drain and maintenance

Lifecycle metadata can be changed with:

```text
PATCH /api/probes/:id
Authorization: Bearer <admin-token>
```

Drain example:

```json
{
  "draining": true
}
```

A draining probe remains authenticated and may finish already-assigned work but receives no new automatic sessions.

Maintenance example:

```json
{
  "maintenance": true
}
```

Maintenance withholds its job queue and excludes it from scheduling while keeping the identity registered.

## Security boundary

A registered-probe token authorizes:

- reading that probe's public identity
- heartbeat for that probe
- reading that probe's assigned job queue
- submitting remote evidence for sessions assigned to that probe

It does **not** authorize:

- creating sessions
- viewing the global incident list
- reading another probe's queue
- submitting endpoint evidence
- submitting evidence for another registered probe
- changing its own scope/lifecycle policy

Public probes additionally enforce destination policy in the worker itself.

## Audit

Probe registration, lifecycle changes, credential rotation/revocation and session assignment create bounded audit records in the prototype state store.

Administrators can inspect them with:

```text
GET /api/audit
```

These records currently identify the probe/action, not an individual human user because the prototype still has one administrator security domain.

## Running as a service

A long-running probe host should use a process supervisor rather than an interactive shell.

Example systemd unit:

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

A useful fleet should represent genuinely different network paths, for example:

- London VPS
- Frankfurt VPS
- customer office
- home broadband
- branch location
- another cloud provider

Multiple probes in the same subnet provide less diagnostic independence than probes spread across providers/access networks.

Scheduling metadata is intentionally explicit rather than inferred from the probe's public IP in this preview. Country and region therefore describe the administrator's intended scheduling label.

## Privacy

A registered probe submits:

- probe identity and scheduling scope
- runtime version/platform/hostname
- DNS results
- target TCP and HTTP timings
- resolved target addresses

It does not capture packet payloads, browser data, credentials or application content.

## No AI dependency

Probe health, scheduling, target policy, job assignment, reachability and correlation are deterministic. No AI API is involved in probe operation or fault-domain diagnosis.
