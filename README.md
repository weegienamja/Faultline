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

The repository now also contains three working **v0.6 preview slices**:

1. **interactive inferred network topology** from passive Windows endpoint evidence
2. **ephemeral support diagnostics** using one-time invitation links and explicit consent
3. **packaged Windows client** built as a standalone `Faultline.exe` with a one-use browser-to-client handoff

### Implemented platform capabilities

- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- standalone Windows client preview that does not require Node/npm on the affected PC
- portable remote probe for Windows, Linux and macOS with Node.js 20+
- two-vantage endpoint + remote correlation
- persistent diagnostic sessions and telemetry
- short-lived role-scoped credentials
- one-time support invitations and launcher handoffs
- persistent registered `PRB-...` probe identities
- authenticated probe heartbeats and health
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
                  | registered probe registry      |
                  | invitation + client handoff    |
                  | heartbeat health + job queues  |
                  | deterministic correlation      |
                  +---------------+----------------+
                                  |
                +-----------------+------------------+
                |                                    |
                v                                    v
       Faultline.exe endpoint                Registered probe
       short-lived session                   long-lived identity
                |                                    |
       local topology + path                DNS / TCP / HTTP
                |                                    |
                +-----------------+------------------+
                                  |
                                  v
                         correlated incident
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/WINDOWS_CLIENT.md](docs/WINDOWS_CLIENT.md) and [ROADMAP.md](ROADMAP.md).

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

Unlock live data and choose **New diagnostic**, or use:

```bash
npm run invite -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --title "Teams calls dropping" \
  --customer "ABC Ltd" \
  --ttl 60 \
  --admin-token "$FAULTLINE_ADMIN_TOKEN" \
  --api-base https://faultline.example.com
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

## Register a persistent remote probe

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
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

The worker authenticates as its own identity, sends heartbeats, polls only its assigned jobs, measures endpoint-ready sessions and submits remote evidence.

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
disabled identity disabled
```

A worker does not self-declare that it is healthy; state derives from authenticated heartbeat age.

## Security model

```text
Admin token
  -> register probes, create sessions, view live control-plane data

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
- persistent state
- registered probe identity and health
- registered-probe HTTP lifecycle
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
- one administrator security domain
- no registered-probe credential rotation/revocation yet
- job polling rather than push/message-queue delivery
- no rate limiting
- no organisation/user accounts
- no audit log
- remote probes currently collect DNS/TCP/HTTP rather than full remote path telemetry
- Windows endpoint/client needs broader real-world testing across adapters, VPN clients and locked-down enterprise machines
- topology is best-effort endpoint inference rather than authoritative physical discovery
- packaged Windows client is unsigned until a code-signing pipeline/certificate is configured
- public Windows-client download hosting is deployment-configured rather than built into the control plane
- `.faultline` handoff currently relies on a downloaded file rather than an installed custom URI handler

## Roadmap

The full roadmap is tracked in [ROADMAP.md](ROADMAP.md).

The broader **v0.6** milestone now contains:

1. **ephemeral support diagnostics**: invitation, consent, one-use launcher handoff and packaged Windows client preview implemented
2. **interactive inferred topology**: passive Windows discovery and draggable graph implemented
3. **probe fleet intelligence and safety**: geography/tag-based selection, credential lifecycle controls and restrictions preventing public probes from becoming arbitrary scanners remain to be built

The packaged client still needs signing, release/distribution hardening and real-world Windows testing before v0.6 can be called complete.

Later milestones cover Connectivity Contracts, richer remote path evidence, support cases and signed evidence packages, cross-party troubleshooting, hosted SaaS architecture, integrations and multi-vantage incident analysis.

## Status

Faultline currently demonstrates that a support platform can correlate evidence from independently operated network vantage points while keeping identity, access, consent, topology inference and fault-domain reasoning explicit and testable.

It is not intended to become a generic replacement for production network-observability platforms.

## License

MIT
