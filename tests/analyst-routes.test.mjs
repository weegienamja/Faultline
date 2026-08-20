import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchStylesheet } from "./stylesheet-helper.mjs";

// Analyst HTTP surface, exercised through a real server process.
//
// No Ollama is required: the endpoint is pointed at a closed loopback port, so
// the runtime is genuinely unavailable and the "clean unavailable state" path
// is what gets tested. Auth, validation and the absence of a proxy route do not
// depend on a model being installed.

const ADMIN_TOKEN = "analyst-routes-admin-token";
const STARTED = "preview listening on http://localhost:";
/** A loopback port nothing is listening on: valid endpoint, dead runtime. */
const DEAD_OLLAMA = "http://127.0.0.1:11499";

function startServer(port, dataFile, extraEnv = {}) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: dataFile,
      FAULTLINE_ANALYST_ENDPOINT: DEAD_OLLAMA,
      ...extraEnv
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
  const dir = await mkdtemp(join(tmpdir(), "faultline-analyst-"));
  const child = await startServer(port, join(dir, "state.json"));
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  }
}

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** Read an SSE body into its parsed events. */
async function readSse(response) {
  const events = [];
  const text = await response.text();
  for (const frame of text.split("\n\n")) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // Ignore keep-alive comments.
      }
    }
  }
  return events;
}

test("analyst routes require the admin credential", async () => {
  await withServer(4181, async base => {
    for (const [method, path] of [
      ["GET", "/api/analyst/status"],
      ["GET", "/api/analyst/capabilities"],
      ["POST", "/api/analyst/ask"],
      ["POST", "/api/analyst/install"],
      ["POST", "/api/analyst/conversation/clear"]
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

test("status reports a clean unavailable state when Ollama is not running", async () => {
  await withServer(4182, async base => {
    const response = await fetch(`${base}/api/analyst/status`, { headers: admin });
    assert.equal(response.status, 200);

    const status = await response.json();
    assert.equal(status.state, "OLLAMA_UNAVAILABLE");
    assert.equal(status.ready, false);
    assert.equal(status.local, true);
    assert.equal(status.privacy.cloudInference, false);
    assert.equal(status.privacy.telemetry, false);
    assert.ok(status.remedy, "an unavailable runtime should say what to do");
    // The product name is the user-facing identity, not the runtime's.
    assert.equal(status.product, "Faultline Analyst");
  });
});

test("capabilities advertise a read-only tool surface and no write tools", async () => {
  await withServer(4183, async base => {
    const capabilities = await (await fetch(`${base}/api/analyst/capabilities`, { headers: admin })).json();
    assert.equal(capabilities.readOnly, true);
    assert.deepEqual(capabilities.writeTools, []);
    assert.ok(capabilities.tools.length > 5);
    for (const tool of capabilities.tools) {
      assert.match(tool.name, /^(get|search)_/);
      assert.ok(tool.why.length > 20);
    }
    assert.ok(capabilities.starterQuestions.bisect.length > 0);
  });
});

test("asking while the runtime is down returns a structured refusal, not a crash", async () => {
  await withServer(4184, async base => {
    const response = await fetch(`${base}/api/analyst/ask`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ question: "What is wrong?", view: { view: "bisect" } })
    });
    assert.equal(response.status, 503);

    const payload = await response.json();
    assert.equal(payload.analystAvailable, false);
    assert.equal(payload.state, "OLLAMA_UNAVAILABLE");
    // No stack trace should reach the client.
    assert.ok(!JSON.stringify(payload).includes("at Object."), "internal stack detail leaked");
  });
});

test("installing while the runtime is down streams an error rather than throwing", async () => {
  await withServer(4185, async base => {
    const response = await fetch(`${base}/api/analyst/install`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen3:8b" })
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);

    const events = await readSse(response);
    assert.ok(events.some(event => event.type === "error"), "expected a clean error event");
  });
});

test("a cloud model cannot be requested for installation", async () => {
  await withServer(4186, async base => {
    const response = await fetch(`${base}/api/analyst/install`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ model: "kimi-k3:cloud" })
    });
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.match(payload.error, /Cloud-hosted models are not permitted/);
  });
});

test("a model name that is a path or url is refused", async () => {
  await withServer(4187, async base => {
    for (const model of ["../../etc/passwd", "http://evil.example/model", "qwen3;whoami"]) {
      const response = await fetch(`${base}/api/analyst/install`, {
        method: "POST",
        headers: { ...admin, "content-type": "application/json" },
        body: JSON.stringify({ model })
      });
      assert.equal(response.status, 400, `${model} should be refused`);
    }
  });
});

test("no generic proxy route exists on the analyst surface", async () => {
  await withServer(4188, async base => {
    for (const path of [
      "/api/analyst/proxy?url=http://169.254.169.254/",
      "/api/analyst/ollama/api/chat",
      "/api/analyst/../live/diagnostics",
      "/api/proxy?url=http://example.com"
    ]) {
      const response = await fetch(`${base}${path}`, { headers: admin });
      assert.ok(response.status === 404 || response.status === 400,
        `${path} unexpectedly resolved with ${response.status}`);
    }
  });
});

test("the analyst endpoint cannot be pointed off-loopback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "faultline-analyst-bad-"));
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: "4189",
      FAULTLINE_ADMIN_TOKEN: ADMIN_TOKEN,
      FAULTLINE_DATA_FILE: join(dir, "state.json"),
      // An operator mistake, or an attempt to exfiltrate evidence.
      FAULTLINE_ANALYST_ENDPOINT: "http://198.51.100.9:11434"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    let output = "";
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 6_000);
      const onData = chunk => {
        output += chunk.toString();
        if (output.includes(STARTED)) { clearTimeout(timer); resolve(); }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });

    // The server still serves Faultline; the Analyst refuses.
    const response = await fetch("http://127.0.0.1:4189/api/analyst/status", { headers: admin });
    assert.equal(response.status, 500);
    const payload = await response.json();
    assert.match(payload.error, /loopback/i);

    // Deterministic Faultline is unaffected by a broken Analyst configuration.
    const health = await fetch("http://127.0.0.1:4189/api/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    await stopServer(child);
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearing a conversation is accepted and reports what happened", async () => {
  await withServer(4290, async base => {
    const response = await fetch(`${base}/api/analyst/conversation/clear`, {
      method: "POST",
      headers: { ...admin, "content-type": "application/json" },
      body: JSON.stringify({ conversationId: "conv_never_used" })
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { cleared: false, conversationId: "conv_never_used" });
  });
});

test("health advertises the local Analyst without requiring it", async () => {
  await withServer(4291, async base => {
    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.localAnalyst, true);
    assert.equal(health.ok, true);
  });
});

test("the routed dashboard loads the Analyst drawer assets", async () => {
  await withServer(4292, async base => {
    const page = await (await fetch(`${base}/`)).text();
    assert.ok(page.includes('id="analyst-drawer"'), "drawer markup should be present");
    assert.ok(page.includes("/analyst-drawer.js"), "drawer module should be loaded");
    assert.ok(page.includes('id="analyst-toggle"'), "drawer toggle should be present");

    const module = await fetch(`${base}/analyst-drawer.js`);
    assert.equal(module.status, 200);
    assert.match(module.headers.get("content-type") || "", /javascript/);

    const css = await fetchStylesheet(base);
    assert.ok(css.includes(".fl-analyst"), "drawer styles should ship in the design system");
  });
});
