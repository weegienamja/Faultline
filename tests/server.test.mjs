import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ADMIN_TOKEN = "test-admin-token";

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
      if (output.includes("Faultline v0.5 listening")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve(child);
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", chunk => { output += chunk.toString(); });
    child.once("exit", code => {
      if (code !== null && !output.includes("Faultline v0.5 listening")) {
        clearTimeout(timer);
        reject(new Error(`Faultline server exited with ${code}. Output: ${output}`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 2_000).unref();
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
  return {
    status: response.status,
    body: await response.json()
  };
}

test("persists and authenticates a complete two-vantage diagnostic", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-server-"));
  const dataFile = join(dir, "faultline.json");
  const port = 36000 + Math.floor(Math.random() * 2000);
  const base = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    server = await startServer(port, dataFile);

    assert.equal((await request(base, "/api/health")).status, 200);
    assert.equal((await request(base, "/api/demo-incidents")).status, 200);
    assert.equal((await request(base, "/api/incidents")).status, 401);

    const created = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { target: "http://example.com/health", ttlMinutes: 10 }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.target.port, 80);
    assert.equal(JSON.stringify(created.body.session).includes("TokenHash"), false);

    const sessionId = created.body.session.id;
    const endpointToken = created.body.credentials.endpointToken;
    const probeToken = created.body.credentials.probeToken;

    assert.equal((await request(base, `/api/sessions/${sessionId}`, { token: endpointToken })).status, 200);
    assert.equal((await request(base, `/api/sessions/${sessionId}`, { token: "wrong" })).status, 401);

    const endpointPayload = {
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
      telemetry: { collectedAt: "2026-08-18T18:00:00.000Z" }
    };

    assert.equal((await request(base, "/api/agent-runs", { method: "POST", body: endpointPayload, token: probeToken })).status, 401);

    const endpoint = await request(base, "/api/agent-runs", {
      method: "POST",
      body: endpointPayload,
      token: endpointToken
    });
    assert.equal(endpoint.status, 201);
    assert.equal(endpoint.body.diagnosis.faultDomain, "inconclusive");

    const remote = await request(base, "/api/probe-runs", {
      method: "POST",
      token: probeToken,
      body: {
        sessionId,
        metrics: { targetReachable: true, targetTcpMs: 17 },
        telemetry: { collectedAt: "2026-08-18T18:00:10.000Z" }
      }
    });
    assert.equal(remote.status, 201);
    assert.equal(remote.body.diagnosis.faultDomain, "access_path");
    assert.equal(remote.body.vantages.remoteProbe, true);

    const live = await request(base, "/api/incidents", { token: ADMIN_TOKEN });
    assert.equal(live.status, 200);
    assert.equal(live.body[0].id, sessionId);

    await stopServer(server);
    server = await startServer(port, dataFile);

    const restored = await request(base, "/api/incidents", { token: ADMIN_TOKEN });
    assert.equal(restored.status, 200);
    assert.equal(restored.body[0].id, sessionId);
    assert.equal(restored.body[0].source, "correlated");
    assert.equal(restored.body[0].vantages.remoteProbe, true);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
