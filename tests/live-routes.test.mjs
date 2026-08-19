import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Exercises the live/environment routes through a real server process.
// Deliberately avoids the public Internet: only auth, validation and
// scope-enforcement paths are tested here (they reject before any egress).

const ADMIN_TOKEN = "live-routes-admin-token";
const STARTED = "preview listening on http://localhost:";

function startServer(port, dataFile) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN, FAULTLINE_DATA_FILE: dataFile },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start: ${output}`)); }, 8_000);
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
    setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2_000).unref();
  });
}

async function request(base, path, { method = "GET", body, token } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("live and environment routes enforce auth, scope and validation", { timeout: 40_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-live-routes-"));
  const port = 37100 + Math.floor(Math.random() * 700);
  const base = `http://127.0.0.1:${port}`;
  let server = null;

  try {
    server = await startServer(port, join(dir, "faultline.json"));

    // --- authentication ---------------------------------------------------
    assert.equal((await request(base, "/api/live/capabilities")).status, 401);
    assert.equal((await request(base, "/api/live/capabilities", { token: "wrong" })).status, 401);
    assert.equal((await request(base, "/api/live/diagnostics", { method: "POST", body: { target: "example.com" } })).status, 401);
    assert.equal((await request(base, "/api/environment/manifest", { method: "POST", body: {} })).status, 401);

    const caps = await request(base, "/api/live/capabilities", { token: ADMIN_TOKEN });
    assert.equal(caps.status, 200);
    const radar = caps.body.sources.find(s => s.id === "cloudflare-radar");
    assert.equal(radar.requiresCredential, true);
    assert.equal(radar.enabled, false, "Radar must be disabled without a configured token");
    for (const id of ["ripestat", "globalping", "ioda", "peeringdb", "ripe-atlas"]) {
      const source = caps.body.sources.find(s => s.id === id);
      assert.equal(source.requiresCredential, false, `${id} must need no credential`);
      assert.equal(source.enabled, true);
    }

    // --- SSRF / private-target refusal (rejects before any egress) ---------
    for (const target of [
      "http://127.0.0.1/", "http://10.0.0.1/", "http://192.168.1.1/",
      "http://169.254.169.254/", "http://[::1]/", "http://100.64.0.1/"
    ]) {
      const result = await request(base, "/api/live/diagnostics", { method: "POST", token: ADMIN_TOKEN, body: { target } });
      assert.equal(result.status, 400, target);
      assert.match(result.body.error, /cannot target|approved ports/i, target);
    }

    // Non-approved port on a public target is refused for public scope.
    const badPort = await request(base, "/api/live/diagnostics", { method: "POST", token: ADMIN_TOKEN, body: { target: "example.com", port: 22 } });
    assert.equal(badPort.status, 400);
    assert.match(badPort.body.error, /approved ports/i);

    // --- input validation --------------------------------------------------
    assert.equal((await request(base, "/api/live/diagnostics", { method: "POST", token: ADMIN_TOKEN, body: {} })).status, 400);
    const badScheme = await request(base, "/api/live/diagnostics", { method: "POST", token: ADMIN_TOKEN, body: { target: "ftp://example.com" } });
    assert.equal(badScheme.status, 400);
    assert.match(badScheme.body.error, /HTTP and HTTPS/);

    // --- manifest preview / activation ------------------------------------
    const manifest = {
      version: 1,
      name: "Test environment",
      sites: [{ id: "glasgow", name: "Glasgow Office" }],
      targets: [
        { name: "Portal", url: "https://example.com", scope: "public" },
        { name: "CRM", host: "10.40.12.25", port: 443, scope: "private", site: "glasgow" }
      ]
    };

    const preview = await request(base, "/api/environment/manifest/preview", { method: "POST", token: ADMIN_TOKEN, body: { manifest } });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.summary.privateTargets, 1);
    assert.equal(preview.body.preview, true);

    // Activation with NO private probe registered: the private target must be
    // reported as blocked rather than silently run by a public probe.
    const activated = await request(base, "/api/environment/manifest", { method: "POST", token: ADMIN_TOKEN, body: { manifest } });
    assert.equal(activated.status, 201);
    const crm = activated.body.targets.find(t => t.name === "CRM");
    assert.equal(crm.requiresPrivateProbe, true);
    assert.equal(crm.runnable, false);
    assert.match(crm.blockedReason, /never measured by a public probe/);
    const portal = activated.body.targets.find(t => t.name === "Portal");
    assert.equal(portal.runnable, true);
    assert.equal(activated.body.privateProbes.length, 0);

    // Register a PRIVATE probe, then the private target becomes runnable.
    const probe = await request(base, "/api/probes", {
      method: "POST", token: ADMIN_TOKEN,
      body: { name: "glasgow-private", location: "Glasgow Office", scope: "private" }
    });
    assert.equal(probe.status, 201);
    assert.equal(probe.body.probe.scope, "private");

    const reactivated = await request(base, "/api/environment/manifest", { method: "POST", token: ADMIN_TOKEN, body: { manifest } });
    const crmAfter = reactivated.body.targets.find(t => t.name === "CRM");
    assert.equal(crmAfter.runnable, true, "a registered private probe unblocks private targets");
    assert.equal(reactivated.body.privateProbes.length, 1);
    assert.equal(JSON.stringify(reactivated.body).includes("tokenHash"), false, "probe credential hashes must not leak");

    // A public probe must never be offered for a private target.
    const publicProbe = await request(base, "/api/probes", {
      method: "POST", token: ADMIN_TOKEN, body: { name: "public-vantage", scope: "public" }
    });
    assert.equal(publicProbe.status, 201);
    const withPublic = await request(base, "/api/environment/manifest", { method: "POST", token: ADMIN_TOKEN, body: { manifest } });
    assert.equal(withPublic.body.privateProbes.every(p => p.scope === "private"), true);
    assert.equal(withPublic.body.privateProbes.length, 1, "only private probes may satisfy a private target");

    // --- manifest rejection through the API --------------------------------
    const withSecret = await request(base, "/api/environment/manifest/preview", {
      method: "POST", token: ADMIN_TOKEN,
      body: { manifest: { version: 1, targets: [{ name: "X", url: "https://example.com", password: "hunter2" }] } }
    });
    assert.equal(withSecret.status, 400);
    assert.match(withSecret.body.error, /credential fields/);

    const privateAsPublic = await request(base, "/api/environment/manifest/preview", {
      method: "POST", token: ADMIN_TOKEN,
      body: { manifest: { version: 1, targets: [{ name: "X", host: "192.168.1.1", scope: "public" }] } }
    });
    assert.equal(privateAsPublic.status, 400);
    assert.match(privateAsPublic.body.error, /cannot be declared public/);

    // Unmatched live route still returns the JSON 404 from the audit fix.
    const missing = await request(base, "/api/live/nope", { token: ADMIN_TOKEN });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /No Faultline API route matches/);
  } finally {
    await stopServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});
