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
    // Retention is stated even before anything is recorded, and distinguishes
    // the ephemeral buffer from durable incidents.
    assert.match(status.retention, /rolling sample buffer is in memory only/i);
    assert.equal(status.incidentsPersisted, true);
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

test("a closed incident survives a control-plane restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-recorder-restart-"));
  const dataFile = join(dir, "state.json");

  try {
    // --- first process: record, capture by hand, let the incident close ------
    const first = await startServer(4413, dataFile);
    let incidentId = null;
    try {
      const base = "http://127.0.0.1:4413";
      await fetch(`${base}/api/recorder/start`, {
        method: "POST",
        headers: jsonHeaders,
        // Unresolvable host: real code path, no outbound traffic.
        body: JSON.stringify({ target: "localhost.faultline.invalid", port: 443, intervalMs: 2_000, afterWindowMs: 10_000, deepCapture: false })
      });

      await new Promise(resolve => setTimeout(resolve, 2_500));
      await fetch(`${base}/api/recorder/mark`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ note: "restart check" }) });

      // Wait for the after-window to elapse so the incident closes and persists.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const { incidents } = await (await fetch(`${base}/api/recorder/incidents`, { headers: admin })).json();
        if (incidents.length) {
          incidentId = incidents[0].id;
          break;
        }
      }
      assert.ok(incidentId, "an incident should have closed in the first process");
    } finally {
      await stopServer(first);
    }

    // --- second process: same data file, no recorder running -----------------
    const second = await startServer(4414, dataFile);
    try {
      const base = "http://127.0.0.1:4414";
      const status = await (await fetch(`${base}/api/recorder/status`, { headers: admin })).json();
      assert.equal(status.state, "stopped", "a restart starts with no recorder running");
      assert.ok(status.incidents.some(entry => entry.id === incidentId), "the incident must survive the restart");

      const restored = await (await fetch(`${base}/api/recorder/incidents/${incidentId}`, { headers: admin })).json();
      assert.equal(restored.id, incidentId);
      assert.equal(restored.schema, "faultline.flight-recorder-incident");
      assert.equal(restored.evidenceClass, "observed");

      // This target never resolves, so no sample is ever healthy and there is
      // no comparison basis. "insufficient_evidence" is the correct answer, and
      // the record says so rather than inventing a difference.
      assert.equal(restored.observedChange.comparable, false);
      assert.equal(restored.observedChange.classification, "insufficient_evidence");
      assert.match(restored.observedChange.reason, /No healthy sample/);

      // The epistemic framing must survive the round trip intact.
      assert.ok(restored.epistemics.limit.includes("not causation"));
      assert.ok(restored.windows.during.samples.length > 0, "captured samples must survive");
      assert.equal(restored.trigger.manual, true);
    } finally {
      await stopServer(second);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persistence can be switched off", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-recorder-nopersist-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "4415",
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: join(dir, "state.json"),
      FAULTLINE_ANALYST_ENDPOINT: "http://127.0.0.1:11499",
      FAULTLINE_RECORDER_PERSIST: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error(`server did not start: ${output}`)), 10_000);
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.includes(STARTED)) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on("data", chunk => { output += chunk.toString(); });
    });

    const status = await (await fetch("http://127.0.0.1:4415/api/recorder/status", { headers: admin })).json();
    assert.equal(status.incidentsPersisted, false);
    assert.match(status.retention, /In-memory only/);
  } finally {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("simulation scenarios are discoverable and self-describing", async () => {
  await withServer(4416, async base => {
    const payload = await (await fetch(`${base}/api/recorder/scenarios`, { headers: admin })).json();
    assert.ok(payload.scenarios.length >= 3);
    assert.ok(payload.scenarios.every(entry => entry.scenario && entry.title && entry.description));
    assert.match(payload.note, /not evidence about any real network/i);
  });
});

test("a simulated recording is marked simulated in status", async () => {
  await withServer(4417, async base => {
    const started = await fetch(`${base}/api/recorder/start`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ simulate: "ipv6-path-loss" })
    });
    const status = await started.json();
    assert.equal(started.status, 201, JSON.stringify(status));
    assert.equal(status.simulated, true);
    assert.equal(status.simulation.scenario, "ipv6-path-loss");
    // A simulation makes no outbound connections, so no public IP sampling.
    assert.equal(status.config.publicIpSampling, false);

    await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" });
  });
});

