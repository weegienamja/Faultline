import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "./engine/diagnose.mjs";
import { correlateAgentRun } from "./engine/correlate.mjs";
import { incidents } from "./engine/incidents.mjs";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 3000);
const agentRuns = [];

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
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
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

function createAgentRun(payload) {
  if (!payload || typeof payload !== "object" || !payload.metrics || typeof payload.metrics !== "object") {
    throw new Error("Agent run requires a metrics object.");
  }

  const context = payload.incident || {};
  const collectedAt = payload.telemetry?.collectedAt || new Date().toISOString();
  const run = {
    id: context.id || `LIVE-${Date.now().toString(36).toUpperCase()}`,
    title: context.title || "Live endpoint diagnostic",
    customer: context.customer || "Live endpoint",
    target: context.target || payload.telemetry?.target?.input || "Unknown target",
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
    remoteProbe: null
  };

  agentRuns.unshift(run);
  if (agentRuns.length > 10) agentRuns.length = 10;
  return correlateAgentRun(run);
}

function getAgentRun(id) {
  const run = agentRuns.find(item => item.id === id);
  if (!run) throw new Error(`Live run ${id} was not found.`);
  return run;
}

function attachRemoteProbe(payload) {
  if (!payload?.runId) throw new Error("Remote probe payload requires runId.");
  if (!payload.metrics || typeof payload.metrics !== "object") throw new Error("Remote probe payload requires a metrics object.");

  const run = getAgentRun(payload.runId);
  run.remoteProbe = {
    probe: payload.probe || null,
    metrics: payload.metrics,
    telemetry: payload.telemetry || {},
    collectedAt: payload.telemetry?.collectedAt || new Date().toISOString()
  };
  run.updatedAt = run.remoteProbe.collectedAt;
  return correlateAgentRun(run);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      return json(res, 200, [...agentRuns.slice(0, 3).map(correlateAgentRun), ...demoIncidents()]);
    }

    if (req.method === "GET" && url.pathname === "/api/agent-runs") {
      return json(res, 200, agentRuns.map(correlateAgentRun));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/agent-runs/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/agent-runs/".length));
      return json(res, 200, correlateAgentRun(getAgentRun(id)));
    }

    if (req.method === "POST" && url.pathname === "/api/agent-runs") {
      const payload = await bodyFrom(req);
      return json(res, 201, createAgentRun(payload));
    }

    if (req.method === "GET" && url.pathname === "/api/probe-runs") {
      return json(res, 200, agentRuns.filter(run => run.remoteProbe).map(run => ({
        runId: run.id,
        ...run.remoteProbe
      })));
    }

    if (req.method === "POST" && url.pathname === "/api/probe-runs") {
      const payload = await bodyFrom(req);
      return json(res, 201, attachRemoteProbe(payload));
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
    const status = /not found/i.test(error.message) ? 404 : 400;
    json(res, status, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`Faultline listening on http://localhost:${port}`);
});
