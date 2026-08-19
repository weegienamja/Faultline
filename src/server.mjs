import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnose } from "./engine/diagnose.mjs";
import { correlateAgentRun } from "./engine/correlate.mjs";
import { incidents } from "./engine/incidents.mjs";
import { bearerToken, generateCredential, hashCredential, isSessionExpired, verifyCredential, verifySessionRole } from "./security/auth.mjs";
import { assertLiteralTargetAllowed } from "./security/target.mjs";
import { claimDiagnosticInvitation, createDiagnosticSession, exchangeClientLaunch, findSessionByInvitationToken, normaliseSessionInput, publicSession } from "./session/service.mjs";
import {
  createRegisteredProbe,
  publicProbe,
  revokeProbeCredential,
  rotateProbeCredential,
  touchProbe,
  updateProbeLifecycle,
  verifyProbeCredential
} from "./probe/registry.mjs";
import { normaliseProbeSelector, selectProbe } from "./probe/scheduler.mjs";
import { createStore } from "./storage/store.mjs";
import { createPlatformRouter } from "./platform/routes.mjs";
import { createLiveRouter } from "./live/routes.mjs";
import { createBisectRouter } from "./bisect/routes.mjs";

const PRODUCT_VERSION = "v1.5";
const PRODUCT_MILESTONE = "Network change assurance + live Internet data";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = Number(process.env.PORT || 3000);
const dataFile = resolve(process.env.FAULTLINE_DATA_FILE || "data/faultline.json");
const store = createStore(dataFile);
const configuredAdminToken = process.env.FAULTLINE_ADMIN_TOKEN || null;
const adminToken = configuredAdminToken || generateCredential("fl_admin");
const adminTokenHash = hashCredential(adminToken);
const windowsClientUrl = process.env.FAULTLINE_WINDOWS_CLIENT_URL || null;
const probeSubmissionLimits = new Map();

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
    let oversize = false;
    req.on("data", chunk => {
      if (oversize) return;
      body += chunk;
      if (body.length > 1_000_000) {
        oversize = true;
        body = "";
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (oversize) return;
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

function consumeRateLimit(key, max = 30, windowMs = 60_000) {
  const now = Date.now();
  const current = probeSubmissionLimits.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    probeSubmissionLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= max) {
    const error = new Error("Probe submission rate limit exceeded.");
    error.statusCode = 429;
    throw error;
  }
  current.count += 1;
}

async function appendAudit(type, probeId, details = {}) {
  return store.appendAudit({
    at: new Date().toISOString(),
    type,
    probeId: probeId || null,
    details
  });
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

async function getProbe(id) {
  const probe = await store.getProbe(id);
  if (!probe) {
    const error = new Error(`Registered probe ${id} was not found.`);
    error.statusCode = 404;
    throw error;
  }
  return probe;
}

function ensureProbeAssignable(probe) {
  if (probe.enabled === false || probe.revokedAt) {
    const error = new Error(`Registered probe ${probe.id} is disabled or revoked.`);
    error.statusCode = 409;
    throw error;
  }
  if (probe.draining || probe.maintenance) {
    const error = new Error(`Registered probe ${probe.id} is not accepting new work.`);
    error.statusCode = 409;
    throw error;
  }
}

async function requireRegisteredProbe(req, id) {
  const probe = await getProbe(id);
  if (isAdmin(req)) return probe;
  if (!verifyProbeCredential(probe, bearerToken(req))) {
    const error = new Error("Registered probe credential required.");
    error.statusCode = 401;
    throw error;
  }
  return probe;
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

async function requireInvitation(req) {
  const token = bearerToken(req);
  if (!token) {
    const error = new Error("Diagnostic invitation credential required.");
    error.statusCode = 401;
    throw error;
  }

  const session = findSessionByInvitationToken(await store.listSessions(), token);
  if (!session) {
    const error = new Error("Diagnostic invitation is invalid.");
    error.statusCode = 404;
    throw error;
  }

  if (isSessionExpired(session)) {
    const error = new Error("Diagnostic invitation has expired.");
    error.statusCode = 410;
    throw error;
  }

  return { session, token };
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
    caseId: session.caseId || null,
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
    remoteProbe: existing?.remoteProbe || null,
    assignedProbeId: session.assignedProbeId || null
  };

  const correlated = correlateAgentRun(run);
  await store.putRun({ ...run, source: correlated.source });
  await platform.recordSessionEvidence(session, "diagnostic.endpoint_evidence", {
    summary: `Endpoint evidence received for ${session.id}.`,
    evidenceKind: "observed"
  });
  return correlated;
}

async function attachRemoteProbe(payload, session, registeredProbe = null) {
  if (!payload?.metrics || typeof payload.metrics !== "object") {
    throw new Error("Remote probe payload requires a metrics object.");
  }

  const run = await store.getRun(session.id);
  if (!run?.endpointMetrics) {
    const error = new Error("The endpoint agent must submit evidence before the remote probe can attach.");
    error.statusCode = 409;
    throw error;
  }

  const probeIdentity = registeredProbe
    ? {
        id: registeredProbe.id,
        name: registeredProbe.name,
        location: registeredProbe.location || null,
        country: registeredProbe.country || null,
        region: registeredProbe.region || null,
        scope: registeredProbe.scope || "public",
        tags: registeredProbe.tags || [],
        runtime: registeredProbe.runtime || null,
        registered: true
      }
    : payload.probe || null;

  run.remoteProbe = {
    probe: probeIdentity,
    metrics: payload.metrics,
    telemetry: payload.telemetry || {},
    collectedAt: payload.telemetry?.collectedAt || new Date().toISOString()
  };
  run.updatedAt = run.remoteProbe.collectedAt;
  const correlated = correlateAgentRun(run);
  run.source = correlated.source;
  await store.putRun(run);
  await platform.recordSessionEvidence(session, "diagnostic.remote_evidence", {
    summary: `Independent remote-vantage evidence received for ${session.id}.`,
    evidenceKind: "observed",
    metadata: { probeId: registeredProbe?.id || payload.probe?.id || null }
  });
  return correlated;
}

async function liveIncidents(limit = 3) {
  return (await store.listRuns(limit)).map(correlateAgentRun);
}

async function pendingProbeJobs(probeId) {
  const probe = await getProbe(probeId);
  if (probe.maintenance || probe.revokedAt || probe.enabled === false) return [];
  const sessions = await store.listSessions();
  const jobs = [];

  for (const session of sessions) {
    if (session.assignedProbeId !== probeId || isSessionExpired(session)) continue;
    const run = await store.getRun(session.id);
    if (!run?.endpointMetrics || run.remoteProbe) continue;
    try {
      assertLiteralTargetAllowed(session.target.input, session.target.port, probe.scope || "public");
    } catch {
      continue;
    }
    jobs.push({ id: session.id, target: session.target, expiresAt: session.expiresAt });
  }

  return jobs.slice(0, 20);
}

async function resolveProbeAssignment(payload) {
  const normalised = normaliseSessionInput(payload);

  if (payload.assignedProbeId) {
    const probe = await getProbe(String(payload.assignedProbeId));
    ensureProbeAssignable(probe);
    assertLiteralTargetAllowed(normalised.target.input, normalised.target.port, probe.scope || "public");
    return {
      assignedProbeId: probe.id,
      probeSelection: {
        mode: "explicit",
        selector: null,
        selectedAt: new Date().toISOString(),
        candidateCount: 1,
        loadAtSelection: 0
      }
    };
  }

  if (!payload.probeSelector) return { assignedProbeId: null, probeSelection: null };

  const selector = normaliseProbeSelector(payload.probeSelector);
  const selected = selectProbe({
    probes: await store.listProbes(),
    sessions: await store.listSessions(),
    runs: await store.listRuns(1000),
    selector
  });
  assertLiteralTargetAllowed(normalised.target.input, normalised.target.port, selected.probe.scope || "public");

  return {
    assignedProbeId: selected.probe.id,
    probeSelection: {
      mode: "automatic",
      selector: selected.selector,
      selectedAt: new Date().toISOString(),
      candidateCount: selected.candidateCount,
      loadAtSelection: selected.load
    }
  };
}

async function createSessionFromPayload(payload) {
  const assignment = await resolveProbeAssignment(payload);
  const created = createDiagnosticSession({ ...payload, ...assignment });
  await store.putSession(created.session);
  if (created.session.assignedProbeId) {
    await appendAudit("probe.session_assigned", created.session.assignedProbeId, {
      sessionId: created.session.id,
      mode: created.session.probeSelection?.mode || "explicit"
    });
  }
  return created;
}

const platform = createPlatformRouter({
  store,
  requireAdmin,
  bodyFrom,
  json,
  createSession: createSessionFromPayload,
  publicSession
});

const handleLive = createLiveRouter({ requireAdmin, bodyFrom, json, store, publicProbe });
const handleBisect = createBisectRouter({ requireAdmin, bodyFrom, json });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (await platform.handle(req, res, url)) return;
    if (await handleLive(req, res, url)) return;
    if (await handleBisect(req, res, url)) return;

    if (req.method === "GET" && url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        version: `${PRODUCT_VERSION}-preview`,
        milestone: PRODUCT_MILESTONE,
        persistence: true,
        registeredProbeFleet: true,
        probeScheduling: true,
        publicProbeSafety: true,
        topologyPreview: true,
        ephemeralInvitations: true,
        windowsClientPreview: true,
        caseWorkspaces: true,
        evidencePackages: true,
        crossPartyRooms: true,
        multiTenancy: true,
        contractCatalog: true,
        embeddedDiagnosticsApi: true,
        serviceDeskIntegrations: true,
        deepDiagnostics: true,
        changeAssurance: true,
        liveInternetData: true,
        networkBisect: true
      });
    }

    if (req.method === "GET" && url.pathname === "/api/demo-incidents") {
      return json(res, 200, demoIncidents());
    }

    if (req.method === "GET" && url.pathname === "/api/incidents") {
      requireAdmin(req);
      return json(res, 200, [...await liveIncidents(5), ...demoIncidents()]);
    }

    if (req.method === "POST" && url.pathname === "/api/probes") {
      requireAdmin(req);
      const payload = await bodyFrom(req);
      const created = createRegisteredProbe(payload);
      await store.putProbe(created.probe);
      await appendAudit("probe.registered", created.probe.id, {
        scope: created.probe.scope,
        country: created.probe.country,
        region: created.probe.region,
        tags: created.probe.tags
      });
      return json(res, 201, { probe: publicProbe(created.probe), credential: created.credential });
    }

    if (req.method === "GET" && url.pathname === "/api/probes") {
      requireAdmin(req);
      const probes = await store.listProbes();
      return json(res, 200, probes.map(probe => publicProbe(probe)));
    }

    if (req.method === "GET" && url.pathname === "/api/audit") {
      requireAdmin(req);
      return json(res, 200, await store.listAudit(200));
    }

    const heartbeatMatch = url.pathname.match(/^\/api\/probes\/([^/]+)\/heartbeat$/);
    if (req.method === "POST" && heartbeatMatch) {
      const id = decodeURIComponent(heartbeatMatch[1]);
      const probe = await requireRegisteredProbe(req, id);
      const payload = await bodyFrom(req);
      const updated = touchProbe(probe, payload);
      await store.putProbe(updated);
      return json(res, 200, publicProbe(updated));
    }

    const jobsMatch = url.pathname.match(/^\/api\/probes\/([^/]+)\/jobs$/);
    if (req.method === "GET" && jobsMatch) {
      const id = decodeURIComponent(jobsMatch[1]);
      const probe = await requireRegisteredProbe(req, id);
      const updated = touchProbe(probe);
      await store.putProbe(updated);
      return json(res, 200, { probe: publicProbe(updated), jobs: await pendingProbeJobs(id) });
    }

    const rotateMatch = url.pathname.match(/^\/api\/probes\/([^/]+)\/rotate$/);
    if (req.method === "POST" && rotateMatch) {
      requireAdmin(req);
      const id = decodeURIComponent(rotateMatch[1]);
      const probe = await getProbe(id);
      const rotated = rotateProbeCredential(probe);
      await store.putProbe(rotated.probe);
      await appendAudit("probe.credential_rotated", id, { credentialVersion: rotated.probe.credentialVersion });
      return json(res, 200, { probe: publicProbe(rotated.probe), credential: rotated.credential });
    }

    const revokeMatch = url.pathname.match(/^\/api\/probes\/([^/]+)\/revoke$/);
    if (req.method === "POST" && revokeMatch) {
      requireAdmin(req);
      const id = decodeURIComponent(revokeMatch[1]);
      const probe = await getProbe(id);
      const revoked = revokeProbeCredential(probe);
      await store.putProbe(revoked);
      await appendAudit("probe.revoked", id);
      return json(res, 200, publicProbe(revoked));
    }

    const probeMatch = url.pathname.match(/^\/api\/probes\/([^/]+)$/);
    if (req.method === "PATCH" && probeMatch) {
      requireAdmin(req);
      const id = decodeURIComponent(probeMatch[1]);
      const probe = await getProbe(id);
      const payload = await bodyFrom(req);
      const updated = updateProbeLifecycle(probe, payload);
      await store.putProbe(updated);
      await appendAudit("probe.lifecycle_updated", id, {
        enabled: updated.enabled,
        draining: updated.draining,
        maintenance: updated.maintenance,
        scope: updated.scope,
        country: updated.country,
        region: updated.region,
        tags: updated.tags
      });
      return json(res, 200, publicProbe(updated));
    }

    if (req.method === "GET" && probeMatch) {
      const id = decodeURIComponent(probeMatch[1]);
      const probe = await requireRegisteredProbe(req, id);
      return json(res, 200, publicProbe(probe));
    }

    if (req.method === "GET" && url.pathname === "/api/invitations") {
      const { session } = await requireInvitation(req);
      return json(res, 200, {
        session: publicSession(session),
        collection: {
          topology: true,
          packetPayloads: false,
          browserHistory: false,
          applicationContent: false
        },
        client: { windowsDownloadUrl: windowsClientUrl }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/invitations/claim") {
      const { session, token } = await requireInvitation(req);
      const payload = await bodyFrom(req);
      const claimed = claimDiagnosticInvitation(session, token, {
        consent: payload.consent === true,
        includeTopology: payload.includeTopology !== false
      });
      await store.putSession(claimed.session);
      return json(res, 200, {
        session: publicSession(claimed.session),
        client: {
          launchToken: claimed.clientLaunchToken,
          windowsDownloadUrl: windowsClientUrl
        }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/client/exchange") {
      const payload = await bodyFrom(req);
      if (!payload.sessionId) throw new Error("Windows client exchange requires sessionId.");
      const session = await getSession(String(payload.sessionId));
      const exchanged = exchangeClientLaunch(session, bearerToken(req));
      await store.putSession(exchanged.session);
      return json(res, 200, {
        session: publicSession(exchanged.session),
        credentials: { endpointToken: exchanged.endpointToken },
        client: { includeTopology: exchanged.includeTopology }
      });
    }

    if (req.method === "POST" && url.pathname === "/api/sessions") {
      requireAdmin(req);
      const payload = await bodyFrom(req);
      const created = await createSessionFromPayload(payload);
      return json(res, 201, {
        session: publicSession(created.session),
        credentials: created.credentials,
        invitation: created.credentials.invitationToken ? {
          path: `/diagnose#invite=${encodeURIComponent(created.credentials.invitationToken)}`
        } : null
      });
    }

    if (req.method === "GET" && url.pathname === "/api/sessions") {
      requireAdmin(req);
      const sessions = await store.listSessions();
      return json(res, 200, sessions.map(session => publicSession(session)));
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      const session = await requireSession(req, id);
      const run = await store.getRun(id);
      return json(res, 200, {
        ...publicSession(session),
        vantages: { endpoint: Boolean(run?.endpointMetrics), remoteProbe: Boolean(run?.remoteProbe) }
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
      const session = await getSession(payload.sessionId);
      if (isSessionExpired(session) && !isAdmin(req)) {
        const error = new Error(`Diagnostic session ${session.id} has expired.`);
        error.statusCode = 410;
        throw error;
      }

      if (session.assignedProbeId) {
        if (payload.probeId && payload.probeId !== session.assignedProbeId) {
          const error = new Error("Probe payload does not match the probe assigned to this session.");
          error.statusCode = 403;
          throw error;
        }
        const probe = await requireRegisteredProbe(req, session.assignedProbeId);
        consumeRateLimit(`probe:${probe.id}`);
        assertLiteralTargetAllowed(session.target.input, session.target.port, probe.scope || "public");
        const updatedProbe = touchProbe(probe, { runtime: payload.probe?.runtime || payload.probe || null });
        await store.putProbe(updatedProbe);
        return json(res, 201, await attachRemoteProbe(payload, session, updatedProbe));
      }

      const authorisedSession = await requireSession(req, payload.sessionId, "probe");
      return json(res, 201, await attachRemoteProbe(payload, authorisedSession));
    }

    if (req.method === "POST" && url.pathname === "/api/diagnose") {
      const payload = await bodyFrom(req);
      return json(res, 200, diagnose(payload));
    }

    // Unmatched API paths must not fall through to the SPA HTML fallback.
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return json(res, 404, { error: `No Faultline API route matches ${req.method} ${url.pathname}.` });
    }

    const relative = url.pathname === "/"
      ? "index.html"
      : url.pathname === "/diagnose" || url.pathname === "/diagnose/"
        ? "diagnose.html"
        : url.pathname.replace(/^\/+/, "");
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
    json(res, status, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
});

server.listen(port, () => {
  console.log(`Faultline ${PRODUCT_VERSION} preview listening on http://localhost:${port}`);
  console.log(`Current product milestone: ${PRODUCT_VERSION} preview · ${PRODUCT_MILESTONE}`);
  console.log(`Persistent store: ${dataFile}`);
  if (!configuredAdminToken) {
    console.log("No FAULTLINE_ADMIN_TOKEN was configured. Generated a development admin credential:");
    console.log(adminToken);
    console.log("Set FAULTLINE_ADMIN_TOKEN explicitly before exposing Faultline beyond localhost.");
  }
});
