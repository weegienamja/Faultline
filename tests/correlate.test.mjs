import test from "node:test";
import assert from "node:assert/strict";
import { correlateAgentRun, mergeProbeEvidence } from "../src/engine/correlate.mjs";

const endpointMetrics = {
  gatewayLoss: 0,
  gatewayLatencyMs: 3,
  dnsResolved: true,
  directIpReachable: false,
  internetReachable: true,
  vpnRequired: false,
  upstreamLoss: 0,
  jitterMs: 5,
  targetReachable: false
};

test("leaves external probe evidence absent before a remote run arrives", () => {
  const merged = mergeProbeEvidence(endpointMetrics, null);
  assert.equal("externalProbeHealthy" in merged, false);
});

test("maps remote probe reachability into the diagnosis contract", () => {
  const merged = mergeProbeEvidence(endpointMetrics, {
    metrics: { targetReachable: true, targetTcpMs: 31.2 }
  });
  assert.equal(merged.externalProbeHealthy, true);
  assert.equal(merged.externalProbeLatencyMs, 31.2);
});

test("correlated run becomes two-vantage and changes diagnosis", () => {
  const result = correlateAgentRun({
    id: "LIVE-TEST",
    endpointMetrics,
    metrics: endpointMetrics,
    remoteProbe: {
      metrics: { targetReachable: true, targetTcpMs: 22 }
    }
  });
  assert.equal(result.source, "correlated");
  assert.equal(result.vantages.remoteProbe, true);
  assert.equal(result.diagnosis.faultDomain, "access_path");
});