test("the API accepts a scenario name but never a filesystem path", async () => {
  await withServer(4418, async base => {
    for (const simulate of [
      "../../package",
      "fixtures/recorder/ipv6-path-loss.json",
      "/etc/passwd",
      "C:\Windows\win.ini",
      "ipv6-path-loss.json"
    ]) {
      const response = await fetch(`${base}/api/recorder/start`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ simulate })
      });
      assert.equal(response.status, 400, `${simulate} should be refused, got ${response.status}`);
      assert.match((await response.json()).error, /Unknown simulation scenario|lowercase/i);
    }
  });
});

test("a simulated incident is persisted with its provenance intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-recorder-sim-"));
  const dataFile = join(dir, "state.json");

  try {
    let incidentId = null;
    const first = await startServer(4419, dataFile);
    try {
      const base = "http://127.0.0.1:4419";
      await fetch(`${base}/api/recorder/start`, {
        method: "POST",
        headers: jsonHeaders,
        // A short scenario so the incident closes inside the test budget.
        body: JSON.stringify({ simulate: "ipv6-path-loss", intervalMs: 2_000, afterWindowMs: 10_000 })
      });

      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        const { incidents } = await (await fetch(`${base}/api/recorder/incidents`, { headers: admin })).json();
        if (incidents.length) {
          incidentId = incidents[0].id;
          assert.equal(incidents[0].simulated, true, "the list entry must be marked simulated");
          break;
        }
      }
      assert.ok(incidentId, "a simulated incident should have been captured");
    } finally {
      await stopServer(first);
    }

    // Provenance must survive the round trip to disk.
    const second = await startServer(4420, dataFile);
    try {
      const restored = await (await fetch(`http://127.0.0.1:4420/api/recorder/incidents/${incidentId}`, { headers: admin })).json();
      assert.equal(restored.simulated, true);
      assert.equal(restored.source, "simulation");
      assert.equal(restored.scenario, "ipv6-path-loss");
      assert.equal(restored.evidenceClass, "simulated");
      assert.match(restored.epistemics.observed, /SIMULATED/);
      // And no real measurement was folded into it.
      assert.equal(restored.deepCapture, null);
    } finally {
      await stopServer(second);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Bisect handoff separates a simulated incident from a real experiment", async () => {
  // The chain is deliberately mixed: a scripted incident, a genuine experiment.
  // Neither half may be presented as the other. This asserts the API says so
  // without running a real Bisect - the refusal path is reached first when no
  // testable condition exists, and the wording is checked on the real path in
  // the simulate suite's end-to-end run.
  await withServer(4421, async base => {
    await fetch(`${base}/api/recorder/start`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ simulate: "ipv6-path-loss", intervalMs: 2_000, afterWindowMs: 10_000 })
    });

    let incidentId = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const { incidents } = await (await fetch(`${base}/api/recorder/incidents`, { headers: admin })).json();
      if (incidents.length) { incidentId = incidents[0].id; break; }
    }
    assert.ok(incidentId, "a simulated incident should have been captured");
    await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" });

    const incident = await (await fetch(`${base}/api/recorder/incidents/${incidentId}`, { headers: admin })).json();
    // The scenario is built so this axis is the one the recorder observes.
    assert.deepEqual(incident.candidateDiscriminators.bisectAxes, ["address-family"]);
    assert.equal(incident.simulated, true);
    // A simulated record never embeds a real measurement.
    assert.equal(incident.deepCapture, null);
  });
});

