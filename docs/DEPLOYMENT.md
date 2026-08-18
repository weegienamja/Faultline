# Faultline deployment

Faultline v0.4 can run as a small persistent control plane on a VPS or container host. The current deployment model is intentionally simple: one Node.js process, one JSON data file, one administrator credential, and short-lived role-scoped credentials for each diagnostic session.

## Security boundary

Do not expose a remote Faultline control plane over plain HTTP.

Endpoint and probe credentials are bearer tokens. When Faultline is reachable across an untrusted network, terminate **HTTPS** in front of the Node process using a reverse proxy such as Caddy, nginx, Traefik, or the platform load balancer.

The Node server itself currently listens over HTTP and expects TLS termination to happen in front of it.

## Generate an admin credential

Generate a long random value rather than using a memorable password:

```bash
node -e "console.log('fl_admin_'+require('crypto').randomBytes(32).toString('base64url'))"
```

Store it as `FAULTLINE_ADMIN_TOKEN` on the control-plane host.

If the variable is missing when Faultline starts directly with Node, the server generates a temporary development admin credential and prints it to stdout. That behaviour is convenient locally but should not be relied on for a hosted deployment.

## Docker Compose

Create a `.env` file beside `docker-compose.yml`:

```text
FAULTLINE_ADMIN_TOKEN=fl_admin_replace_this_with_a_random_value
```

Then start the service:

```bash
docker compose up -d --build
```

The Compose file mounts a named volume at `/data`, so diagnostic sessions and live runs survive container restarts.

Check the local health endpoint:

```bash
curl http://127.0.0.1:3000/api/health
```

Expected shape:

```json
{
  "ok": true,
  "version": "0.4.0",
  "persistence": true
}
```

## Direct Node deployment

Faultline requires Node.js 20 or newer.

```bash
export FAULTLINE_ADMIN_TOKEN='fl_admin_...'
export FAULTLINE_DATA_FILE='/var/lib/faultline/faultline.json'
npm start
```

On Windows PowerShell:

```powershell
$env:FAULTLINE_ADMIN_TOKEN = "fl_admin_..."
$env:FAULTLINE_DATA_FILE = "C:\Faultline\data\faultline.json"
npm start
```

## Create a remote diagnostic session

From a machine with the Faultline repository checked out:

```bash
npm run session -- \
  --target microsoft.com \
  --api-base https://faultline.example.com \
  --admin-token "$FAULTLINE_ADMIN_TOKEN"
```

The control plane returns two different short-lived credentials:

- an **endpoint token** that may upload endpoint evidence
- a **probe token** that may upload the independent remote result

The raw session credentials are returned once. Faultline persists SHA-256 hashes rather than the raw values.

## Dashboard access

The public dashboard can display deterministic demo incidents without authentication.

Live diagnostic telemetry is returned only from the admin-protected `/api/incidents` endpoint. Use **Unlock live data** in the dashboard and enter the admin credential. The browser stores it in `sessionStorage`, which keeps it out of the URL and clears it when the tab/session is closed.

## Persistent data

By default a direct Node deployment stores state at:

```text
data/faultline.json
```

Set `FAULTLINE_DATA_FILE` to move it elsewhere. The file contains:

- session metadata
- hashed endpoint and probe credentials
- endpoint telemetry
- remote-probe telemetry
- correlated live runs

It does **not** contain the raw endpoint or probe session credentials.

Back up the data file if historical diagnostic sessions matter to you.

## Current deployment limits

v0.4 is suitable as a single-instance prototype control plane, not yet as a production multi-tenant service.

Known limits include:

- JSON-file storage rather than a transactional database
- one server process / one writer assumption
- one administrator security domain
- no rate limiting
- no token rotation or revocation before expiry
- no organisation or user accounts
- no audit log
- no automatic TLS termination
- no database-level retention policy

A later hosted architecture should move session/run state to a database, add organisation scoping and audit records, and introduce explicit credential revocation.

## No AI dependency

Faultline does not use an AI API. The diagnosis path is deterministic and evidence-based. Deployment therefore does not require an LLM key, inference service, or model dependency.
