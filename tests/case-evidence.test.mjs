import test from "node:test";
import assert from "node:assert/strict";
import { buildCaseEvidencePackage, compareDiagnosticRuns, redactCaseEvidence, renderEvidenceHtml } from "../src/cases/evidence.mjs";

const caseRecord = {
  id: "CASE-TEST",
  title: "Voice degradation",
  customer: "Northstar",
  affectedService: "Voice",
  severity: "high",
  status: "investigating",
  tags: ["voice"],
  sessionIds: ["FL-BEFORE", "FL-AFTER"],
  notes: [],
  timeline: [{ id: "EVT-1", at: "2026-08-19T00:00:00.000Z", type: "case.created", summary: "Created", evidenceKind: "observed" }],
  resolution: null,
  createdAt: "2026-08-19T00:00:00.000Z",
  updatedAt: "2026-08-19T00:10:00.000Z"
};

const sessions = [
  { id: "FL-BEFORE", caseId: "CASE-TEST", target: { input: "voice.example", port: 443 }, mode: "ephemeral", createdAt: "2026-08-19T00:01:00.000Z", expiresAt: "2026-08-19T01:01:00.000Z" },
  { id: "FL-AFTER", caseId: "CASE-TEST", target: { input: "voice.example", port: 443 }, mode: "ephemeral", createdAt: "2026-08-19T00:06:00.000Z", expiresAt: "2026-08-19T01:06:00.000Z" }
];

const runs = [
  {
    id: "FL-BEFORE", sessionId: "FL-BEFORE", collectedAt: "2026-08-19T00:03:00.000Z",
    metrics: { gatewayLoss: 0, upstreamLoss: 12, jitterMs: 72, contractPassRate: 50, contractPassed: false },
    endpointMetrics: { gatewayLoss: 0, localIp: "192.168.1.50", adapterMac: "AA:BB:CC:DD:EE:FF" },
    telemetry: { topology: { kind: "star", confidence: "high", nodes: [], links: [] } },
    diagnosis: { faultDomain: "upstream", confidence: 91 }
  },
  {
    id: "FL-AFTER", sessionId: "FL-AFTER", collectedAt: "2026-08-19T00:08:00.000Z",
    metrics: { gatewayLoss: 0, upstreamLoss: 0.2, jitterMs: 6, contractPassRate: 100, contractPassed: true },
    endpointMetrics: { gatewayLoss: 0, localIp: "192.168.1.50", adapterMac: "AA:BB:CC:DD:EE:FF" },
    telemetry: {},
    diagnosis: { faultDomain: "healthy", confidence: 94 }
  }
];

test("compares earliest and latest diagnostic evidence", () => {
  const comparison = compareDiagnosticRuns(runs);
  assert.equal(comparison.metrics.upstreamLoss.delta, -11.8);
  assert.equal(comparison.diagnosis.before, "upstream");
  assert.equal(comparison.diagnosis.after, "healthy");
  assert.equal(comparison.connectivityContract.changed, true);
});

test("builds an integrity-tagged package with separated evidence classes", () => {
  const bundle = buildCaseEvidencePackage(caseRecord, { sessions, runs }, Date.parse("2026-08-19T00:12:00.000Z"));
  assert.equal(bundle.schema, "faultline.case-evidence");
  assert.equal(bundle.evidence.observed.length, 2);
  assert.equal(bundle.evidence.inferred.length, 1);
  assert.equal(bundle.evidence.deterministic.length, 2);
  assert.match(bundle.integrity.digest, /^[a-f0-9]{64}$/);
  assert.equal(bundle.comparison.diagnosis.changed, true);
});

test("redacts endpoint identifiers and re-digests the exported package", () => {
  const bundle = buildCaseEvidencePackage(caseRecord, { sessions, runs });
  const redacted = redactCaseEvidence(bundle, "network-identifiers");
  const text = JSON.stringify(redacted);
  assert.equal(redacted.redaction.mode, "network-identifiers");
  assert.doesNotMatch(text, /192\.168\.1\.50/);
  assert.doesNotMatch(text, /AA:BB:CC:DD:EE:FF/);
  assert.match(redacted.integrity.digest, /^[a-f0-9]{64}$/);
});

test("renders a print-friendly evidence report", () => {
  const bundle = buildCaseEvidencePackage(caseRecord, { sessions, runs });
  const html = renderEvidenceHtml(bundle);
  assert.match(html, /Faultline · case evidence package/);
  assert.match(html, /CASE-TEST/);
  assert.match(html, /Before \/ after comparison/);
  assert.match(html, /SHA-256/);
});
