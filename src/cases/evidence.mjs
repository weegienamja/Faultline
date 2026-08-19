// Canonicalisation and hashing live in the shared evidence module so case
// packages and incident capsules cannot drift apart. The implementation is
// unchanged, so existing package digests still verify.
import { canonical, digest } from "../evidence/integrity.mjs";

const COMPARISON_METRICS = [
  "gatewayLoss",
  "gatewayLatencyMs",
  "upstreamLoss",
  "jitterMs",
  "dnsLookupMs",
  "targetTcpMs",
  "targetHttpMs",
  "contractPassRate",
  "contractFailedRequired"
];

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function runTime(run) {
  return Date.parse(run?.collectedAt || run?.updatedAt || 0) || 0;
}

export function compareDiagnosticRuns(runs = []) {
  const ordered = [...runs].sort((a, b) => runTime(a) - runTime(b));
  if (ordered.length < 2) return null;
  const before = ordered[0];
  const after = ordered.at(-1);
  const metrics = {};

  for (const key of COMPARISON_METRICS) {
    const beforeValue = finite(before.metrics?.[key]);
    const afterValue = finite(after.metrics?.[key]);
    metrics[key] = {
      before: beforeValue,
      after: afterValue,
      delta: beforeValue != null && afterValue != null ? Number((afterValue - beforeValue).toFixed(3)) : null
    };
  }

  const beforeDomain = before.diagnosis?.faultDomain || null;
  const afterDomain = after.diagnosis?.faultDomain || null;
  const beforeContract = before.telemetry?.connectivityContract?.passed ?? before.metrics?.contractPassed ?? null;
  const afterContract = after.telemetry?.connectivityContract?.passed ?? after.metrics?.contractPassed ?? null;

  return {
    before: { sessionId: before.sessionId || before.id, collectedAt: before.collectedAt || before.updatedAt || null },
    after: { sessionId: after.sessionId || after.id, collectedAt: after.collectedAt || after.updatedAt || null },
    metrics,
    diagnosis: {
      before: beforeDomain,
      after: afterDomain,
      changed: beforeDomain !== afterDomain
    },
    connectivityContract: {
      before: beforeContract,
      after: afterContract,
      changed: beforeContract !== afterContract
    }
  };
}

function topologyEvidence(run) {
  const topology = run.telemetry?.topology;
  if (!topology) return null;
  return {
    kind: topology.kind || "unknown",
    confidence: topology.confidence || null,
    summary: topology.summary || null,
    affectedPath: topology.affectedPath || null,
    nodes: clone(topology.nodes || []),
    links: clone(topology.links || [])
  };
}

function observedEvidence(run) {
  return {
    sessionId: run.sessionId || run.id,
    collectedAt: run.collectedAt || run.updatedAt || null,
    endpoint: {
      metrics: clone(run.endpointMetrics || run.metrics || {}),
      agent: clone(run.agent || null),
      network: clone(run.telemetry?.network || null),
      route: clone(run.telemetry?.route || run.telemetry?.traceroute || null),
      connectivityContract: clone(run.telemetry?.connectivityContract || null)
    },
    remoteProbe: clone(run.remoteProbe || null)
  };
}

function deterministicEvidence(run) {
  return {
    sessionId: run.sessionId || run.id,
    diagnosis: clone(run.diagnosis || null),
    contract: run.telemetry?.connectivityContract ? {
      contract: clone(run.telemetry.connectivityContract.contract || null),
      passed: run.telemetry.connectivityContract.passed,
      passRate: run.telemetry.connectivityContract.passRate,
      failedRequired: clone(run.telemetry.connectivityContract.failedRequired || []),
      firstFailureType: run.telemetry.connectivityContract.firstFailureType || null
    } : null
  };
}

function sessionProvenance(session, run) {
  return {
    sessionId: session.id,
    caseId: session.caseId || null,
    target: clone(session.target),
    mode: session.mode || "direct",
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    endpointEvidenceAt: run?.collectedAt || null,
    remoteEvidenceAt: run?.remoteProbe?.collectedAt || null,
    assignedProbeId: session.assignedProbeId || null,
    contract: session.connectivityContract ? {
      id: session.connectivityContract.id,
      version: session.connectivityContract.version,
      name: session.connectivityContract.name
    } : null
  };
}

function shouldRedactKey(key, mode) {
  const normalised = String(key).toLowerCase();
  const networkIdentifiers = ["mac", "bssid", "ssid", "localip", "localaddress", "ipv4", "ipv6", "hostname"];
  const strictExtra = ["publicip", "address", "gateway", "ip", "host"];
  if (networkIdentifiers.some(item => normalised === item || normalised.endsWith(item))) return true;
  return mode === "strict" && strictExtra.some(item => normalised === item || normalised.endsWith(item));
}

function redactValue(value, mode) {
  if (Array.isArray(value)) return value.map(item => redactValue(item, mode));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    shouldRedactKey(key, mode) ? "[redacted]" : redactValue(item, mode)
  ]));
}

export function redactCaseEvidence(packageData, mode = "none") {
  if (!packageData || mode === "none") return clone(packageData);
  if (!["network-identifiers", "strict"].includes(mode)) throw new Error("Unsupported evidence redaction mode.");
  const redacted = redactValue(clone(packageData), mode);
  redacted.redaction = { mode, applied: true };
  redacted.integrity = null;
  redacted.integrity = {
    algorithm: "sha256",
    scope: "redacted-package-without-integrity",
    digest: digest({ ...redacted, integrity: null })
  };
  return redacted;
}

