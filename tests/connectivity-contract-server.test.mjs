import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConnectivityContract } from "../src/contracts/registry.mjs";

const ADMIN_TOKEN = "contract-admin-token";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN, FAULTLINE_DATA_FILE: dataFile },
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
      if (output.includes("Faultline v0.6 preview listening")) {
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

test("persists and discloses a validated connectivity contract through invitation exchange", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-contract-"));
  const dataFile = join(dir, "faultline.json");
  const port = 40500 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  let server;

  try {
    server = await startServer(port, dataFile);
    const contract = getConnectivityContract("secure-web");
    const created = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: { target: "https://example.com/health", ttlMinutes: 10, ephemeral: true, connectivityContract: contract }
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.connectivityContract.id, "secure-web");
    assert.equal(created.body.session.connectivityContract.version, 1);

    const inviteToken = created.body.credentials.invitationToken;
    const preview = await request(base, "/api/invitations", { token: inviteToken });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.session.connectivityContract.name, "Secure web service");
    assert.equal(preview.body.session.connectivityContract.checks.length, 4);

    const claimed = await request(base, "/api/invitations/claim", {
      method: "POST",
      token: inviteToken,
      body: { consent: true, includeTopology: true }
    });
    const exchanged = await request(base, "/api/client/exchange", {
      method: "POST",
      token: claimed.body.client.launchToken,
      body: { sessionId: created.body.session.id }
    });
    assert.equal(exchanged.status, 200);
    assert.equal(exchanged.body.session.connectivityContract.id, "secure-web");

    const invalid = await request(base, "/api/sessions", {
      method: "POST",
      token: ADMIN_TOKEN,
      body: {
        target: "example.com",
        ttlMinutes: 10,
        connectivityContract: { id: "bad", name: "Bad", checks: [{ type: "shell", required: true }] }
      }
    });
    assert.equal(invalid.status, 400);
    assert.match(invalid.body.error, /Unsupported connectivity contract check type/);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
