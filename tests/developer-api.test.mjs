import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FaultlineClient } from "../sdk/faultline-client.mjs";

const ADMIN_TOKEN = "developer-api-admin-token";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN, FAULTLINE_DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Faultline server did not start. Output: ${output}`)); }, 5_000);
    const onData = chunk => {
      output += chunk.toString();
      if (output.includes("preview listening on http://localhost:")) {
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

test("v1 API and SDK create correlated embedded diagnostics", { timeout: 20_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-api-v1-"));
  const port = 42000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;
  try {
    server = await startServer(port, join(dir, "faultline.json"));
    const client = new FaultlineClient({ baseUrl, token: ADMIN_TOKEN });
    const created = await client.createDiagnostic({
      target: "https://example.com/health",
      caseTitle: "Portal diagnostic",
      customer: "Example Ltd",
      externalRef: "TICKET-1842",
      ttlMinutes: 15,
      ephemeral: true
    });
    assert.equal(created.case.externalRef, "TICKET-1842");
    assert.equal(created.correlation.externalRef, "TICKET-1842");
    assert.ok(created.invitation.path.includes("/diagnose#invite="));
    assert.equal(created.case.sessionCount, 1);

    const status = await client.getDiagnostic(created.case.id);
    assert.equal(status.status.sessionCount, 1);
    assert.equal(status.status.completedRunCount, 0);

    const second = await client.createRun(created.case.id, { target: "example.net", ttlMinutes: 15, ephemeral: true });
    assert.equal(second.case.sessionCount, 2);
    assert.ok(second.invitation.path.includes("/diagnose#invite="));

    const events = await client.getEvents(created.case.id);
    assert.equal(events.externalRef, "TICKET-1842");
    assert.ok(Array.isArray(events.events));

    const evidence = await client.getEvidence(created.case.id, { redaction: "network-identifiers" });
    assert.equal(evidence.case.id, created.case.id);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test("SDK rejects failed responses with status metadata", async () => {
  const client = new FaultlineClient({
    baseUrl: "https://faultline.invalid",
    token: "test",
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: "nope" }) })
  });
  await assert.rejects(() => client.getDiagnostic("CASE-X"), error => error.status === 401 && error.message === "nope");
});
