# Faultline

**Evidence-based network fault isolation across endpoints, networks, ISPs and services.**

Faultline addresses a common support problem: every team can see its own part of a connection, but nobody has enough shared evidence to say where a fault actually begins.

Instead of producing another wall of network metrics, Faultline correlates observations from explicit vantage points into a likely **fault domain**, explains the evidence behind that decision, and recommends the next action.

## Why Faultline?

A connectivity incident often crosses several ownership boundaries:

```text
Endpoint -> Wi-Fi/LAN -> ISP -> Internet transit -> SaaS / application
```

The user sees a broken application. Internal IT sees a healthy LAN. The ISP sees an active circuit. The SaaS provider sees healthy servers.

Faultline is intended to bridge those viewpoints without requiring either side to hand over full administrative access.

## Current build: v0.5

Faultline now includes a **persistent registered remote-probe fleet**.

Remote probes are no longer only anonymous one-shot processes. An administrator can register a durable probe identity once, run that worker continuously from a VPS or other network, monitor its heartbeat health, and assign diagnostic sessions to it.

When endpoint evidence arrives, the assigned probe discovers the session from its own authenticated job queue, independently measures the target, and contributes the second vantage point automatically.

### What is implemented

- commercial-style incident dashboard
- deterministic fault-domain diagnosis engine
- Windows endpoint collector
- portable remote probe for Windows, Linux and macOS with Node.js 20+
- persistent registered probe identities
- long-lived registered-probe credentials stored as SHA-256 hashes
- authenticated probe heartbeats
- `online`, `stale`, `offline` and `disabled` probe health states
- probe runtime metadata such as version, platform and hostname
- admin-visible probe-fleet dashboard
- diagnostic sessions assignable to a specific registered probe
- per-probe job queues that expose only sessions assigned to that probe
- automatic registered-probe discovery of endpoint-ready sessions
- backwards-compatible one-off session probe mode
- short-lived endpoint session credentials
- persistent diagnostic sessions and telemetry
- session expiry enforcement
- atomic JSON-file writes for the single-process prototype
- admin-protected live dashboard data
- public deterministic demo incidents
- escaped live telemetry before browser rendering
- Docker and Docker Compose deployment
- endpoint gateway, DNS, VPN, route, loss, jitter and traceroute observations
- remote DNS, TCP and HTTP reachability checks
- automated unit and integration tests
- zero third-party runtime dependencies

## No AI API by design

Faultline does **not** use an AI or LLM API.

The diagnostic inputs are structured measurements and the fault domains are explicit. A deterministic evidence engine is easier to test, easier to explain, cheaper to run, and less likely to invent a networking conclusion that is not supported by telemetry.

AI is not part of the architecture simply because it is available. The core diagnostic path remains reproducible:

```text
same evidence -> same rules -> same diagnosis
```

## Architecture

```text
                         Faultline control plane
                  +--------------------------------+
                  | persistent sessions + runs     |
                  | registered probe registry      |
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
     LAN / Wi-Fi / VPN / path              heartbeat + job poll
                |                                    |
                |                           DNS / TCP / HTTP
                |                                    |
                +-----------------+------------------+
                                  |
                                  v
                         correlated incident
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the deeper design.

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

Open:

```text
http://localhost:3000
```

The public dashboard initially shows deterministic demo incidents. Use **Unlock live data** with the admin credential to view live incidents and the registered probe fleet.

## Registered probe fleet

### 1. Register a probe once

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

Faultline returns a durable probe ID and a raw credential once:

```text
Faultline probe PRB-8A1B2C3D4E registered.
Name: london-1
Location: London, UK

Start the registered worker with:
  npm run probe -- --probe PRB-8A1B2C3D4E --token fl_probe_... --api-base https://faultline.example.com --watch
```

Only the SHA-256 hash of the credential is persisted by Faultline.

### 2. Run the probe worker

On the VPS or independent network:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --token "$FAULTLINE_PROBE_TOKEN" \
  --api-base https://faultline.example.com \
  --watch
```

The worker:

1. authenticates as its registered probe identity
2. sends heartbeat/runtime state
3. polls only its own assigned job queue
4. independently measures endpoint-ready sessions
5. submits the remote evidence
6. continues polling while `--watch` is enabled

Default poll interval is 30 seconds. Configure it with `--interval 15-300`.

### Probe health

Faultline derives health from authenticated heartbeats:

```text
<= 90 seconds since heartbeat    online
<= 5 minutes                     stale
> 5 minutes                      offline
disabled identity                disabled
```

Health is computed by the control plane rather than trusted from the worker.

## Run a diagnostic using a registered probe

### 1. Create the session

Assign the remote vantage when the session is created:

```bash
npm run session -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The response contains a short-lived **endpoint credential**. No one-off probe credential is generated because the registered probe already has its own durable identity.

### 2. Run the affected Windows endpoint

Use the generated command on the machine experiencing the problem:

```bash
npm run agent -- \
  --session FL-1234567890 \
  --token fl_ep_... \
  --api-base https://faultline.example.com
