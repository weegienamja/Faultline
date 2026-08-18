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

The repository now also contains two working **v0.6 previews**:

1. **interactive inferred network topology** from passive Windows endpoint evidence
2. **ephemeral support diagnostics** using one-time invitation links, explicit consent and delayed endpoint-credential creation

### Implemented platform capabilities

- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- portable remote probe for Windows, Linux and macOS with Node.js 20+
- two-vantage endpoint + remote correlation
- persistent diagnostic sessions and telemetry
- short-lived role-scoped endpoint credentials
- persistent registered `PRB-...` probe identities
- hashed registered-probe credentials
- authenticated heartbeats
- online / stale / offline / disabled probe health
- per-probe private job queues
- registered probe worker mode
- admin-visible probe fleet
- Docker and Docker Compose deployment
- public deterministic demo incidents
- admin-protected live telemetry
- zero third-party runtime dependencies

### v0.6 topology preview

The endpoint collector can now read passive local-network evidence from Windows:

- active IPv4 interface and address
- adapter MAC address
- default gateway
- current Wi-Fi SSID/BSSID, signal, radio type and channel
- existing Windows IPv4 neighbour table

Faultline converts those observations into an inferred graph containing device nodes, relationships, confidence and an affected path.

The dashboard renders that graph using:

- draggable device nodes
- device-type glyphs
- solid links for directly observed relationships
- dashed links for inferred relationships
- star / tree / mesh / unknown topology classification
- high / medium / low confidence markers
- diagnostic overlays for likely affected local or upstream segments

The first implementation is intentionally conservative. It **does not actively sweep the subnet**. Unknown LAN devices come from the endpoint's existing neighbour cache.

A mesh result is also not presented as certainty. A separate serving BSSID that shares the gateway MAC OUI is treated only as low-confidence evidence consistent with a mesh or same-vendor AP hop.

See [docs/TOPOLOGY.md](docs/TOPOLOGY.md).

### v0.6 ephemeral diagnostic preview

Faultline can now create a one-time support diagnostic for a Windows device that is not already enrolled or managed by the platform.

The intended support flow is:

```text
Support engineer
      |
      | create diagnostic
      v
One-time invitation link
      |
      v
Affected user reviews collection scope
      |
      | explicit consent
      v
Short-lived endpoint credential minted
      |
      v
Windows collector
      |
      v
Endpoint evidence + Network Map
      |
      v
Remote probe + deterministic diagnosis
```

The endpoint credential does **not** exist when the support invitation is created. It is generated only after the user claims the invitation and explicitly consents.

The invitation secret is included in the browser URL fragment:

```text
https://faultline.example.com/diagnose#invite=fl_inv_...
```

The page removes that fragment from the address bar after reading it. The raw invitation secret is stored by the control plane only as a SHA-256 hash and is invalidated after a successful claim.

The consent page tells the user what Faultline will and will not collect and allows Network Map collection to be disabled before activation.

See [docs/EPHEMERAL_DIAGNOSTICS.md](docs/EPHEMERAL_DIAGNOSTICS.md).

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
                  | invitation + endpoint auth     |
                  | heartbeat health + job queues  |
                  | deterministic correlation      |
                  +---------------+----------------+
                                  |
                +-----------------+------------------+
                |                                    |
                v                                    v
        Windows endpoint                    Registered probe
        short-lived token                   long-lived identity
                |                                    |
       local topology + path                DNS / TCP / HTTP
                |                                    |
                +-----------------+------------------+
                                  |
                                  v
                         correlated incident
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the deeper architecture and [ROADMAP.md](ROADMAP.md) for the product roadmap.

## Run Faultline locally

Requires Node.js 20 or newer.

```bash
npm start
```

If `FAULTLINE_ADMIN_TOKEN` is not configured, Faultline generates a temporary development credential and prints it to the terminal.

For a stable local credential:

### PowerShell

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_change_this_to_a_long_random_value"
npm start
```

### Bash / zsh

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_change_this_to_a_long_random_value'
npm start
```

Then open:

```text
http://localhost:3000
```

Demo incidents are public. Use **Unlock live data** with the administrator token to view live endpoint telemetry, the probe fleet and topology data.

## Create a one-time support diagnostic

### Dashboard

Unlock live data and choose **New diagnostic**.

Enter the target, optional case/customer labels, expiry and optional registered probe. Faultline returns a one-time link that can be copied directly to the affected user.

The engineer does not receive the endpoint token. The endpoint token is created later when the user consents.

### CLI

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

Remote invitation links must use HTTPS. Plain HTTP remains allowed for local development on `localhost` / loopback.

The user opens `/diagnose`, reviews the collection scope and activates the session. The page then produces the authenticated endpoint command for that one session.

### Current endpoint handoff limitation

The secure invitation/session exchange is implemented, but the final zero-install endpoint experience is not yet complete.

The v0.6 preview currently expects the affected Windows device to have the Faultline repository and Node.js 20+ available, then returns a command such as:

```powershell
npm run agent -- --session FL-1234567890 --token fl_ep_... --api-base https://faultline.example.com
```

If Network Map collection is disabled during consent, the generated command includes:

```text
--no-topology
```

Packaging the Windows collector into a user-friendly executable/bootstrap flow remains a later v0.6 task.

## Register a persistent remote probe

From an administrative machine:

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --tags uk,vps \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

PowerShell:

```powershell
npm run probe:register -- --name london-1 --location "London, UK" --tags uk,vps --admin-token $env:FAULTLINE_ADMIN_TOKEN
```

