import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The public demo API, exercised through a real server process in the hosted
// runtime it will actually run in.
//
// Two things are being proved and they pull in opposite directions:
//
//   1. an unauthenticated visitor CAN use the demo, because a portfolio demo
//      behind a credential is not a demo;
//   2. an unauthenticated visitor can do NOTHING ELSE - every operator surface
//      still refuses them, and the one endpoint that reaches the network will
//      only reach an allowlisted public host on port 80 or 443.
//
// No test here needs the public Internet: policy rejects before any egress, and
// the recorded investigations make no outbound connection at all.

const ADMIN_TOKEN = "demo-routes-admin-token";
const STARTED = "preview listening on http://localhost:";

function startServer(port, dataFile, env = {}) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: dataFile,
      FAULTLINE_RUNTIME: "hosted",
      VERCEL: "1",
      VERCEL_REGION: "test1",
      // Enough headroom for the policy sweep below, which deliberately spends a
      // slot per refused target (see src/demo/limits.mjs).
      FAULTLINE_DEMO_RATE_PER_MIN: "120",
      FAULTLINE_DEMO_RATE_INSTANCE_PER_MIN: "600",
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server did not start: ${output}`)); }, 10_000);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes(STARTED)) { clearTimeout(timer); resolve({ child, output: () => output }); }
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

async function request(base, path, { method = "GET", body, token, headers = {} } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, body: parsed, text, headers: response.headers };
}

test("the hosted public demo is usable without a credential, and nothing else is", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "faultline-demo-routes-"));
  const port = 4187;
  const base = `http://127.0.0.1:${port}`;
  const { child, output } = await startServer(port, join(directory, "state.json"));

  try {
    await t.test("the runtime describes itself as a hosted public demo", async () => {
      const { status, body } = await request(base, "/api/capabilities");
      assert.equal(status, 200);
      assert.equal(body.runtime, "hosted");
      assert.equal(body.publicDemo, true);
      assert.equal(body.vantage.label, "VERCEL VANTAGE");
      assert.equal(body.endpointLocal, false);
      assert.equal(body.analyst.available, false);
      assert.equal(body.durablePersistence, false);
      // No credential material, ever.
      assert.doesNotMatch(JSON.stringify(body), new RegExp(ADMIN_TOKEN));
    });

    await t.test("the served HTML is stamped with the runtime for the first paint", async () => {
      const { status, text } = await request(base, "/");
      assert.equal(status, 200);
      assert.match(text, /data-runtime="hosted"/);
      assert.match(text, /data-public-demo="true"/);
      assert.match(text, /data-vantage-label="VERCEL VANTAGE"/);
      // And never leaks the credential into the page.
      assert.doesNotMatch(text, new RegExp(ADMIN_TOKEN));
    });

    await t.test("the demo policy is published so a visitor knows the limits", async () => {
      const { status, body } = await request(base, "/api/demo/capabilities");
      assert.equal(status, 200);
      assert.deepEqual(body.demo.liveDiagnostic.allowedPorts, [80, 443]);
      assert.equal(body.demo.liveDiagnostic.allowlistOnly, true);
      assert.equal(body.demo.liveDiagnostic.literalAddresses, false);
      assert.ok(body.demo.liveDiagnostic.allowlist.includes("github.com"));
      assert.equal(body.demo.rateLimit.durable, false);
      assert.equal(body.demo.recordedIncidents.length, 3);
    });

    await t.test("recorded investigations are served unauthenticated and marked simulated", async () => {
      const list = await request(base, "/api/demo/incidents");
      assert.equal(list.status, 200);
      assert.equal(list.body.incidents.length, 3);

      for (const entry of list.body.incidents) {
        const detail = await request(base, `/api/demo/incidents/${entry.slug}`);
        assert.equal(detail.status, 200, `${entry.slug} must be readable`);
        assert.equal(detail.body.notice.evidenceClass, "simulated");
        assert.equal(detail.body.isolate.available, true);
        assert.equal(detail.body.isolate.evidenceClass, "simulated");
        assert.equal(detail.body.isolate.verdict.classification, "FAILURE_DISCRIMINATOR");
        assert.ok(detail.body.capture.timeline.length > 10);
      }
    });

    await t.test("a capsule exports as HTML and as JSON", async () => {
      const html = await request(base, "/api/demo/incidents/ipv6-path-failure/capsule");
      assert.equal(html.status, 200);
      assert.match(html.headers.get("content-type"), /text\/html/);
      assert.match(html.headers.get("content-disposition"), /faultline-FLR-DEMO-IPV6\.html/);
      assert.ok(html.text.length > 5_000);

      const json = await request(base, "/api/demo/incidents/ipv6-path-failure/capsule?format=json");
      assert.equal(json.status, 200);
      assert.equal(json.body.incident.simulated, true);
      assert.ok(json.body.integrity.digest);
    });

    await t.test("a bad investigation reference is refused, never used as a path", async () => {
      assert.equal((await request(base, "/api/demo/incidents/nope")).status, 404);
      assert.equal((await request(base, "/api/demo/incidents/..%2F..%2Fpackage.json")).status, 400);
      assert.equal((await request(base, "/api/demo/incidents/a_b")).status, 400);
      assert.equal((await request(base, "/api/demo/nothing-here")).status, 404);
      assert.equal((await request(base, "/api/demo/diagnose")).status, 405);
    });

    await t.test("the public diagnostic refuses every unsafe target without a credential", async () => {
      // Each of these must be refused by POLICY, before any egress, and must
      // not consume a slow network round trip.
      const cases = [
        ["127.0.0.1", 400],
        ["169.254.169.254", 400],
        ["10.0.0.1", 400],
        ["192.168.0.1", 400],
        ["[::1]", 400],
        ["localhost", 400],
        ["metadata.google.internal", 403],
        ["evil.test", 403],
        ["notgithub.com", 403],
        ["github.com.evil.test", 403],
        ["https://github.com:22/", 400],
        ["https://github.com:6379/", 400],
        ["http://user:pass@github.com/", 400],
        ["file:///etc/passwd", 400],
        ["gopher://github.com/", 400],
        ["", 400]
      ];

      for (const [target, expected] of cases) {
        const { status, body } = await request(base, "/api/demo/diagnose", { method: "POST", body: { target } });
        assert.equal(status, expected, `${JSON.stringify(target)} expected ${expected}, got ${status}: ${body?.error}`);
        assert.ok(body.error, "a refusal must explain itself");
      }
    });

    await t.test("operator surfaces stay behind the admin credential", async () => {
      const guarded = [
        ["POST", "/api/live/diagnostics", { target: "github.com" }],
        ["GET", "/api/live/capabilities", null],
        ["GET", "/api/incidents", null],
        ["GET", "/api/probes", null],
        ["POST", "/api/probes", { name: "x" }],
        ["GET", "/api/audit", null],
        ["GET", "/api/sessions", null],
        ["POST", "/api/sessions", { target: "github.com" }],
        ["GET", "/api/agent-runs", null],
        ["GET", "/api/recorder/status", null],
        ["POST", "/api/recorder/start", { target: "github.com" }],
        ["GET", "/api/recorder/scenarios", null],
        ["POST", "/api/bisect/runs", { target: "github.com" }],
        ["GET", "/api/analyst/status", null],
        ["GET", "/api/cases", null]
      ];

      for (const [method, path, body] of guarded) {
        const anonymous = await request(base, path, { method, body });
        assert.equal(anonymous.status, 401, `${method} ${path} must require the admin credential (got ${anonymous.status})`);
      }

      // And the credential still works, so the demo has not broken admin mode.
      const authorised = await request(base, "/api/probes", { token: ADMIN_TOKEN });
      assert.equal(authorised.status, 200);
      assert.ok(Array.isArray(authorised.body));
    });

    await t.test("a wrong credential is refused", async () => {
      const wrong = await request(base, "/api/probes", { token: "not-the-token" });
      assert.equal(wrong.status, 401);
    });

    await t.test("the credential is never printed on a hosted runtime", async () => {
      assert.doesNotMatch(output(), new RegExp(ADMIN_TOKEN));
      assert.doesNotMatch(output(), /fl_admin_/);
    });

    await t.test("health reports the hosted runtime honestly", async () => {
      const { status, body } = await request(base, "/api/health");
      assert.equal(status, 200);
      assert.equal(body.runtime, "hosted");
      assert.equal(body.publicDemo, true);
      assert.equal(body.persistence, false, "hosted storage is ephemeral and must not claim otherwise");
      assert.equal(body.localAnalyst, false);
    });
  } finally {
    await stopServer(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("a hosted deployment with no configured credential locks admin out rather than minting one", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "faultline-demo-nocred-"));
  const port = 4188;
  const base = `http://127.0.0.1:${port}`;
  const { child, output } = await startServer(port, join(directory, "state.json"), { FAULTLINE_ADMIN_TOKEN: "" });

  try {
    // The banner lines follow the "listening" line the start helper waits for,
    // so give stdout a moment to flush before reading it.
    await new Promise(resolve => setTimeout(resolve, 300));

    // The startup banner must say the surfaces are unreachable, and must not
    // print a generated credential into a platform log.
    assert.match(output(), /Admin and operator APIs are unreachable/);
    assert.doesNotMatch(output(), /fl_admin_/);

    // The public demo still works.
    assert.equal((await request(base, "/api/demo/incidents")).status, 200);
    // Admin does not.
    assert.equal((await request(base, "/api/probes")).status, 401);
  } finally {
    await stopServer(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("the demo router does not exist on a local install", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "faultline-demo-local-"));
  const port = 4189;
  const base = `http://127.0.0.1:${port}`;
  const { child } = await startServer(port, join(directory, "state.json"), {
    FAULTLINE_RUNTIME: "local",
    VERCEL: "",
    FAULTLINE_PUBLIC_DEMO: "false"
  });

  try {
    const capabilities = await request(base, "/api/capabilities");
    assert.equal(capabilities.body.runtime, "local");
    assert.equal(capabilities.body.publicDemo, false);
    assert.equal(capabilities.body.vantage.label, "LOCAL");

    // The public routes are simply absent - not open, not 403, absent.
    assert.equal((await request(base, "/api/demo/incidents")).status, 404);
    assert.equal((await request(base, "/api/demo/capabilities")).status, 404);
    assert.equal((await request(base, "/api/demo/diagnose", { method: "POST", body: { target: "github.com" } })).status, 404);

    // And the page is stamped as a local install, so the frontend lands on
    // Overview rather than a demo that has no backend.
    const page = await request(base, "/");
    assert.match(page.text, /data-public-demo="false"/);
    assert.match(page.text, /data-runtime="local"/);
  } finally {
    await stopServer(child);
    await rm(directory, { recursive: true, force: true });
  }
});