```

Once endpoint evidence exists, the assigned registered probe sees that session in:

```text
GET /api/probes/:probeId/jobs
```

No target is exposed to unrelated probe identities.

### 3. Correlation happens automatically

A worker running with `--watch` picks up the session, performs the independent target checks and submits the second vantage point.

The incident transitions from:

```text
ENDPOINT ONLY
```

to:

```text
2 VANTAGES
```

and the deterministic diagnosis is recalculated.

## One-off remote probe mode

v0.5 retains the v0.4 workflow for ad hoc testing. If a session is created **without** `--probe`, Faultline still generates a short-lived session probe token:

```bash
npm run probe -- --session FL-1234567890 --token fl_pr_... --api-base https://faultline.example.com
```

Registered probes are preferred for a persistent hosted deployment because their identity and health are visible to the control plane.

## CLI summary

### Register a probe

```text
npm run probe:register --
  --name <value>            Required probe name
  --location <value>        Human-readable location
  --tags <csv>              Probe tags
  --api-base <url>          Faultline control plane
  --admin-token <token>     Admin credential
  --json                    Full registration response
```

### Registered probe worker

```text
npm run probe --
  --probe <id>              Registered probe ID
  --token <token>           Registered probe credential
  --api-base <url>          Faultline control plane
  --watch                   Keep polling for jobs
  --interval <seconds>      15-300, default 30
```

### Diagnostic session

```text
npm run session --
  --target <host|IP|URL>    Diagnostic target
  --probe <id>              Optional registered probe assignment
  --port <number>           Target TCP port
  --ttl <minutes>           5-1440 minutes
  --title <value>           Incident title
  --customer <value>        Customer/case label
  --vpn-required            Target requires VPN
  --expected-route <CIDR>   Endpoint route expectation
```

See [docs/PROBE_FLEET.md](docs/PROBE_FLEET.md), [docs/REMOTE_PROBE.md](docs/REMOTE_PROBE.md), and [docs/AGENT.md](docs/AGENT.md).

## API additions in v0.5

### Probe administration

```text
POST /api/probes                 admin only
GET  /api/probes                 admin only
GET  /api/probes/:id             admin or matching probe identity
```

### Registered worker control plane

```text
POST /api/probes/:id/heartbeat   matching registered probe
GET  /api/probes/:id/jobs        matching registered probe
POST /api/probe-runs             assigned registered probe or legacy session probe
```

A registered probe cannot enumerate another probe's jobs simply by knowing its ID. Authentication is checked against the persisted credential hash for the requested probe identity.

## Persistence

Direct Node deployments store state at:

```text
data/faultline.json
```

The v0.5 store contains:

- diagnostic sessions
- endpoint and remote runs
- registered probe identities
- hashed registered-probe credentials
- last heartbeat and runtime metadata

It does not store raw session or registered-probe credentials.

The file format was advanced to state version 2. Existing v0.4 state is normalized on read by adding an empty probe registry.

## Docker deployment

The existing Docker and Docker Compose control-plane deployment remains supported. The service binds to localhost by default in Compose so HTTPS should terminate at a reverse proxy before traffic reaches Node.

For a remote probe VPS, the simplest worker is currently a Node.js process running:

```bash
npm run probe -- --probe <id> --token <token> --api-base https://faultline.example.com --watch
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the control plane and [docs/PROBE_FLEET.md](docs/PROBE_FLEET.md) for long-running worker guidance.

## Security model

Faultline v0.5 now has three credential scopes:

```text
Admin token
  -> register probes, create sessions, view live control-plane data

Endpoint session token
  -> submit endpoint evidence for one short-lived session

Registered probe token
  -> heartbeat, read that probe's assigned jobs, submit remote evidence for sessions assigned to it
```

Legacy one-off sessions may also receive a short-lived `fl_pr_...` probe token.

Registered probe tokens are long-lived in this prototype. Rotation and explicit revocation are future work.

## Tests

```bash
npm run check
npm test
```

The suite covers:

- deterministic fault-domain diagnosis
- Windows command parsing
- remote target normalization
- evidence correlation
- session authentication and expiry
- persistent state
- registered probe identity and credential hashing
- probe health transitions
- persisted probe registry
- complete registered-probe HTTP lifecycle
- legacy one-off two-vantage compatibility

CI also builds the Docker image.

## Current limitations

Faultline is still a single-instance prototype rather than a production multi-tenant observability platform.

- JSON-file persistence rather than a transactional database
- one process / one writer assumption
- one administrator security domain
- registered probe credentials do not yet support rotation or explicit revocation
- job polling rather than a push/message-queue system
- no rate limiting
- no organisation/user accounts
- no audit log
- remote probes currently collect DNS/TCP/HTTP evidence rather than full remote traceroute and ICMP path telemetry
- Windows endpoint collector still needs broader real-world testing across adapters and VPN clients

## Product direction

The next meaningful platform work is likely to be one of:

1. probe credential rotation, disable/revoke controls and audit events
2. probe selection based on geography/tags rather than explicit probe IDs
3. richer remote traceroute/loss/jitter measurements
4. database-backed multi-instance control plane
5. portable evidence-report export for support escalation

None of those requires an AI API for the core diagnosis.

## Status

Faultline v0.5 demonstrates the broader product hypothesis: **a support platform can correlate evidence from independently operated network vantage points while keeping identity, access and fault-domain reasoning explicit and testable.**

It is not a replacement for production network observability or digital-experience monitoring platforms.

## License

MIT