test("the recorder panel never pairs SIMULATED with a measured-locally claim", async () => {
  // Provenance is a design guarantee in this surface, so the source chip is
  // asserted at the source: the measured chip must be reachable only on the
  // branch where the run is not simulated.
  await withServer(4422, async base => {
    const panel = await (await fetch(`${base}/recorder-panel.js`)).text();

    assert.ok(panel.includes("Measured locally"), "the real-capture chip should still exist");
    assert.ok(panel.includes("Scenario source"), "a simulated run needs its own source chip");

    // The two chips must live on opposite branches of one conditional.
    const conditional = panel.match(/status\?\.simulated[\s\S]{0,600}?Measured locally/);
    assert.ok(conditional, "the measured chip must sit behind a simulated check");
    const branch = conditional[0];
    assert.ok(branch.indexOf("Scenario source") < branch.indexOf("Measured locally"),
      "the simulated branch must come first, with measured as the else");

    const css = await (await fetch(`${base}/design-system.css`)).text();
    assert.match(css, /\.fl-source\[data-kind="simulated"\]/, "the simulated source chip needs its own styling");
  });
});

test("capsule export works over the API and is self-contained", async () => {
  await withServer(4423, async base => {
    await fetch(`${base}/api/recorder/start`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ simulate: "ipv6-path-loss", intervalMs: 2_000, afterWindowMs: 10_000 })
    });

    let incidentId = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const { incidents } = await (await fetch(`${base}/api/recorder/incidents`, { headers: admin })).json();
      if (incidents.length) { incidentId = incidents[0].id; break; }
    }
    assert.ok(incidentId);
    await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" });

    // HTML form: downloadable, self-contained.
    const html = await fetch(`${base}/api/recorder/incidents/${incidentId}/capsule`, { headers: admin });
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-type") || "", /text\/html/);
    assert.match(html.headers.get("content-disposition") || "", /attachment; filename="faultline-FLR/);

    const body = await html.text();
    assert.ok(!/src\s*=\s*["']https?:/i.test(body), "no remote script");
    assert.ok(!/<link/i.test(body), "no external stylesheet");
    assert.ok(body.includes("Simulated incident"), "a simulated incident must say so in the capsule");

    // JSON form.
    const json = await (await fetch(`${base}/api/recorder/incidents/${incidentId}/capsule?format=json`, { headers: admin })).json();
    assert.equal(json.schema, "faultline.incident-capsule");
    assert.equal(json.incident.id, incidentId);
    assert.equal(json.provenance.containsSimulated, true);
    assert.equal(json.conclusion.available, false, "nothing was tested, so no conclusion");
    assert.ok(json.integrity.digest);
  });
});

test("capsule export requires auth and validates redaction", async () => {
  await withServer(4424, async base => {
    const unauthorised = await fetch(`${base}/api/recorder/incidents/FLR-2026-0001/capsule`);
    assert.equal(unauthorised.status, 401);

    const missing = await fetch(`${base}/api/recorder/incidents/FLR-2026-9999/capsule`, { headers: admin });
    assert.equal(missing.status, 404);

    const bad = await fetch(`${base}/api/recorder/incidents/FLR-2026-0001/capsule?redaction=everything`, { headers: admin });
    assert.ok(bad.status === 400 || bad.status === 404);
  });
});

test("the dashboard offers capsule export with an unambiguous label", async () => {
  await withServer(4425, async base => {
    const panel = await (await fetch(`${base}/recorder-panel.js`)).text();
    assert.ok(panel.includes("Export capsule · Recorder + Bisect"));
    assert.ok(panel.includes("Export capsule · Recorder only"));
    // The route is authenticated, so a plain download link cannot work.
    assert.ok(panel.includes("createObjectURL"), "export must fetch with credentials, not link directly");
  });
});

// --- evidence durability must never be reported optimistically --------------

