# Faultline deployment

Faultline v0.5 can run as a small persistent control plane on a VPS or container host, with registered remote-probe workers running on separate networks.

The deployment model is intentionally simple:

- one Node.js control-plane process
- one persistent JSON state file
- one administrator credential
- short-lived endpoint session credentials
- long-lived registered-probe credentials
- one or more remote workers

## Security boundary

Do not expose a remote Faultline control plane over plain HTTP.

Endpoint and registered-probe credentials are bearer tokens. When Faultline is reachable across an untrusted network, terminate **HTTPS** in front of Node using a reverse proxy such as Caddy, nginx, Traefik, or a platform load balancer.

The Node server itself listens over HTTP and expects TLS termination to happen in front of it.

## Generate an admin credential

```bash
node -e "console.log('fl_admin_'+require('crypto').randomBytes(32).toString('base64url'))"
```

Store the result as `FAULTLINE_ADMIN_TOKEN` on the control-plane host.

If the variable is missing during a direct local Node start, Faultline generates a temporary development credential and prints it. Do not rely on that behavior for a hosted deployment.

## Docker Compose control plane

Create `.env` beside `docker-compose.yml`:

```text
FAULTLINE_ADMIN_TOKEN=fl_admin_replace_this_with_a_random_value
```

Start:

```bash
docker compose up -d --build
```

The supplied Compose file binds Node to `127.0.0.1:3000` on the host. Put the HTTPS reverse proxy on the same host and forward its public hostname to:

```text
http://127.0.0.1:3000
```

A named volume is mounted at `/data`, so sessions, runs and registered-probe identities survive container restarts.

Check health:

```bash
curl http://127.0.0.1:3000/api/health
```

Expected shape:

```json
{
  "ok": true,
  "version": "0.5.0",
  "persistence": true,
  "registeredProbeFleet": true
}
```

## Direct Node control plane

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_...'
export FAULTLINE_DATA_FILE='/var/lib/faultline/faultline.json'
npm start
```

PowerShell:

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_..."
$env:FAULTLINE_DATA_FILE = "C:\Faultline\data\faultline.json"
npm start
```

## Deploy a registered probe

Register the probe from an administrative machine:

```bash
npm run probe:register -- \
  --name london-1 \
  --location "London, UK" \
  --tags uk,vps \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

Store the returned `fl_probe_...` credential on the remote worker host.

Example environment file:

```text
FAULTLINE_PROBE_TOKEN=fl_probe_...
```

Run the worker:

```bash
npm run probe -- \
  --probe PRB-8A1B2C3D4E \
  --api-base https://faultline.example.com \
  --watch
```

When `FAULTLINE_PROBE_TOKEN` is present in the worker environment, `--token` is unnecessary.

For a long-running VPS deployment, run the worker under systemd, Docker, supervisord, or another process manager. See [PROBE_FLEET.md](PROBE_FLEET.md).

## Create an assigned diagnostic session

```bash
npm run session -- \
  --target microsoft.com \
  --probe PRB-8A1B2C3D4E \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The control plane returns a short-lived endpoint token. It does not create a one-off session probe token because the assigned registered worker already owns the remote-probe role for that session.

## Dashboard access

Demo incidents are public.

Live diagnostic telemetry and registered-probe health require the admin credential. Use **Unlock live data** in the browser. The credential is kept in `sessionStorage`, not in the URL.

## Persistent data

Default direct-Node path:

```text
data/faultline.json
```

Configure another location with:

```text
FAULTLINE_DATA_FILE=/path/to/faultline.json
```

v0.5 state includes:

- diagnostic sessions
- hashed endpoint/one-off probe credentials
- endpoint telemetry
- remote-probe telemetry
- registered probe identities
- hashed registered-probe credentials
- heartbeat/runtime metadata

Raw credentials are not persisted.

Back up the file if historical diagnostics and registered probe identities matter.

## Current deployment limits

v0.5 is still a single-instance prototype, not a production multi-tenant service.

Known limits:

- JSON-file storage instead of a transactional database
- one server process / one writer assumption
- one administrator security domain
- no rate limiting
- no registered-probe credential rotation/revocation API yet
- no organisation/user accounts
- no audit log
- polling rather than push-based work delivery
- no automatic TLS termination
- no database-level retention policy

A larger hosted architecture should move state to a database, add organisation boundaries, audit events and credential lifecycle controls.

## No AI dependency

Faultline does not use an AI API. The diagnosis path, probe health and job assignment are deterministic. Deployment requires no LLM key, inference service or model dependency.
