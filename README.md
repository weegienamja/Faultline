# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline explores a common support problem: every team can see its own part of a connection, but nobody has enough shared evidence to say where a fault actually begins.

Instead of producing another wall of network metrics, Faultline correlates observations into a likely **fault domain**, explains the evidence behind that decision, and recommends the next action.

## Why Faultline?

A typical connectivity incident crosses several ownership boundaries:

```text
Endpoint -> Wi-Fi/LAN -> ISP -> Internet transit -> SaaS / application
```

The end user sees a broken application. Internal IT sees a healthy LAN. The ISP sees an active circuit. The SaaS provider sees healthy servers.

Faultline is intended to bridge those viewpoints without requiring either side to hand over full administrative access.

## Current build: v0.4

Faultline now has a **persistent, authenticated two-vantage control plane**.

A diagnostic begins as a short-lived session. That session receives two different credentials: one for the affected endpoint and one for the independent remote probe. Each side contributes only its own evidence, and Faultline correlates both into the same incident.

Live sessions and telemetry are persisted to disk so a server or container restart no longer destroys the diagnostic history.

### What is implemented

- commercial-style incident dashboard
- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- portable remote probe for Windows, Linux and macOS with Node.js 20+
- explicit short-lived diagnostic sessions
- separate endpoint and remote-probe bearer credentials
- SHA-256 credential hashes at rest rather than raw session tokens
- session expiry enforcement
- persistent session and run storage
- atomic JSON-file writes for the single-process prototype
- admin-protected live dashboard data
- public deterministic demo incidents
- browser admin credential kept in `sessionStorage`, not the URL
- escaped live telemetry before dashboard rendering
- Docker and Docker Compose deployment
- default-gateway latency and packet-loss measurement
- DNS resolution and lookup timing
- target TCP and HTTP observations
- endpoint packet-loss and jitter calculation
- Wi-Fi signal collection when available
- VPN adapter discovery and optional expected-route validation
- bounded endpoint traceroute collection
- remote target DNS, TCP and HTTP checks
- endpoint-only versus two-vantage state in the dashboard
- automated tests for diagnosis, collection parsing, correlation, credentials and persistence
- zero third-party runtime dependencies

## No AI API by design

Faultline does **not** use an AI or LLM API.

The diagnostic inputs are structured measurements and the fault domains are explicit. A deterministic evidence engine is easier to test, easier to explain, cheaper to run, and less likely to invent a networking conclusion that is not supported by the telemetry.

AI is not part of the architecture simply because it is available. If a future feature has a concrete need for it, that can be evaluated separately without making the core diagnosis dependent on a model.

## Architecture

```text
                              Faultline control plane
                         +-----------------------------+
                         | persistent diagnostic store |
                         | session auth + correlation  |
                         | deterministic diagnosis     |
                         +--------------+--------------+
                                        |
                         +--------------+--------------+
                         |                             |
                         v                             v
                 Windows endpoint               Remote probe
                 scoped endpoint                scoped probe
                    credential                   credential
                         |                             |
              LAN / Wi-Fi / VPN / path        DNS / TCP / HTTP
                         |                             |
                         +-------------+---------------+
                                       |
                                       v
                             correlated incident
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more detail.

## Run Faultline locally

Requires Node.js 20 or newer.

For local development you can simply run:

```bash
npm start
```

If `FAULTLINE_ADMIN_TOKEN` is not configured, Faultline generates a temporary development admin credential and prints it to the terminal.

For a stable local credential, set it explicitly.

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

The dashboard initially shows public demo incidents. Use **Unlock live data** and enter the admin credential to view persisted live diagnostics.

## Run an authenticated two-vantage diagnostic

### 1. Create a diagnostic session

```bash
npm run session -- \
  --target microsoft.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

On PowerShell:

```powershell
npm run session -- --target microsoft.com --admin-token $env:FAULTLINE_ADMIN_TOKEN
```

Faultline creates a short-lived session and prints two commands similar to:

```text
Faultline session FL-6A1B2C3D4E created.
Target: microsoft.com:443
Expires: 2026-08-18T20:45:00.000Z

Run the affected Windows endpoint:
  npm run agent -- --session FL-6A1B2C3D4E --token fl_ep_... --api-base http://localhost:3000

Run the independent probe from another network or host:
  npm run probe -- --session FL-6A1B2C3D4E --token fl_pr_... --api-base http://localhost:3000
```

The raw endpoint and probe credentials are returned once. Faultline stores only their hashes.

### 2. Run the affected Windows endpoint

Use the generated endpoint command on the Windows machine experiencing the problem.

The endpoint credential can only submit endpoint evidence for that session. It cannot impersonate the remote probe.

At this point the dashboard labels the incident **ENDPOINT ONLY**.

### 3. Run the independent probe

Use the generated probe command from a different network, VPS or host.

The probe credential is independently scoped and can only contribute the remote vantage for that session.

When the second side arrives, Faultline recalculates the same incident and the dashboard changes to **2 VANTAGES**.

> Running the endpoint and probe on the same machine is useful for testing the software workflow, but it is not an independent network vantage point.

## Standalone endpoint collection

The Windows collector can still be inspected without creating or uploading a session:

```bash
npm run agent -- --target microsoft.com --dry-run --json
```

