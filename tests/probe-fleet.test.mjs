import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ADMIN_TOKEN = "fleet-admin-token";
const STARTED = "Faultline v0.6 preview listening";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: dataFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Faultline server did not start. Output: ${output}`));
    }, 5_000);

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
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 2_000).unref();
  });
}

async function request(base, path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json() };
}

test("registers heartbeats and assigns a trusted remote probe", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-fleet-"));
  const dataFile = join(dir, "faultline.json");
  const port = 39000 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    server = await startServer(port, dataFile);

    const registration = await request(base, "/api/probes", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { name: "london-1", location: "London, UK", country: "gb", region: "europe-west", scope: "public", tags: ["uk", "vps"] }
    });
    assert.equal(registration.status, 201);
    assert.match(registration.body.probe.id, /^PRB-/);
    assert.match(registration.body.credential, /^fl_probe_/);
    assert.equal(registration.body.probe.health, "offline");
    assert.equal(registration.body.probe.scope, "public");

    const probeId = registration.body.probe.id;
    const probeToken = registration.body.credential;

    assert.equal((await request(base, `/api/probes/${probeId}`, { token: "wrong" })).status, 401);

    const heartbeat = await request(base, `/api/probes/${probeId}/heartbeat`, {
      method: "POST",
      token: probeToken,
      body: { runtime: { version: "0.6", platform: "linux", hostname: "lon-probe-1", node: "v22" } }
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.health, "online");
    assert.equal(heartbeat.body.runtime.hostname, "lon-probe-1");

    const session = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { target: "example.com", assignedProbeId: probeId, ttlMinutes: 10 }
    });
    assert.equal(session.status, 201);
    assert.equal(session.body.session.assignedProbeId, probeId);
    assert.equal("probeToken" in session.body.credentials, false);

    const sessionId = session.body.session.id;
    const endpointToken = session.body.credentials.endpointToken;

    const emptyQueue = await request(base, `/api/probes/${probeId}/jobs`, { token: probeToken });
    assert.equal(emptyQueue.status, 200);
    assert.equal(emptyQueue.body.jobs.length, 0);

    const endpoint = await request(base, "/api/agent-runs", {
      method: "POST",
      token: endpointToken,
      body: {
        sessionId,
        metrics: {
          gatewayLoss: 0,
          gatewayLatencyMs: 2,
          dnsResolved: true,
          directIpReachable: true,
          internetReachable: true,
          upstreamLoss: 0,
          jitterMs: 2,
          targetReachable: false
        },
        telemetry: { collectedAt: "2026-08-18T19:00:00.000Z" }
      }
    });
    assert.equal(endpoint.status, 201);

    const queue = await request(base, `/api/probes/${probeId}/jobs`, { token: probeToken });
    assert.equal(queue.status, 200);
    assert.equal(queue.body.jobs.length, 1);
    assert.equal(queue.body.jobs[0].id, sessionId);
    assert.equal(queue.body.jobs[0].target.input, "example.com");

    const wrongProbe = await request(base, "/api/probe-runs", {
      method: "POST",
      token: "wrong",
      body: { sessionId, probeId, metrics: { targetReachable: true } }
    });
    assert.equal(wrongProbe.status, 401);

    const correlated = await request(base, "/api/probe-runs", {
      method: "POST",
      token: probeToken,
      body: {
        sessionId,
        probeId,
        probe: { runtime: { version: "0.6", platform: "linux", hostname: "lon-probe-1" } },
        metrics: { dnsResolved: true, targetReachable: true, targetTcpMs: 14 },
        telemetry: { collectedAt: "2026-08-18T19:00:10.000Z" }
      }
    });
    assert.equal(correlated.status, 201);
    assert.equal(correlated.body.source, "correlated");
    assert.equal(correlated.body.remoteProbe.probe.id, probeId);
    assert.equal(correlated.body.remoteProbe.probe.registered, true);
    assert.equal(correlated.body.remoteProbe.probe.scope, "public");

    const drained = await request(base, `/api/probes/${probeId}/jobs`, { token: probeToken });
    assert.equal(drained.body.jobs.length, 0);

    await stopServer(server);
    server = await startServer(port, dataFile);

    const restored = await request(base, "/api/probes", { token: ADMIN_TOKEN });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.length, 1);
    assert.equal(restored.body[0].id, probeId);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