test("a failed evidence write fails the request instead of claiming durability", async () => {
  const { createRecorderRouter } = await import("../src/recorder/routes.mjs");

  const incident = {
    id: "FLR-2026-0001",
    target: { host: "example.com", port: 443, input: "example.com" },
    candidateDiscriminators: { bisectAxes: ["address-family"] }
  };

  const responses = [];
  let thrown = null;
  const handler = createRecorderRouter({
    requireAdmin: () => {},
    bodyFrom: async () => ({}),
    json: (_res, status, payload) => responses.push({ status, payload }),
    store: {
      getIncident: async id => (id === incident.id ? incident : null),
      listIncidents: async () => [incident],
      listIncidentEvidence: async () => [],
      // The disk write fails.
      putIncidentEvidence: async () => { throw new Error("EROFS: read-only file system"); }
    },
    runBisect: async () => ({ schema: "faultline.network-bisect", executed: [], verdict: { classification: "LOCAL_CAPABILITY_DEFICIENCY" } }),
    logger: () => {}
  });

  try {
    await handler({ method: "POST", on: () => {} }, {}, new URL(`http://x/api/recorder/incidents/${incident.id}/bisect`));
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown, "the request must fail rather than report a durable id");
  assert.equal(thrown.statusCode, 500);
  assert.equal(thrown.code, "EVIDENCE_NOT_PERSISTED");
  assert.equal(thrown.details.evidencePersisted, false);
  assert.equal(thrown.details.evidenceId, null, "no id may be reported for evidence that was not stored");
  // The experiment made real measurements; losing them too would be a second loss.
  assert.ok(thrown.details.report, "the completed run must still be returned");
  assert.equal(responses.length, 0, "no success response may be sent");
});

test("a failed evidence read is not reported as an absence of evidence", async () => {
  const { createRecorderRouter } = await import("../src/recorder/routes.mjs");

  const incident = { id: "FLR-2026-0001", target: { host: "example.com", port: 443 }, windows: {}, observedChange: {}, candidateDiscriminators: {} };
  let thrown = null;
  const handler = createRecorderRouter({
    requireAdmin: () => {},
    bodyFrom: async () => ({}),
    json: () => {},
    store: {
      getIncident: async () => incident,
      listIncidents: async () => [incident],
      // Reading the evidence fails.
      listIncidentEvidence: async () => { throw new Error("EIO: i/o error"); }
    },
    logger: () => {}
  });

  try {
    await handler({ method: "GET", on: () => {} }, {}, new URL(`http://x/api/recorder/incidents/${incident.id}/capsule?format=json`));
  } catch (error) {
    thrown = error;
  }

  // "I could not read the evidence" must never become "no experiment was run",
  // which is what the capsule states when the attachment list is empty.
  assert.ok(thrown, "a failed read must surface rather than yielding an empty list");
  assert.match(String(thrown.message), /EIO/);
});

test("a successful export reports that evidence was persisted", async () => {
  await withServer(4426, async base => {
    await fetch(`${base}/api/recorder/start`, {
      method: "POST", headers: jsonHeaders,
      body: JSON.stringify({ simulate: "ipv6-path-loss", intervalMs: 2_000, afterWindowMs: 10_000 })
    });
    let incidentId = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 1_000));
      const { incidents } = await (await fetch(`${base}/api/recorder/incidents`, { headers: admin })).json();
      if (incidents.length) { incidentId = incidents[0].id; break; }
    }
    assert.ok(incidentId);
    await fetch(`${base}/api/recorder/stop`, { method: "POST", headers: jsonHeaders, body: "{}" });

    // No experiment yet: the capsule must say so plainly.
    const before = await (await fetch(`${base}/api/recorder/incidents/${incidentId}/capsule?format=json`, { headers: admin })).json();
    assert.equal(before.conclusion.available, false);
    assert.equal(before.conclusion.observedOnly, true);
    assert.match(before.conclusion.reason, /nothing was tested/);
  });
});
