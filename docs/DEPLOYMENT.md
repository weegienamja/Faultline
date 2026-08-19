# Faultline deployment

Faultline currently runs as a small persistent control plane with registered remote-probe workers and an optional packaged Windows diagnostic client.

The deployment model remains intentionally simple:

- one Node.js control-plane process
- one persistent JSON state file
- one administrator credential
- short-lived invitation / launcher / endpoint credentials
- long-lived registered-probe credentials
- one or more remote workers
- optional public HTTPS location for `Faultline.exe`

## Security boundary

Do not expose a remote Faultline control plane over plain HTTP.

Invitation, launcher, endpoint and probe credentials are bearer tokens. When Faultline is reachable across an untrusted network, terminate **HTTPS** in front of Node using a reverse proxy or platform load balancer.

The Node server itself listens over HTTP and expects TLS termination to happen in front of it.

## Generate an admin credential

```bash
node -e "console.log('fl_admin_'+require('crypto').randomBytes(32).toString('base64url'))"
```

Store the result as `FAULTLINE_ADMIN_TOKEN` on the control-plane host.

## Docker Compose control plane

Create `.env` beside `docker-compose.yml`:

```text
FAULTLINE_ADMIN_TOKEN=fl_admin_replace_this_with_a_random_value
FAULTLINE_WINDOWS_CLIENT_URL=https://downloads.example.com/Faultline.exe
```

The Windows-client URL is optional. If omitted, ephemeral diagnostics still generate `.faultline` handoff files but the support user must receive the executable separately.

Start:

```bash
docker compose up -d --build
```

The supplied Compose file binds Node to `127.0.0.1:3000` on the host. Put the HTTPS reverse proxy on the same host and forward its public hostname to:

```text
http://127.0.0.1:3000
```

A named volume is mounted at `/data`, so sessions, runs and registered-probe identities survive container restarts.

## Health

```bash
curl http://127.0.0.1:3000/api/health
```

Current responses include the product version and feature flags for registered probes, topology, ephemeral invitations, the Windows-client preview, case workspaces, evidence packages, cross-party rooms, multi-tenancy and the contract catalog.

## Direct Node control plane

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_...'
export FAULTLINE_DATA_FILE='/var/lib/faultline/faultline.json'
export FAULTLINE_WINDOWS_CLIENT_URL='https://downloads.example.com/Faultline.exe'
npm start
```

PowerShell:

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_..."
$env:FAULTLINE_DATA_FILE = "C:\Faultline\data\faultline.json"
$env:FAULTLINE_WINDOWS_CLIENT_URL = "https://downloads.example.com/Faultline.exe"
npm start
```

## Build the Windows client

The standalone client build currently uses Node.js 26+ Single Executable Application support.

```powershell
New-Item -ItemType Directory -Force dist | Out-Null
npm run build:windows-client
.\dist\Faultline.exe --self-test
```

CI builds the executable on a Windows runner and publishes it as a workflow artifact.

Production distribution should use a stable HTTPS origin and Authenticode-sign the executable. The current CI artifact is unsigned.

Configure the final download location with:

```text
FAULTLINE_WINDOWS_CLIENT_URL=https://downloads.example.com/Faultline.exe
```

The control plane does not proxy or store the executable itself.

## Deploy a registered probe

Register a probe from an administrative machine:

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --tags uk,vps \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Store the returned `fl_probe_...` credential on the remote worker host and run:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --api-base https://faultline.example.com \
  --watch
```

When `FAULTLINE_PROBE_TOKEN` is set in the worker environment, `--token` is unnecessary.

For a long-running VPS deployment, run the worker under systemd, Docker, supervisord or another process manager. See [PROBE_FLEET.md](PROBE_FLEET.md).

## Ephemeral support workflow

A support engineer creates an invitation through the dashboard or `npm run invite`.

The user:

1. opens the HTTPS invitation
2. reviews collection scope and consents
3. downloads a `.faultline` handoff
4. downloads/receives `Faultline.exe`
5. double-clicks the executable

The browser does not receive the endpoint upload token. The `.faultline` handoff contains a separate one-use launcher secret. `Faultline.exe` exchanges it once using `/api/client/exchange`, receives the endpoint credential in memory and attempts to delete the handoff file.

Treat `.faultline` files as sensitive until exchanged.

## Dashboard access

Demo incidents are public.

Live diagnostic telemetry and registered-probe health require the admin credential. Use **Unlock live data** in the browser. The credential is stored in `sessionStorage`, not in the URL.

## Persistent data

Default direct-Node path:

```text
data/faultline.json
```

Configure another location with:

```text
FAULTLINE_DATA_FILE=/path/to/faultline.json
```

State currently includes:

- diagnostic sessions
- hashed invitation/launcher/endpoint/one-off probe credentials
- endpoint telemetry
- remote-probe telemetry
- registered probe identities
- hashed registered-probe credentials
- heartbeat/runtime metadata
- audit events
- support cases, notes, timelines and contributions
- hashed case-room participant credentials
- organizations and projects
- hashed organization credentials
- project Connectivity Contract catalogs

Raw bearer credentials are not persisted.

## Current deployment limits

Faultline is still a single-instance controlled prototype.

Known limits:

- JSON-file storage instead of a transactional database
- one server process / one writer assumption
- organisations are credential-based tenants, not named-user accounts with SSO/RBAC
- rate limiting covers registered-probe submissions only, not the platform as a whole
- polling rather than push-based work delivery
- no automatic TLS termination
- unsigned Windows client preview
- Windows-client download hosting is external/deployment-managed
- no database-level retention policy

Registered-probe credential rotation/revocation, audit events and organisation/project boundaries are implemented. A larger hosted architecture should still move state to a database and add named-user identity, retention policy and signed client distribution.

## No AI dependency

Faultline does not use an AI API. The diagnosis path, probe health and job assignment are deterministic. Deployment requires no LLM key, inference service or model dependency.
