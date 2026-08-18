import test from "node:test";
import assert from "node:assert/strict";
import {
  getConnectivityContract,
  listConnectivityContracts,
  resolveContractCheck,
  summariseContractRun,
  validateConnectivityContract
} from "../src/contracts/registry.mjs";
import { diagnose } from "../src/engine/diagnose.mjs";

test("ships generic versioned connectivity contracts", () => {
  const contracts = listConnectivityContracts();
  assert.equal(contracts.length >= 3, true);
  assert.deepEqual(contracts.map(contract => contract.id), ["basic-reachability", "secure-web", "web-api"]);
  assert.equal(contracts.every(contract => contract.version === 1), true);
  assert.equal(getConnectivityContract("secure-web").checks.some(check => check.type === "tls"), true);
});

test("validates contract shape and rejects unsupported check types", () => {
  assert.throws(() => validateConnectivityContract({
    id: "bad",
    name: "Bad",
    checks: [{ type: "icmp", required: true }]
  }), /Unsupported connectivity contract check type/);

  const contract = validateConnectivityContract({
    id: "custom-web",
    version: 2,
    name: "Custom web",
    checks: [{ id: "tcp", type: "tcp", required: true, host: "$target.host", port: "$target.port" }]
  });
  assert.equal(contract.version, 2);
  assert.equal(contract.checks[0].timeoutMs, 3500);
});

test("resolves target placeholders without mutating the contract", () => {
  const contract = getConnectivityContract("secure-web");
  const check = contract.checks.find(item => item.type === "http");
  const resolved = resolveContractCheck(check, { host: "example.com", port: 443, url: "https://example.com/health" });
  assert.equal(resolved.url, "https://example.com/health");
  assert.equal(check.url, "$target.url");
});

test("summarises required connectivity conditions for later data-science features", () => {
  const contract = getConnectivityContract("secure-web");
  const summary = summariseContractRun(contract, [
    { id: "dns", type: "dns", required: true, ok: true },
    { id: "tcp", type: "tcp", required: true, ok: true },
    { id: "tls", type: "tls", required: true, ok: false },
    { id: "http", type: "http", required: true, ok: false }
  ]);
  assert.equal(summary.passed, false);
  assert.equal(summary.passRate, 50);
  assert.equal(summary.failedRequired, 2);
  assert.equal(summary.firstFailureType, "tls");
});

test("diagnosis exposes contract evidence without replacing deterministic fault rules", () => {
  const result = diagnose({
    gatewayLoss: 0,
    gatewayLatencyMs: 2,
    dnsResolved: true,
    directIpReachable: true,
    internetReachable: true,
    upstreamLoss: 0,
    jitterMs: 1,
    targetReachable: false,
    contractPassed: false,
    contractPassRate: 75,
    contractFailureType: "http",
    externalProbeHealthy: true
  });

  assert.equal(result.faultDomain, "access_path");
  const evidence = result.evidence.find(item => item.label === "Connectivity contract");
  assert.equal(evidence.status, "fail");
  assert.equal(evidence.value, "75%");
});
