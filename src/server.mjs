import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "./engine/diagnose.mjs";
import { correlateAgentRun } from "./engine/correlate.mjs";
import { incidents } from "./engine/incidents.mjs";
import { bearerToken, generateCredential, hashCredential, isSessionExpired, verifyCredential, verifySessionRole } from "./security/auth.mjs";
import { createDiagnosticSession, publicSession } from "./session/service.mjs";
import { createStore } from "./storage/store.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 3000);
const dataFile = resolve(process.env.FAULTLINE_DATA_FILE || "data/faultline.json");
const store = createStore(dataFile);
const configuredAdminToken = process.env.FAULTLINE_ADMIN_TOKEN || null;
const adminToken = configuredAdminToken || generateCredential("fl_admin");
const adminTokenHash = hashCredential(adminToken);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8"
};

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

function bodyFrom(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function isAdmin(req) {
  return verifyCredential(bearerToken(req), adminTokenHash);
}

function requireAdmin(req) {
  if (!isAdmin(req)) {
    const error = new Error("Admin bearer token required.");
    error.statusCode = 401;
    throw error;
  }
}

async function getSession(id) {
  const session = await store.getSession(id);
  if (!session) {
    const error = new Error(`Diagnostic session ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return session;
}

async function requireSession(req, id, role = null) {
  const session = await getSession(id);
  if (isSessionExpired(session) && !isAdmin(req)) {
    const error = new Error(`Diagnostic session ${id} has expired.`);
    error.statusCode = 410;
    throw error;
  }

  if (isAdmin(req)) return session;
  const token = bearerToken(req);
  const authorised = role
    ? verifySessionRole(session, token, role)
    : verifySessionRole(session, token, "endpoint") || verifySessionRole(session, token, "probe");

  if (!authorised) {
    const error = new Error(role ? `${role} session credential required.` : "Session credential required.");
    error.statusCode = 401;
    throw error;
  }
  return session;
}

function demoIncidents() {
  return incidents.map(incident => ({
    ...incident,
    source: "demo",
    vantages: {
      endpoint: true,
      remoteProbe: typeof incident.metrics.externalProbeHealthy === "boolean"
    },
    diagnosis: diagnose(incident.metrics)
  }));
}

async function createAgentRun(payload, session) {
  if (!payload || typeof payload !== "object" || !payload.metrics || typeof payload.metrics !== "object") {
    throw new Error("Agent run requires a metrics object.");
  }

  const context = payload.incident || {};
  const collectedAt = payload.telemetry?.collectedAt || new Date().toISOString();
  const existing = await store.getRun(session.id);
  const run = {
    id: session.id,
    sessionId: session.id,
    title: session.title || context.title || "Live endpoint diagnostic",
    customer: session.customer || context.customer || "Live endpoint",
    target: session.target.input,
    location: context.location || payload.agent?.hostname || "Windows endpoint",
    connection: context.connection || "Windows endpoint",
    scenario: "live",
    source: "agent",
    collectedAt,
    updatedAt: collectedAt,
    endpointMetrics: { ...payload.metrics },
    metrics: { ...payload.metrics },
    telemetry: payload.telemetry || {},
    agent: payload.agent || null,
    remoteProbe: existing?.remoteProbe || null
  };

  const correlated = correlateAgentRun(run);
  await store.putRun({ ...run, source: correlated.source });
  return correlated;
}

async function attachRemoteProbe(payload, session) {
  if (!payload?.metrics || typeof payload.metrics !== "object") {
    throw new Error("Remote probe payload requires a metrics object.");
  }

  const run = await store.getRun(session.id);
  if (!run?.endpointMetrics) {
    const error = new Error("The endpoint agent must submit evidence before the remote probe can attach.");
    error.statusCode = 409;
    throw error;
  }

  run.remoteProbe = {
    probe: payload.probe || null,
    metrics: payload.metrics,
    telemetry: payload.telemetry || {},
    collectedAt: payload.telemetry?.collectedAt || new Date().toISOString()
  };
  run.updatedAt = run.remoteProbe.collectedAt;
  const correlated = correlateAgentRun(run);
  run.source = correlated.source;
  await store.putRun(run);
  return correlated;
}

async function liveIncidents(limit = 3) {
  return (await store.listRuns(limit)).map(correlateAgentRun);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, { ok: true, version: "0.4.0", persistence: true });
    }

    if (req.method === "GET" && url.pathname === "/api/demo-incidents") {
      return json(res, 200, demoIncidents());
    }

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      requireAdmin(req);
      return json(res, 200, [...await liveIncidents(5), ...demoIncidents()]);
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      requireAdmin(req);
      const payload = await bodyFrom(req);
      const created = createDiagnosticSession(payload);
      await store.putSession(created.session);
      return json(res, 201, {
        session: publicSession(created.session),
        credentials: created.credentials
      });
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      requireAdmin(req);
      const sessions = await store.listSessions();
      return json(res, 200, sessions.map(publicSession));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      const session = await requireSession(req, id);
      const run = await store.getRun(id);
      return json(res, 200, {
        ...publicSession(session),
        vantages: {
          endpoint: Boolean(run?.endpointMetrics),
          remoteProbe: Boolean(run?.remoteProbe)
        }
      });
    }

    if (req.method === "GET" && url.pathname === "/api/agent-runs") {
      requireAdmin(req);
      return json(res, 200, (await store.listRuns()).map(correlateAgentRun));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agent-runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/agent-runs/".length));
      await requireSession(req, id);
      const run = await store.getRun(id);
      if (!run) {
        const error = new Error(`Live run ${id} was not found.`);
        error.statusCode = 404;
        throw error;
      }
      return json(res, 200, correlateAgentRun(run));
    }

    if (req.method === "POST" && url.pathname === "/api/agent-runs") {
      const payload = await bodyFrom(req);
      if (!payload.sessionId) throw new Error("Agent run requires sessionId.");
      const session = await requireSession(req, payload.sessionId, "endpoint");
      return json(res, 201, await createAgentRun(payload, session));
    }

    if (req.method === "POST" && url.pathname === "/api/probe-runs") {
      const payload = await bodyFrom(req);
      if (!payload.sessionId) throw new Error("Remote probe payload requires sessionId.");
      const session = await requireSession(req, payload.sessionId, "probe");
      return json(res, 201, await attachRemoteProbe(payload, session));
    }

    if (req.method === "POST" && url.pathname === "/api/diagnose") {
      const payload = await bodyFrom(req);
      return json(res, 200, diagnose(payload));
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const safePath = normalize(relative).replace(/^(\.\.(\/|\\|$))+/, "");
    const filePath = join(root, safePath);

    if (!filePath.startsWith(root)) return json(res, 403, { error: "Forbidden" });

    try {
      const data = await readFile(filePath);
      res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
      res.end(data);
    } catch {
      const html = await readFile(join(root, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    }
  } catch (error) {
    const status = error.statusCode || (/not found/i.test(error.message) ? 404 : 400);
    json(res, status, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Faultline v0.4 listening on http://localhost:${port}`);
  console.log(`Persistent store: ${dataFile}`);
  if (!configuredAdminToken) {
    console.log("No FAULTLINE_ADMIN_TOKEN was configured. Generated a development admin credential:");
    console.log(adminToken);
    console.log("Set FAULTLINE_ADMIN_TOKEN explicitly before exposing Faultline beyond localhost.");
  }
});
