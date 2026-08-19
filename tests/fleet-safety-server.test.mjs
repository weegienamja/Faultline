import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ADMIN_TOKEN = "fleet-safety-admin";
const STARTED = "preview listening on http://localhost:";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN, FAULTLINE_DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server start timeout: ${output}`)); }, 5_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes(STARTED)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { output += chunk.toString(); });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
  });
}

async function request(base, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

async function register(base, name, extra = {}) {
  return request(base, "/api/probes", {
    method: "POST",
    token: ADMIN_TOKEN,
    body: { name, scope: "public", country: "gb", region: "europe-west", tags: ["uk", "vps"], ...extra }
  });
}

async function heartbeat(base, id, token) {
  return request(base, `/api/probes/${id}/heartbeat`, {
    method: "POST",
    token,
    body: { runtime: { version: "0.6", platform: "linux", hostname: id, node: "v22" } }
  });
}

test("automatically schedules safe public work and enforces probe lifecycle", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-fleet-safety-"));
  const dataFile = join(dir, "faultline.json");
  const port = 40500 + Math.floor(Math.random() * 900);
  const base = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startServer(port, dataFile);
    const a = await register(base, "london-a");
    const b = await register(base, "london-b");
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    await heartbeat(base, a.body.probe.id, a.body.credential);
    await heartbeat(base, b.body.probe.id, b.body.credential);

    const drain = await request(base, `/api/probes/${a.body.probe.id}`, {
      method: "PATCH",
      token: ADMIN_TOKEN,
      body: { draining: true }
    });
    assert.equal(drain.status, 200);
    assert.equal(drain.body.health, "draining");

    const automatic = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        target: "https://example.com/health",
        ttlMinutes: 10,
        probeSelector: { scope: "public", country: "gb", region: "europe-west", tags: ["uk"] }
      }
    });
    assert.equal(automatic.status, 201);
    assert.equal(automatic.body.session.assignedProbeId, b.body.probe.id);
    assert.equal(automatic.body.session.probeSelection.mode, "automatic");

    const blockedPrivate = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { target: "http://127.0.0.1", probeSelector: { scope: "public", country: "gb" } }
    });
    assert.equal(blockedPrivate.status, 400);
    assert.equal(blockedPrivate.body.code, "TARGET_POLICY");

    const blockedPort = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { target: "example.com", port: 22, assignedProbeId: b.body.probe.id }
    });
    assert.equal(blockedPort.status, 400);

    const rotated = await request(base, `/api/probes/${b.body.probe.id}/rotate`, {
      method: "POST",
      token: ADMIN_TOKEN
    });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.probe.credentialVersion, 2);
    assert.match(rotated.body.credential, /^fl_probe_/);
    assert.equal((await heartbeat(base, b.body.probe.id, b.body.credential)).status, 401);
    assert.equal((await heartbeat(base, b.body.probe.id, rotated.body.credential)).status, 200);

    const audit = await request(base, "/api/audit", { token: ADMIN_TOKEN });
    assert.equal(audit.status, 200);
    assert.equal(audit.body.some(event => event.type === "probe.credential_rotated"), true);
    assert.equal(audit.body.some(event => event.type === "probe.session_assigned"), true);

    const revoked = await request(base, `/api/probes/${b.body.probe.id}/revoke`, {
      method: "POST",
      token: ADMIN_TOKEN
    });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.health, "revoked");
    assert.equal((await heartbeat(base, b.body.probe.id, rotated.body.credential)).status, 401);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
