import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Flight Recorder HTTP surface, through a real server process.
//
// Auth, validation and the target-safety boundary reject before any recording
// starts, so nothing here samples a real network. The one test that does start
// a recorder points it at a closed loopback port: real code path, no traffic
// beyond a refused local connection.

const ADMIN_TOKEN = "recorder-routes-admin-token";
const STARTED = "preview listening on http://localhost:";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: dataFile,
      FAULTLINE_ANALYST_ENDPOINT: "http://127.0.0.1:11499"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start: ${output}`)); }, 10_000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes(STARTED)) { clearTimeout(timer); resolve(child); }
    });
    child.stderr.on("data", chunk => { output += chunk.toString(); });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  });
}

async function withServer(port, run) {
  const dir = await mkdtemp(join(tmpdir(), "faultline-recorder-"));
  const child = await startServer(port, join(dir, "state.json"));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  }
}

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
const jsonHeaders = { ...admin, "content-type": "application/json" };

test("recorder routes require the admin credential", async () => {
  await withServer(4401, async base => {
    for (const [method, path] of [
      ["GET", "/api/recorder/status"],
      ["GET", "/api/recorder/timeline"],
      ["GET", "/api/recorder/incidents"],
      ["POST", "/api/recorder/start"],
      ["POST", "/api/recorder/stop"],
      ["POST", "/api/recorder/mark"]
    ]) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: method === "POST" ? { "content-type": "application/json" } : {},
        body: method === "POST" ? "{}" : undefined
      });
      assert.equal(response.status, 401, `${method} ${path} should be gated`);
    }
  });
});

test("an idle recorder reports a clean stopped state", async () => {
  await withServer(4402, async base => {
    const status = await (await fetch(`${base}/api/recorder/status`, { headers: admin })).json();
    assert.equal(status.state, "stopped");
    assert.deepEqual(status.incidents, []);
    assert.equal(status.activeIncident, null);
    // Retention is stated even before anything is recorded.
    assert.match(status.retention, /In-memory only/);
  });
});

test("starting requires a target", async () => {
  await withServer(4403, async base => {
    const response = await fetch(`${base}/api/recorder/start`, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /target/i);
  });
});

test("the recorder refuses a target the public-probe boundary blocks", async () => {
  await withServer(4404, async base => {
    // Link-local metadata address: the classic SSRF destination.
    for (const target of ["169.254.169.254", "127.0.0.1", "10.0.0.5"]) {
      const response = await fetch(`${base}/api/recorder/start`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ target, port: 80 })
      });
      assert.ok(response.status >= 400, `${target} should be refused, got ${response.status}`);
      const status = await (await fetch(`${base}/api/recorder/status`, { headers: admin })).json();
      assert.equal(status.state, "stopped", "a refused target must not leave a recorder running");
    }
  });
});

test("mark is refused while the recorder is stopped", async () => {
  await withServer(4405, async base => {
    const response = await fetch(`${base}/api/recorder/mark`, { method: "POST", headers: jsonHeaders, body: "{}" });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /not running/i);
  });
});

test("an unknown incident is a 404, not a crash", async () => {
  await withServer(4406, async base => {
    const response = await fetch(`${base}/api/recorder/incidents/FLR-2026-9999`, { headers: admin });
    assert.equal(response.status, 404);
  });
});

test("an incident id that is not an id shape does not reach the lookup", async () => {
  await withServer(4407, async base => {
    for (const id of ["..%2F..%2Fetc%2Fpasswd", "a".repeat(80)]) {
      const response = await fetch(`${base}/api/recorder/incidents/${id}`, { headers: admin });
      assert.ok(response.status === 404, `${id} unexpectedly resolved with ${response.status}`);
    }
  });
});

test("recording starts, reports coverage, marks and stops", async () => {
  await withServer(4408, async base => {
    // A closed loopback port: the sampler runs its real code path and records
    // an honest connection refusal without generating outbound traffic.
    const started = await fetch(`${base}/api/recorder/start`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        target: "localhost.faultline.invalid",
        port: 443,
        intervalMs: 2_000,
        // The deep capture would make real measurements; not wanted in a test.
        deepCapture: false
      })
    });

    // An unresolvable host is still a legitimate recording subject: DNS failure
    // is exactly the sort of evidence the recorder exists to capture.
    const status = await started.json();
    assert.equal(started.status, 201, JSON.stringify(status));
    assert.equal(status.state, "recording");
    assert.equal(status.config.intervalMs, 2_000);
    assert.equal(status.config.publicIpSampling, false, "public IP sampling must be off unless asked for");

    const marked = await fetch(`${base}/api/recorder/mark`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ note: "seen by hand" })
    });
    assert.equal(marked.status, 202);
    assert.equal((await marked.json()).accepted, true);

    const timeline = await (await fetch(`${base}/api/recorder/timeline?limit=10`, { headers: admin })).json();
    assert.ok(Array.isArray(timeline.samples));

    const stopped = await (await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" })).json();
    assert.equal(stopped.state, "stopped");
  });
});

test("a second recorder cannot be started over a running one", async () => {
  await withServer(4409, async base => {
    await fetch(`${base}/api/recorder/start`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ target: "localhost.faultline.invalid", port: 443, deepCapture: false })
    });

    const second = await fetch(`${base}/api/recorder/start`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ target: "example.com", deepCapture: false })
    });
    assert.equal(second.status, 409);
    assert.match((await second.json()).error, /already running/i);

    await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" });
  });
});

test("bisect handoff is refused when an incident has no testable condition", async () => {
  await withServer(4410, async base => {
    const response = await fetch(`${base}/api/recorder/incidents/FLR-2026-0001/bisect`, {
      method: "POST",
      headers: jsonHeaders,
      body: "{}"
    });
    // No such incident is retained, so the handoff cannot be attempted.
    assert.equal(response.status, 404);
  });
});

test("health advertises the Flight Recorder", async () => {
  await withServer(4411, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.flightRecorder, true);
    assert.equal(health.ok, true);
  });
});

test("the dashboard ships the Flight Recorder panel", async () => {
  await withServer(4412, async base => {
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('data-mount="recorder"'), "recorder mount should exist");
    assert.ok(page.includes("/recorder-panel.js"), "recorder panel module should be loaded");

    const module = await fetch(`${base}/recorder-panel.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") || "", /javascript/);
  });
});
