import { createHash, randomBytes } from "node:crypto";

const METRICS = [
  "gatewayLoss", "gatewayLatencyMs", "upstreamLoss", "jitterMs", "dnsLookupMs",
  "targetTcpMs", "targetHttpMs", "contractPassRate", "contractFailedRequired",
  "tlsHandshakeMs", "targetTtfbMs", "pathMtuBytes"
];

function clone(value) { return value == null ? value : structuredClone(value); }
function finite(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

export function createChangeWindow(input = {}, now = Date.now()) {
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Change window name is required.");
  if (name.length > 160) throw new Error("Change window name must be 160 characters or fewer.");
  const createdAt = new Date(now).toISOString();
  return {
    id: `CHG-${randomBytes(6).toString("hex").toUpperCase()}`,
    name,
    description: String(input.description || "").trim().slice(0, 2000) || null,
    changeType: String(input.changeType || "network-change").trim().slice(0, 80),
    plannedAt: input.plannedAt ? new Date(input.plannedAt).toISOString() : null,
    createdAt,
    updatedAt: createdAt,
    status: "awaiting-baseline",
    baselineSessionId: null,
    postChangeSessionId: null
  };
}

export function setChangeBaseline(window, sessionId, now = Date.now()) {
  if (!window?.id) throw new Error("Change window is required.");
  if (!sessionId) throw new Error("baseline sessionId is required.");
  return { ...clone(window), baselineSessionId: String(sessionId), status: "baselined", updatedAt: new Date(now).toISOString() };
}

export function setChangePostRun(window, sessionId, now = Date.now()) {
  if (!window?.baselineSessionId) throw new Error("A baseline diagnostic must be selected first.");
  if (!sessionId) throw new Error("post-change sessionId is required.");
  if (String(sessionId) === String(window.baselineSessionId)) throw new Error("Post-change diagnostic must differ from the baseline.");
  return { ...clone(window), postChangeSessionId: String(sessionId), status: "compared", updatedAt: new Date(now).toISOString() };
}

function contractChecks(run) {
  const result = run?.telemetry?.connectivityContract;
  const checks = result?.results || result?.checks || [];
  return new Map((Array.isArray(checks) ? checks : []).map(check => [check.id || check.type, Boolean(check.passed ?? check.ok)]));
}

function routeSequence(run) {
  const route = run?.telemetry?.route || run?.telemetry?.traceroute || [];
  return (Array.isArray(route) ? route : []).map(item => item?.ip || item?.address || null).filter(Boolean);
}

function topologySignature(run) {
  const topology = run?.telemetry?.topology;
  if (!topology) return { nodes: [], links: [] };
  return {
    nodes: (topology.nodes || []).map(node => node.id || node.ip || node.label).filter(Boolean).sort(),
    links: (topology.links || []).map(link => `${link.source || link.from}->${link.target || link.to}`).sort()
  };
}

function metricComparison(before, after) {
  return Object.fromEntries(METRICS.map(key => {
    const a = finite(before?.metrics?.[key]);
    const b = finite(after?.metrics?.[key]);
    return [key, { before: a, after: b, delta: a != null && b != null ? Number((b - a).toFixed(3)) : null }];
  }));
}

function booleanTransition(before, after, key) {
  const a = typeof before?.metrics?.[key] === "boolean" ? before.metrics[key] : null;
  const b = typeof after?.metrics?.[key] === "boolean" ? after.metrics[key] : null;
  return { before: a, after: b, changed: a !== b };
}

function classify(metric, value) {
  const delta = value?.delta;
  if (delta == null) return null;
  if (["gatewayLoss", "upstreamLoss", "jitterMs", "dnsLookupMs", "targetTcpMs", "targetHttpMs", "tlsHandshakeMs", "targetTtfbMs", "contractFailedRequired"].includes(metric)) {
    if (delta > 0) return "regression";
    if (delta < 0) return "improvement";
  }
  if (metric === "contractPassRate" || metric === "pathMtuBytes") {
    if (delta < 0) return "regression";
    if (delta > 0) return "improvement";
  }
  return null;
}

export function compareChangeRuns(before, after) {
  if (!before || !after) throw new Error("Both baseline and post-change runs are required.");
  const metrics = metricComparison(before, after);
  const beforeChecks = contractChecks(before);
  const afterChecks = contractChecks(after);
  const checkIds = [...new Set([...beforeChecks.keys(), ...afterChecks.keys()])].sort();
  const contractChecksDiff = checkIds.map(id => ({ id, before: beforeChecks.get(id) ?? null, after: afterChecks.get(id) ?? null, changed: beforeChecks.get(id) !== afterChecks.get(id) }));
  const beforeRoute = routeSequence(before);
  const afterRoute = routeSequence(after);
  const beforeTopology = topologySignature(before);
  const afterTopology = topologySignature(after);
  const family = {
    ipv4Reachable: booleanTransition(before, after, "ipv4Reachable"),
    ipv6Reachable: booleanTransition(before, after, "ipv6Reachable"),
    tlsHandshakeOk: booleanTransition(before, after, "tlsHandshakeOk"),
    contractPassed: booleanTransition(before, after, "contractPassed")
  };

  const regressions = [];
  const improvements = [];
  for (const [key, value] of Object.entries(metrics)) {
    const classification = classify(key, value);
    if (classification === "regression") regressions.push({ type: "metric", key, ...value });
    if (classification === "improvement") improvements.push({ type: "metric", key, ...value });
  }
  for (const [key, transition] of Object.entries(family)) {
    if (transition.before === true && transition.after === false) regressions.push({ type: "state", key, ...transition });
    if (transition.before === false && transition.after === true) improvements.push({ type: "state", key, ...transition });
  }
  for (const check of contractChecksDiff) {
    if (check.before === true && check.after === false) regressions.push({ type: "contract-check", key: check.id, before: true, after: false });
    if (check.before === false && check.after === true) improvements.push({ type: "contract-check", key: check.id, before: false, after: true });
  }

  return {
    baseline: { sessionId: before.sessionId || before.id, collectedAt: before.collectedAt || before.updatedAt || null },
    postChange: { sessionId: after.sessionId || after.id, collectedAt: after.collectedAt || after.updatedAt || null },
    metrics,
    states: family,
    connectivityContract: { checks: contractChecksDiff },
    route: { before: beforeRoute, after: afterRoute, changed: JSON.stringify(beforeRoute) !== JSON.stringify(afterRoute) },
    topology: {
      before: beforeTopology,
      after: afterTopology,
      changed: JSON.stringify(beforeTopology) !== JSON.stringify(afterTopology)
    },
    regressions,
    improvements,
    outcome: regressions.length ? "regression-detected" : "no-regression-detected"
  };
}

export function buildChangeAssurancePackage(changeWindow, before, after, caseRecord, now = Date.now()) {
  const comparison = compareChangeRuns(before, after);
  const packageData = {
    schema: "faultline.change-assurance",
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    case: { id: caseRecord?.id || null, title: caseRecord?.title || null, customer: caseRecord?.customer || null },
    change: clone(changeWindow),
    comparison,
    integrity: null
  };
  packageData.integrity = { algorithm: "sha256", scope: "package-without-integrity", digest: digest({ ...packageData, integrity: null }) };
  return packageData;
}
