# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline addresses a recurring support problem: every team can see its own part of a connection, but nobody has enough shared evidence to say where a fault actually begins.

Rather than becoming another wall of network metrics, Faultline correlates observations from explicit vantage points into a likely **fault domain**, shows the evidence behind that conclusion and recommends the next action.

```text
Endpoint -> Wi-Fi/LAN -> ISP -> Internet transit -> SaaS / application
```

The user sees a broken application. Internal IT sees a healthy LAN. The ISP sees an active circuit. The SaaS provider sees healthy servers. Faultline is intended to bridge those viewpoints without requiring every party to share full administrative access.

## Current state

The stable platform work is **v0.5**, which introduced the persistent registered remote-probe fleet.

The repository now also contains four working **v0.6 preview slices**:

1. **ephemeral support diagnostics** using one-time invitation links and explicit consent
2. **interactive inferred network topology** from passive Windows endpoint evidence
3. **probe fleet intelligence and safety** with automatic scheduling, public/private scope and credential lifecycle controls
4. **packaged Windows client** built as a standalone `Faultline.exe` with a one-use browser-to-client handoff

### Implemented platform capabilities

- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- standalone Windows client preview that does not require Node/npm on the affected PC
- portable registered remote probe for Windows, Linux and macOS with Node.js 20+
- two-vantage endpoint + remote correlation
- persistent diagnostic sessions and telemetry
- short-lived role-scoped credentials
- one-time support invitations and launcher handoffs
- persistent registered `PRB-...` probe identities
- authenticated probe heartbeats and derived health
- automatic probe selection by scope, country, region and tags
- least-loaded scheduling across matching online probes
- public/private probe trust scopes
- public-probe destination and port policy
- connection-time DNS and HTTP redirect revalidation
- drain and maintenance modes
- registered-probe credential rotation and revocation
- bounded probe lifecycle audit events
- per-probe private job queues
- admin-visible probe fleet
- interactive inferred local Network Map
- Docker and Docker Compose deployment
- public deterministic demo incidents
- admin-protected live telemetry
- zero third-party **runtime** dependencies

## No AI API by design

Faultline does **not** use an AI or LLM API.

The inputs are structured network measurements and the fault domains are explicit. The diagnosis path stays reproducible:

```text
same evidence -> same rules -> same diagnosis
```

That makes the result easier to test, explain and defend during a support escalation.

## Architecture

```text
                         Faultline control plane
                  +--------------------------------+
                  | persistent sessions + runs     |
                  | probe registry + scheduler     |
                  | invitation + client handoff    |
                  | lifecycle audit + job queues   |
                  | deterministic correlation      |
                  +---------------+----------------+
                                  |
                +-----------------+------------------+
                |                                    |
                v                                    v
       Faultline.exe endpoint                Registered probe
       short-lived session                   public/private scope
                |                                    |
       local topology + path               target policy + tests
                |                                    |
                +-----------------+------------------+
                                  |
                                  v
                         correlated incident
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/FLEET_SAFETY.md](docs/FLEET_SAFETY.md), [docs/WINDOWS_CLIENT.md](docs/WINDOWS_CLIENT.md) and [ROADMAP.md](ROADMAP.md).

## Run Faultline locally

Requires Node.js 20 or newer for the control plane.

```bash
npm start
```

If `FAULTLINE_ADMIN_TOKEN` is not configured, Faultline generates a temporary development credential and prints it to the terminal.

For a stable local credential:

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_change_this_to_a_long_random_value"
npm start
```

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

Then open:

```text
http://localhost:3000
```

Demo incidents are public. Use **Unlock live data** with the administrator token to view live endpoint telemetry, the probe fleet and topology data.

## One-time support diagnostic

### Engineer workflow

Unlock live data and choose **New diagnostic**. The dashboard now defaults to:

```text
Automatic · best online public probe
```

Faultline selects an online registered probe matching the requested scope/location/tags and prefers the least-loaded eligible vantage. An engineer can still choose a specific probe or the one-off/assign-later path.

The CLI uses automatic public-probe selection by default:

```bash
npm run invite -- \
  --target microsoft.com \
  --title "Teams calls dropping" \
  --customer "ABC Ltd" \
  --ttl 60 \
  --admin-token "$FAULTLINE_ADMIN_TOKEN" \
  --api-base https://faultline.example.com
```

Optional scheduling constraints:

```bash
npm run invite -- \
  --target microsoft.com \
  --probe-country gb \
  --probe-region europe-west \
  --probe-tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Explicit override:

```bash
npm run invite -- --target microsoft.com --probe PRB-8A1B2C3D4E --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

One-off fallback:

```bash
npm run invite -- --target microsoft.com --one-off-probe --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Faultline returns a one-time link:

```text
https://faultline.example.com/diagnose#invite=fl_inv_...
```

Remote invitation links must use HTTPS. Plain HTTP remains acceptable for localhost development.

### User workflow

```text
Open one-time link
      |
      v
Review collection scope
      |
      | explicit consent
      v
Download .faultline handoff
      |
      v
Download / receive Faultline.exe
      |
      v
Double-click Faultline.exe
      |
      v
