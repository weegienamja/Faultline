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
  const contentType = response.headers.get("content-type") || "";
  return {
    status: response.status,
    body: contentType.includes("application/json") ? await response.json() : await response.text()
  };
}

test("one-time invitation hands off to packaged client before endpoint access", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-invite-"));
  const dataFile = join(dir, "faultline.json");
  const port = 38000 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    server = await startServer(port, dataFile);

    const page = await request(base, "/diagnose");
    assert.equal(page.status, 200);
    assert.match(page.body, /Help diagnose this connection/);
    assert.match(page.body, /Faultline\.exe/);

    const created = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        target: "https://example.com/health",
        ttlMinutes: 10,
        title: "Example support case",
        customer: "Example Ltd",
        ephemeral: true
      }
    });

    assert.equal(created.status, 201);
    assert.equal(created.body.session.mode, "ephemeral");
    assert.equal(created.body.session.invitation.status, "available");
    assert.equal("endpointToken" in created.body.credentials, false);
    assert.match(created.body.invitation.path, /^\/diagnose#invite=/);

    const inviteToken = created.body.credentials.invitationToken;
    const probeToken = created.body.credentials.probeToken;
    const sessionId = created.body.session.id;

    const preview = await request(base, "/api/invitations", { token: inviteToken });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.session.id, sessionId);
    assert.equal(preview.body.collection.packetPayloads, false);

    const rejected = await request(base, "/api/invitations/claim", {
      method: "POST",
      token: inviteToken,
      body: { consent: false }
    });
    assert.equal(rejected.status, 400);

    const claimed = await request(base, "/api/invitations/claim", {
      method: "POST",
      token: inviteToken,
      body: { consent: true, includeTopology: false }
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.session.invitation.status, "claimed");
    assert.equal(claimed.body.session.invitation.clientLaunchStatus, "available");
    assert.equal(claimed.body.client.launchToken.startsWith("fl_launch_"), true);
    assert.equal(claimed.body.session.invitation.includeTopology, false);
    assert.equal("credentials" in claimed.body, false);
    assert.equal((await request(base, "/api/invitations", { token: inviteToken })).status, 404);

    const launchToken = claimed.body.client.launchToken;
    const wrongExchange = await request(base, "/api/client/exchange", {
      method: "POST",
      token: "fl_launch_wrong",
      body: { sessionId }
    });
    assert.equal(wrongExchange.status, 404);

    const exchanged = await request(base, "/api/client/exchange", {
      method: "POST",
      token: launchToken,
      body: { sessionId }
    });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.client.includeTopology, false);
    assert.equal(exchanged.body.credentials.endpointToken.startsWith("fl_ep_"), true);
    assert.equal(exchanged.body.session.invitation.clientLaunchStatus, "exchanged");

    assert.equal((await request(base, "/api/client/exchange", {
      method: "POST",
      token: launchToken,
      body: { sessionId }
    })).status, 404);

    const endpointToken = exchanged.body.credentials.endpointToken;
    assert.equal((await request(base, `/api/sessions/${sessionId}`, { token: endpointToken })).status, 200);
    assert.equal((await request(base, `/api/sessions/${sessionId}`, { token: probeToken })).status, 200);

    const endpointPayload = {
      sessionId,
      metrics: {
        gatewayLoss: 0,
        gatewayLatencyMs: 3,
        dnsResolved: true,
        directIpReachable: true,
        internetReachable: true,
        upstreamLoss: 0,
        jitterMs: 1,
        targetReachable: true
      },
      telemetry: { collectedAt: "2026-08-18T20:30:00.000Z" }
    };

    assert.equal((await request(base, "/api/agent-runs", {
      method: "POST",
      token: endpointToken,
      body: endpointPayload
    })).status, 201);

    await stopServer(server);
    server = await startServer(port, dataFile);

    const sessions = await request(base, "/api/sessions", { token: ADMIN_TOKEN });
    const restored = sessions.body.find(session => session.id === sessionId);
    assert.equal(restored.invitation.status, "claimed");
    assert.equal(restored.invitation.claimedAt != null, true);
    assert.equal(restored.invitation.clientLaunchStatus, "exchanged");
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