Faultline returns a durable probe ID and the raw registered-probe credential once. Only the credential hash is persisted by the control plane.

Run the registered worker on the VPS or independent network:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

The worker authenticates as its own identity, sends heartbeats, polls only its assigned jobs, measures endpoint-ready sessions and submits the remote evidence.

## Direct diagnostic session

The existing engineer-controlled session workflow remains available:

```bash
npm run session -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

This direct mode still returns the endpoint token immediately and is useful for controlled testing or already-managed machines.

Run the generated endpoint command on the affected Windows machine:

```bash
npm run agent -- \
  --session FL-1234567890 \
  --token fl_ep_... \
  --api-base https://faultline.example.com
```

To suppress topology collection:

```bash
npm run agent -- \
  --session FL-1234567890 \
  --token fl_ep_... \
  --api-base https://faultline.example.com \
  --no-topology
```

Inspect the complete endpoint payload without uploading anything:

```powershell
npm run agent -- --target microsoft.com --dry-run --json
```

Once endpoint evidence exists, an assigned registered probe discovers the session and adds the independent vantage automatically. The incident transitions from `ENDPOINT ONLY` to `2 VANTAGES` and the diagnosis is recalculated.

## Topology model

Topology telemetry is stored under:

```text
telemetry.topology
```

Simplified shape:

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

Current topology classifications:

```text
star     gateway-centred local network

tree     separate wireless access layer visible

mesh     low-confidence same-vendor wireless-hop evidence

unknown  insufficient default-gateway evidence
```

Endpoint-only discovery cannot prove every physical relationship. An Ethernet path may contain an unmanaged switch that Windows cannot see. Faultline therefore distinguishes **observed facts** from **inferred links** instead of claiming a perfect physical diagram.

Future topology work includes OUI vendor data, consented bounded discovery, reverse-DNS/mDNS hints, conservative device classification and router/controller integrations for authoritative switch/AP/mesh relationships.

## Probe health

Faultline derives probe state from authenticated heartbeat age:

```text
<= 90 seconds     online
<= 5 minutes      stale
> 5 minutes       offline
disabled identity disabled
```

A worker does not self-declare that it is healthy.

## Security model

Faultline currently has these credential scopes:

```text
Admin token
  -> register probes, create sessions, view live control-plane data

Invitation token
  -> preview and claim one ephemeral support session

Endpoint session token
  -> submit endpoint evidence for one short-lived session

Registered probe token
  -> heartbeat, read that probe's assigned jobs, submit assigned remote evidence
```

Legacy one-off sessions may also receive a short-lived `fl_pr_...` probe token.

For hosted use, bearer credentials should only travel over HTTPS.

### Ephemeral invitation properties

- invite secrets are random high-entropy bearer material
- only the invite hash is persisted
- the invite cannot submit endpoint evidence
- explicit consent is required before endpoint access is created
- claiming the invite invalidates the invite secret
- `claimedAt` and `consentedAt` remain in session metadata
- the resulting endpoint token expires with the diagnostic session

### Topology privacy

Topology can contain private network metadata including local IPv4 addresses, MAC addresses and Wi-Fi BSSID information. This is useful evidence but may be sensitive.

The endpoint supports `--no-topology`, and the ephemeral consent page exposes the same choice before the endpoint credential is activated.

## Tests

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
- complete registered-probe HTTP lifecycle
- topology inference and MAC normalization
- one-time invitation creation
- consent enforcement
- invitation-secret invalidation
- endpoint credential minting after claim
- complete invitation HTTP lifecycle and restart persistence

CI also builds the Docker image.

## Current limitations

Faultline remains a single-instance prototype rather than a production multi-tenant observability platform.

- JSON-file persistence rather than a transactional database
- one process / one writer assumption
- one administrator security domain
- no registered-probe credential rotation/revocation yet
- job polling rather than push/message-queue delivery
- no rate limiting
- no organisation/user accounts
- no audit log
- remote probes currently collect DNS/TCP/HTTP rather than full remote path telemetry
- Windows endpoint collector still needs broader real-world testing across adapters and VPN clients
- topology is best-effort endpoint inference rather than authoritative physical discovery
- topology currently uses the existing neighbour table rather than an active discovery pass
- ephemeral diagnostics still require the Node.js collector rather than a packaged one-click Windows executable
- invitation links are single-claim by design; if the endpoint credential is lost after claim, a new invitation must be created

## Roadmap

The full roadmap is tracked in [ROADMAP.md](ROADMAP.md).

The broader **v0.6** milestone contains three connected areas:

1. **ephemeral support diagnostics**: first working dashboard + CLI invitation, consent and one-time credential exchange now implemented; packaging and evidence preview remain
2. **interactive inferred topology**: first working passive Windows discovery and draggable graph UI implemented
3. **probe fleet intelligence and safety**: geography/tag-based selection, credential lifecycle controls and restrictions preventing public probes from becoming arbitrary scanners

Later milestones cover Connectivity Contracts, richer remote path evidence, support cases and signed evidence packages, cross-party troubleshooting, hosted SaaS architecture, integrations and multi-vantage incident analysis.

## Status

Faultline currently demonstrates the broader product hypothesis that a support platform can correlate evidence from independently operated network vantage points while keeping identity, access, consent, topology inference and fault-domain reasoning explicit and testable.

It is not intended to become a generic replacement for production network-observability platforms.

## License

MIT
