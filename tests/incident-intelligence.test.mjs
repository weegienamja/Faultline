import test from "node:test";
import assert from "node:assert/strict";
import { incidents } from "./fixtures/reference-incidents.mjs";
import { diagnose } from "../src/engine/diagnose.mjs";
import {
  dbscan,
  fitIncidentFeatureSpace,
  incidentDistance,
  vectoriseIncident
} from "../public/intelligence.js";
import { analyseEvidencePatterns } from "../public/evidence-patterns.js";

function diagnosedDemos() {
  return incidents.map(incident => ({
    ...incident,
    diagnosis: diagnose(incident.metrics)
  }));
}

test("fits a repeatable mixed incident feature space", () => {
  const demos = diagnosedDemos();
  const space = fitIncidentFeatureSpace(demos.map(item => ({ ...item, diagnosis: null })));
  assert.equal(space.rowCount, demos.length);
  assert.equal(space.numeric.gatewayLoss.observed, demos.length);
  assert.equal(space.categories.contractId.includes("none"), true);

  const first = vectoriseIncident({ ...demos[0], diagnosis: null }, space);
  const second = vectoriseIncident({ ...demos[1], diagnosis: null }, space);
  assert.equal(first.vector.length, second.vector.length);
  assert.equal(Number.isFinite(incidentDistance(first, second)), true);
});

test("DBSCAN discovers the synthetic upstream incident family and leaves unrelated cases as noise", () => {
  const result = analyseEvidencePatterns(diagnosedDemos());
  assert.equal(result.method.name, "DBSCAN");
  assert.equal(result.method.supervised, false);
  assert.equal(result.method.diagnosisFeaturesExcluded, true);
  assert.equal(result.clusterCount, 1);

  const cluster = result.clusters[0];
  assert.deepEqual(new Set(cluster.incidentIds), new Set(["FL-1042", "FL-1040", "FL-1038"]));
  assert.equal(cluster.size, 3);
  assert.equal(result.incidents["FL-1041"].noise, true);
  assert.equal(result.incidents["FL-1039"].noise, true);
  assert.equal(result.incidents["FL-1037"].noise, true);
});

test("similarity ranks genuinely similar telemetry above unrelated fault patterns", () => {
  const result = analyseEvidencePatterns(diagnosedDemos());
  const neighbours = result.incidents["FL-1042"].neighbours;
  assert.equal(["FL-1040", "FL-1038"].includes(neighbours[0].id), true);
  assert.equal(neighbours[0].similarity > 90, true);

  const unrelated = neighbours.find(item => item.id === "FL-1041");
  if (unrelated) assert.equal(neighbours[0].similarity > unrelated.similarity, true);
});

test("fault-domain labels do not influence the evidence-only similarity model", () => {
  const base = {
    metrics: {
      gatewayLoss: 0,
      gatewayLatencyMs: 4,
      upstreamLoss: 8,
      jitterMs: 60,
      dnsResolved: true,
      internetReachable: true,
      targetReachable: true,
      externalProbeHealthy: true,
      vpnRequired: false
    }
  };
  const data = [
    { id: "A", title: "A", ...base, diagnosis: { faultDomain: "upstream" } },
    { id: "B", title: "B", ...base, diagnosis: { faultDomain: "dns" } },
    { id: "C", title: "C", ...base, diagnosis: { faultDomain: "local_network" } }
  ];

  const result = analyseEvidencePatterns(data);
  assert.equal(result.clusters[0].size, 3);
  assert.equal(result.incidents.A.neighbours[0].similarity, 100);
  assert.equal(result.featureSpace.categorical.includes("faultDomain"), false);
});

test("DBSCAN can explicitly leave sparse vectors unclustered", () => {
  const vectors = [
    { vector: [0], weights: [1] },
    { vector: [0.8], weights: [1] },
    { vector: [1.6], weights: [1] }
  ];
  assert.deepEqual(dbscan(vectors, { epsilon: 0.1, minPoints: 2 }), [-1, -1, -1]);
});