Unauthenticated endpoint uploads are intentionally disabled in v0.4.

## Session options

```text
--target <hostname|IP|URL>   Diagnostic target
--port <number>              Target TCP port
--api-base <url>             Faultline control-plane base URL
--admin-token <token>        Admin credential
--ttl <minutes>              Session lifetime, 5-1440 minutes
--title <value>              Incident title
--customer <value>           Customer or case label
--vpn-required               Mark target as VPN-dependent
--expected-route <CIDR>      Expected IPv4 route on the endpoint
--json                       Print full creation response
```

## Endpoint agent options

```text
--session <id>               Authenticated diagnostic session
--token <value>              Endpoint session credential
--api-base <url>             Faultline control-plane base URL
--target <value>             Standalone target for dry-run collection
--port <number>              Standalone TCP port
--expected-route <CIDR>      Standalone expected IPv4 route
--vpn-required               Standalone target requires VPN
--no-trace                   Skip traceroute collection
--dry-run                    Collect without uploading
--json                       Print the full payload
```

See [docs/AGENT.md](docs/AGENT.md).

## Remote probe options

```text
--session <id>               Authenticated diagnostic session
--token <value>              Probe session credential
--api-base <url>             Faultline control-plane base URL
--name <value>               Friendly probe name
--dry-run                    Collect without uploading
--json                       Print the full payload
```

See [docs/REMOTE_PROBE.md](docs/REMOTE_PROBE.md).

## Persistence

Direct Node deployments store state at:

```text
data/faultline.json
```

Override that location with:

```text
FAULTLINE_DATA_FILE=/path/to/faultline.json
```

The store contains session metadata, hashed role credentials and submitted telemetry. It does not contain the raw endpoint or probe credentials returned during session creation.

v0.4 intentionally uses a simple atomic JSON store because the current target is a single-instance prototype. A multi-instance hosted service should move this state to a transactional database.

## Docker deployment

Generate a strong admin credential and place it in a local `.env` file:

```text
FAULTLINE_ADMIN_TOKEN=fl_admin_replace_with_a_random_value
```

Then:

```bash
docker compose up -d --build
```

The Compose configuration persists Faultline state in a named `/data` volume.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) before exposing the service beyond localhost.

**Remote endpoint/probe credentials are bearer tokens. Use HTTPS when the control plane is accessed over an untrusted network.**

## API

### Health

```text
GET /api/health
```

### Public demo data

```text
GET /api/demo-incidents
```

### Admin-protected control plane

```text
POST /api/sessions
GET  /api/sessions
GET  /api/incidents
GET  /api/agent-runs
```

These endpoints require the admin bearer token where applicable.

### Session-scoped endpoints

```text
GET  /api/sessions/:id
GET  /api/agent-runs/:id
POST /api/agent-runs
POST /api/probe-runs
```

Endpoint and probe uploads require the credential for the correct role and session. Expired sessions reject new endpoint/probe contributions.

### Stateless diagnosis

```text
POST /api/diagnose
```

The stateless diagnosis endpoint remains available for deterministic engine experimentation.

## Test it

```bash
npm test
npm run check
```

The suite covers:

- deterministic fault-domain diagnosis
- Windows command parsing
- remote-probe target handling
- two-vantage correlation
- role-scoped credential verification
- session expiry and safe public session metadata
- URL port inference
- persistence across store instances
- replacement of an existing persisted run rather than duplicate session records

## Privacy

Faultline does **not** capture packet payloads, browser history, application content or user credentials.

Endpoint telemetry can still contain operational metadata such as:

- machine hostname
- adapter names and descriptions
- private gateway address
- VPN adapter names
- resolved target addresses
- traceroute hop addresses

Remote probes can submit their hostname, platform, resolved addresses and target timings.

Use dry-run JSON output to inspect collector payloads before sending them to a hosted Faultline control plane.

## Current security model

v0.4 materially improves the prototype security boundary, but it is not a finished multi-tenant security model.

Implemented now:

- admin authentication for session creation and live dashboard data
- separate endpoint and probe session credentials
- random 256-bit token material
- SHA-256 token hashes at rest
- constant-time credential comparison
- session expiry
- live telemetry hidden from unauthenticated dashboard requests
- client-side escaping of telemetry rendered through HTML templates

Still needed for a larger hosted service:

- organisation and user identities
- session credential revocation / rotation
- rate limiting
- audit logging
- configurable telemetry redaction
- database-backed multi-process concurrency
- retention policies
- registered long-lived probe identity

## Product direction

The next useful engineering steps are:

1. registered probe identity and probe health
2. configurable telemetry redaction
3. evidence-report export for escalations
4. richer remote path measurements
5. database-backed storage if Faultline moves beyond a single instance
6. organisation/case scoping if multiple customers use one control plane

## Status

Faultline v0.4 demonstrates the core product hypothesis with a more credible operating model: **two independently authenticated vantage points can contribute evidence to one persistent diagnostic session without either side receiving administrative access to the other.**

It is still an early prototype and is not a replacement for production network observability or digital-experience monitoring platforms.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Windows endpoint agent](docs/AGENT.md)
- [Remote probe](docs/REMOTE_PROBE.md)
- [Deployment](docs/DEPLOYMENT.md)

## License

MIT