export function buildCaseEvidencePackage(caseRecord, { sessions = [], runs = [], statistical = [] } = {}, now = Date.now()) {
  if (!caseRecord?.id) throw new Error("Support case is required to build an evidence package.");
  const sessionIds = new Set(caseRecord.sessionIds || []);
  const selectedSessions = sessions.filter(session => sessionIds.has(session.id));
  const selectedRuns = runs.filter(run => sessionIds.has(run.sessionId || run.id)).sort((a, b) => runTime(a) - runTime(b));
  const runBySession = new Map(selectedRuns.map(run => [run.sessionId || run.id, run]));

  const packageData = {
    schema: "faultline.case-evidence",
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    case: {
      id: caseRecord.id,
      title: caseRecord.title,
      customer: caseRecord.customer,
      affectedService: caseRecord.affectedService,
      severity: caseRecord.severity,
      status: caseRecord.status,
      tags: clone(caseRecord.tags || []),
      createdAt: caseRecord.createdAt,
      updatedAt: caseRecord.updatedAt,
      resolution: clone(caseRecord.resolution || null),
      notes: clone(caseRecord.notes || [])
    },
    timeline: clone(caseRecord.timeline || []),
    provenance: selectedSessions.map(session => sessionProvenance(session, runBySession.get(session.id))),
    evidence: {
      observed: selectedRuns.map(observedEvidence),
      inferred: selectedRuns.map(run => ({ sessionId: run.sessionId || run.id, topology: topologyEvidence(run) })).filter(item => item.topology),
      deterministic: selectedRuns.map(deterministicEvidence),
      statistical: clone(statistical)
    },
    comparison: compareDiagnosticRuns(selectedRuns),
    redaction: { mode: "none", applied: false },
    integrity: null
  };

  packageData.integrity = {
    algorithm: "sha256",
    scope: "package-without-integrity",
    digest: digest({ ...packageData, integrity: null })
  };
  return packageData;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function pretty(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

function metricRows(comparison) {
  if (!comparison) return "<p>Only one completed diagnostic is available, so no before/after comparison can be calculated.</p>";
  return `<table><thead><tr><th>Metric</th><th>Before</th><th>After</th><th>Δ</th></tr></thead><tbody>${Object.entries(comparison.metrics).map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value.before ?? "n/a")}</td><td>${escapeHtml(value.after ?? "n/a")}</td><td>${escapeHtml(value.delta ?? "n/a")}</td></tr>`).join("")}</tbody></table>`;
}

export function renderEvidenceHtml(packageData) {
  const data = packageData;
  const diagnosisRows = data.evidence.deterministic.map(item => {
    const domain = item.diagnosis?.faultDomain || "inconclusive";
    const confidence = item.diagnosis?.confidence != null ? `${item.diagnosis.confidence}%` : "n/a";
    return `<tr><td>${escapeHtml(item.sessionId)}</td><td>${escapeHtml(domain)}</td><td>${escapeHtml(confidence)}</td><td>${escapeHtml(item.contract?.passed ?? "n/a")}</td></tr>`;
  }).join("");

  const timeline = data.timeline.map(item => `<li><strong>${escapeHtml(item.at)}</strong> · ${escapeHtml(item.type)} · ${escapeHtml(item.summary)} <em>${escapeHtml(item.evidenceKind)}</em></li>`).join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(data.case.id)} · Faultline evidence</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17211e;background:#fff}body{margin:0;padding:36px;line-height:1.45}h1,h2{margin:.2em 0}.muted{color:#60716c}.meta{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:20px 0}.card{border:1px solid #d8e0dd;border-radius:10px;padding:14px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#60716c}table{width:100%;border-collapse:collapse;margin:12px 0 20px}th,td{text-align:left;border-bottom:1px solid #e4e9e7;padding:8px;font-size:12px}pre{white-space:pre-wrap;word-break:break-word;background:#f5f7f6;padding:12px;border-radius:8px;font-size:10px}li{margin:7px 0}em{color:#60716c}@media print{body{padding:12mm}.no-print{display:none}.card{break-inside:avoid}pre{font-size:8px}}
</style></head><body>
<p class="label">Faultline · case evidence package</p>
<h1>${escapeHtml(data.case.title)}</h1><p class="muted">${escapeHtml(data.case.id)} · generated ${escapeHtml(data.generatedAt)}</p>
<div class="meta"><div class="card"><span class="label">Customer</span><br>${escapeHtml(data.case.customer)}</div><div class="card"><span class="label">Service</span><br>${escapeHtml(data.case.affectedService)}</div><div class="card"><span class="label">Severity</span><br>${escapeHtml(data.case.severity)}</div><div class="card"><span class="label">Status</span><br>${escapeHtml(data.case.status)}</div></div>
<h2>Deterministic conclusions</h2><table><thead><tr><th>Diagnostic</th><th>Fault domain</th><th>Confidence</th><th>Contract passed</th></tr></thead><tbody>${diagnosisRows || '<tr><td colspan="4">No completed diagnostic evidence.</td></tr>'}</tbody></table>
<h2>Before / after comparison</h2>${metricRows(data.comparison)}
<h2>Case timeline</h2><ol>${timeline || "<li>No timeline events.</li>"}</ol>
<h2>Evidence provenance</h2><pre>${pretty(data.provenance)}</pre>
<h2>Observed evidence</h2><pre>${pretty(data.evidence.observed)}</pre>
<h2>Inferred evidence</h2><pre>${pretty(data.evidence.inferred)}</pre>
<h2>Statistical evidence</h2><pre>${pretty(data.evidence.statistical)}</pre>
<h2>Integrity</h2><p>SHA-256: <code>${escapeHtml(data.integrity?.digest || "not available")}</code></p>
<p class="muted">Observed measurements, inferred topology, deterministic conclusions and statistical similarity are intentionally kept as separate evidence classes.</p>
</body></html>`;
}