Automatic credential exchange
      |
      v
Network + topology tests
      |
      v
Automatic evidence upload
      |
      v
Assigned remote probe tests target
      |
      v
Correlated fault domain
```

The browser never receives the endpoint upload credential.

Consent consumes the invitation and creates a separate one-use `fl_launch_...` credential. The browser writes that launcher secret to a small `Faultline-FL-....faultline` handoff file. `Faultline.exe` exchanges it once for the endpoint credential and the control plane then invalidates the launcher secret.

The client searches the current directory, its executable directory and the user's Downloads folder for the newest matching handoff file. After a successful exchange it attempts to delete that file.

The consent page also allows local Network Map collection to be disabled before the handoff is created.

See [docs/EPHEMERAL_DIAGNOSTICS.md](docs/EPHEMERAL_DIAGNOSTICS.md) and [docs/WINDOWS_CLIENT.md](docs/WINDOWS_CLIENT.md).

## Build the standalone Windows client

The packaged client uses Node.js Single Executable Application support and contains only built-in Node modules plus Faultline's own collector code.

The build currently requires Node.js 26+ because it uses the built-in `--build-sea` workflow:

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
npm run build:windows-client
.\dist\Faultline.exe --self-test
```

GitHub Actions performs the build on `windows-latest`, runs the packaged executable self-test and uploads `Faultline.exe` as the `faultline-windows-client` workflow artifact.

To expose a public download from the consent page, configure:

```text
FAULTLINE_WINDOWS_CLIENT_URL=https://downloads.example.com/Faultline.exe
```

Until a code-signing certificate is configured, CI produces an **unsigned preview executable**. Windows may therefore show normal reputation/SmartScreen warnings. Code signing and a stable release channel are required before treating the client as production-ready.

## v0.6 topology preview

The Windows endpoint can read passive local-network evidence:

- active IPv4 interface and address
- adapter MAC address
- default gateway
- current Wi-Fi SSID/BSSID, signal, radio type and channel
- existing Windows IPv4 neighbour table

Faultline converts those observations into an inferred graph with:

- draggable device nodes
- device-type glyphs
- solid links for observed relationships
- dashed links for inferred relationships
- star / tree / mesh / unknown classification
- high / medium / low confidence markers
- diagnosis-aware affected-path overlays

The implementation intentionally **does not sweep the subnet**. Unknown LAN devices come from the existing neighbour cache. A same-vendor BSSID/gateway pattern is only low-confidence evidence consistent with a mesh, never proof.

See [docs/TOPOLOGY.md](docs/TOPOLOGY.md).

## Probe fleet intelligence and safety

### Register a public probe

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --country gb \
  --region europe-west \
  --scope public \
  --tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Run the registered worker:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

The worker authenticates as its own identity, sends heartbeats, polls only its assigned jobs, applies its own target policy, measures endpoint-ready sessions and submits remote evidence.

### Public versus private probes

A **public** probe is intended for Internet-routable services. It rejects private, loopback, link-local, shared, documentation, multicast/reserved and mapped-private addresses. Public probes currently restrict destination ports to a conservative allow-list.

A **private** probe is an explicitly trusted internal-network vantage. It may reach private address space and non-public ports, so it should only be deployed where that access is intentional and authorised.

Public target safety is enforced in the worker immediately before connection. DNS answer sets are validated, TCP uses a validated address, and every HTTP redirect is resolved and checked again before being followed. A control-plane job is therefore not treated as permission to connect blindly.

### Scheduling

Sessions can request a selector rather than a fixed probe ID:

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

The scheduler excludes probes that are disabled, revoked, stale/offline, draining or in maintenance. Among matching online probes it chooses the least-loaded candidate and persists the selection metadata with the session.

### Lifecycle controls

Registered probes support:

- enable/disable
- drain mode
- maintenance mode
- country/region/tag/scope updates
- credential rotation
- credential revocation

Admin API:

```text
PATCH /api/probes/:id
POST  /api/probes/:id/rotate
POST  /api/probes/:id/revoke
GET   /api/audit
```

Credential rotation invalidates the previous probe secret immediately and returns the replacement once. Revocation clears the stored credential hash and disables the identity.

See [docs/FLEET_SAFETY.md](docs/FLEET_SAFETY.md) and [docs/PROBE_FLEET.md](docs/PROBE_FLEET.md).

## Direct diagnostic session

The existing engineer-controlled workflow remains available for controlled testing or already-managed machines:

```bash
npm run session -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

This direct mode returns the endpoint token immediately.

```bash
npm run agent -- \
  --session FL-1234567890 \
  --token fl_ep_... \
  --api-base https://faultline.example.com
