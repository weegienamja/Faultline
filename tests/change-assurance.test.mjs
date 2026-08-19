import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChangeAssurancePackage,
  compareChangeRuns,
  createChangeWindow,
  setChangeBaseline,
  setChangePostRun
} from "../src/change/service.mjs";

function run(id, overrides = {}) {
  return {
    id,
    sessionId: id,
    collectedAt: id === "FL-BEFORE" ? "2026-01-01T10:00:00.000Z" : "2026-01-01T11:00:00.000Z",
    metrics: {
      gatewayLoss: 0,
      gatewayLatencyMs: 3,
      upstreamLoss: 0.5,
      jitterMs: 5,
      dnsLookupMs: 20,
      targetTcpMs: 30,
      targetHttpMs: 80,
      contractPassRate: 100,
      contractFailedRequired: 0,
      ipv4Reachable: true,
      ipv6Reachable: true,
      tlsHandshakeOk: true,
      tlsHandshakeMs: 35,
      targetTtfbMs: 70,
      pathMtuBytes: 1500,
      contractPassed: true,
      ...overrides.metrics
    },
    telemetry: {
      route: [{ ip: "10.0.0.1" }, { ip: "203.0.113.1" }],
      topology: { nodes: [{ id: "endpoint" }, { id: "gateway" }], links: [{ source: "endpoint", target: "gateway" }] },
      connectivityContract: { results: [{ id: "dns", passed: true }, { id: "tcp", passed: true }, { id: "tls", passed: true }, { id: "http", passed: true }] },
      ...overrides.telemetry
    }
  };
}

test("creates a baseline-first change workflow", () => {
  const change = createChangeWindow({ name: "Firewall policy rollout", changeType: "firewall" }, 0);
  assert.equal(change.status, "awaiting-baseline");
  const baselined = setChangeBaseline(change, "FL-BEFORE", 1000);
  assert.equal(baselined.status, "baselined");
  const compared = setChangePostRun(baselined, "FL-AFTER", 2000);
  assert.equal(compared.status, "compared");
  assert.equal(compared.postChangeSessionId, "FL-AFTER");
});

test("detects regressions in required network behaviour", () => {
  const before = run("FL-BEFORE");
  const after = run("FL-AFTER", {
    metrics: { upstreamLoss: 8.5, jitterMs: 58, ipv6Reachable: false, tlsHandshakeOk: false, contractPassRate: 50, contractFailedRequired: 2, contractPassed: false, pathMtuBytes: 1400 },
    telemetry: {
      route: [{ ip: "10.0.0.1" }, { ip: "198.51.100.8" }],
      connectivityContract: { results: [{ id: "dns", passed: true }, { id: "tcp", passed: true }, { id: "tls", passed: false }, { id: "http", passed: false }] }
    }
  });
  const comparison = compareChangeRuns(before, after);
  assert.equal(comparison.outcome, "regression-detected");
  assert.equal(comparison.route.changed, true);
  assert.ok(comparison.regressions.some(item => item.key === "ipv6Reachable"));
  assert.ok(comparison.regressions.some(item => item.type === "contract-check" && item.key === "tls"));
  assert.ok(comparison.regressions.some(item => item.key === "pathMtuBytes"));
});

test("reports improvements without fabricating a regression", () => {
  const before = run("FL-BEFORE", { metrics: { upstreamLoss: 9, jitterMs: 50, targetTtfbMs: 400 } });
  const after = run("FL-AFTER", { metrics: { upstreamLoss: 0.2, jitterMs: 4, targetTtfbMs: 70 } });
  const comparison = compareChangeRuns(before, after);
  assert.equal(comparison.outcome, "no-regression-detected");
  assert.ok(comparison.improvements.some(item => item.key === "upstreamLoss"));
});

test("builds an integrity-tagged change assurance package", () => {
  const change = setChangePostRun(setChangeBaseline(createChangeWindow({ name: "DNS migration" }), "FL-BEFORE"), "FL-AFTER");
  const packageData = buildChangeAssurancePackage(change, run("FL-BEFORE"), run("FL-AFTER"), { id: "CASE-1", title: "DNS change", customer: "Example" }, 0);
  assert.equal(packageData.schema, "faultline.change-assurance");
  assert.equal(packageData.generatedAt, "1970-01-01T00:00:00.000Z");
  assert.match(packageData.integrity.digest, /^[a-f0-9]{64}$/);
});

test("rejects using the baseline as the post-change run", () => {
  const change = setChangeBaseline(createChangeWindow({ name: "VPN update" }), "FL-1");
  assert.throws(() => setChangePostRun(change, "FL-1"), /must differ/);
});