```

Use `--no-topology` to suppress topology collection, or `--dry-run --json` for a local payload preview.

## Topology model

Topology telemetry is stored under `telemetry.topology`:

```json
{
  "version": 1,
  "kind": "tree",
  "confidence": "medium",
  "nodes": [],
  "links": [],
  "affectedPath": [],
  "discovery": {
    "mode": "passive",
    "activeScan": false
  }
}
```

Current classifications:

```text
star     gateway-centred local network
tree     separate wireless access layer visible
mesh     low-confidence same-vendor wireless-hop evidence
unknown  insufficient default-gateway evidence
```

Endpoint-only discovery cannot prove every physical relationship. Faultline distinguishes **observed facts** from **inferred links** instead of claiming a perfect physical diagram.

## Probe health

```text
<= 90 seconds     online
<= 5 minutes      stale
> 5 minutes       offline
draining          online but no new assignments
maintenance       registered but job queue withheld
disabled          identity disabled
revoked           credential removed and identity disabled
```

A worker does not self-declare that it is healthy; state derives from authenticated heartbeat age plus administrator-controlled lifecycle state.

## Security model

```text
Admin token
  -> register/manage probes, create sessions, view live control-plane data

Invitation token
  -> preview + consent to one ephemeral support session

Client launcher token
  -> one exchange for the endpoint credential

Endpoint session token
  -> submit endpoint evidence for one short-lived session

Registered probe token
  -> heartbeat, read assigned jobs, submit assigned remote evidence
```

Important properties:

- raw invitation, launcher, endpoint and probe secrets are not persisted; hashes are stored instead
- the invitation cannot upload endpoint evidence
- browser consent does not expose the endpoint credential
- the launcher can be exchanged only once
- launcher exchange is locked to its session
- the endpoint credential expires with the diagnostic session
- the `.faultline` file contains a live one-use bearer secret and should be treated as sensitive until exchanged
- hosted deployments should use HTTPS
- public registered probes independently validate destination address/port immediately before connecting
- public HTTP redirects are revalidated before following
- registered probe submissions have a basic in-memory rate limit in the single-process prototype
- probe lifecycle changes and assignments generate bounded audit events
- the SEA build disables Node execution-argument extension so `NODE_OPTIONS` cannot extend runtime options in the packaged client

### Topology privacy

Topology may contain local IPv4 addresses, MAC addresses and Wi-Fi BSSID information. The user can disable this collection before activating an ephemeral diagnostic.

## Tests and CI

```bash
npm run check
npm test
```

Coverage includes:

- deterministic fault-domain diagnosis
- Windows command parsing
- remote target normalization
- evidence correlation
- session authentication and expiry
- persistent state and store migration
- registered probe identity and health
- automatic probe scheduling
- target address/port policy
- private/mapped IPv4/IPv6 rejection for public probes
- registered-probe credential rotation and revocation
- drain/maintenance lifecycle state
- lifecycle audit persistence
- complete registered-probe HTTP lifecycle
- topology inference and MAC normalization
- invitation creation and consent enforcement
- invitation-secret invalidation
- launcher credential creation and one-time exchange
- endpoint credential creation only inside the Windows-client exchange
- invitation/client HTTP lifecycle and restart persistence

CI runs syntax checks, the Node test suite and Docker build on Linux. A separate Windows job builds `Faultline.exe`, executes `--self-test` on the generated binary and publishes the binary as a workflow artifact.

## Current limitations

Faultline remains a controlled prototype rather than a production multi-tenant observability platform.

- JSON-file persistence rather than a transactional database
- one process / one writer assumption
- one administrator security domain rather than named users/organisations
- scheduler decisions are single-process and do not use distributed leases
- registered-probe rate limiting is in-memory rather than distributed/persistent
- audit events record lifecycle actions but do not yet identify individual human actors
- public-probe target policy and port allow-list are static rather than tenant-configurable policy objects
- job polling rather than push/message-queue delivery
- no organisation quotas or per-target abuse controls
- remote probes currently collect DNS/TCP/HTTP rather than full remote path telemetry
- Windows endpoint/client needs broader real-world testing across adapters, VPN clients and locked-down enterprise machines
- topology is best-effort endpoint inference rather than authoritative physical discovery
- packaged Windows client is unsigned until a code-signing pipeline/certificate is configured
- public Windows-client download hosting is deployment-configured rather than built into the control plane
- `.faultline` handoff currently relies on a downloaded file rather than an installed custom URI handler

## Roadmap

The full roadmap is tracked in [ROADMAP.md](ROADMAP.md).

The broader **v0.6** milestone now contains four working preview slices:

1. **ephemeral support diagnostics**: invitation, consent and one-use launcher handoff implemented
2. **interactive inferred topology**: passive Windows discovery and draggable graph implemented
3. **probe fleet intelligence and safety**: automatic selection, public/private scope, destination policy and credential lifecycle implemented
4. **packaged Windows client**: standalone executable build and browser-to-client handoff implemented

The core v0.6 workflow is now feature-complete as a preview. Production hardening still includes Windows code signing/distribution, real-world endpoint testing, distributed scheduling/rate controls and stronger tenant/audit boundaries.

Later milestones cover Connectivity Contracts, richer remote path evidence, support cases and signed evidence packages, cross-party troubleshooting, hosted SaaS architecture, integrations and multi-vantage incident analysis.

## Status

Faultline currently demonstrates that a support platform can correlate evidence from independently operated network vantage points while keeping identity, access, consent, topology inference, probe safety and fault-domain reasoning explicit and testable.

It is not intended to become a generic replacement for production network-observability platforms.

## License

MIT
