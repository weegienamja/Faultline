import test from "node:test";
import assert from "node:assert/strict";
import { diagnose } from "../src/engine/diagnose.mjs";

const healthyBase = {
  gatewayLoss: 0,
  gatewayLatencyMs: 3,
  dnsResolved: true,
  directIpReachable: true,
  internetReachable: true,
  vpnRequired: false,
  upstreamLoss: 0,
  jitterMs: 5,
  targetReachable: true,
  targetHttpMs: 30
};

test("identifies a healthy endpoint-only path", () => {
  const result = diagnose(healthyBase);
  assert.equal(result.faultDomain, "healthy");
  assert.equal(result.confidence, 92);
});

test("raises healthy confidence when remote probe agrees", () => {
  const result = diagnose({ ...healthyBase, externalProbeHealthy: true, externalProbeLatencyMs: 25 });
  assert.equal(result.faultDomain, "healthy");
  assert.equal(result.confidence, 96);
});

test("isolates local network loss", () => {
  const result = diagnose({ ...healthyBase, gatewayLoss: 11, gatewayLatencyMs: 55, upstreamLoss: 12 });
  assert.equal(result.faultDomain, "local_network");
  assert.ok(result.confidence >= 90);
});

test("isolates DNS when direct IP connectivity works", () => {
  const result = diagnose({ ...healthyBase, dnsResolved: false, directIpReachable: true, targetReachable: false, externalProbeHealthy: true });
  assert.equal(result.faultDomain, "dns");
  assert.ok(result.confidence >= 95);
});

test("isolates a missing VPN route", () => {
  const result = diagnose({
    ...healthyBase,
    vpnRequired: true,
    vpnConnected: true,
    expectedRoutePresent: false,
    targetReachable: false,
    externalProbeHealthy: true
  });
  assert.equal(result.faultDomain, "vpn");
  assert.equal(result.confidence, 99);
});

test("isolates upstream loss when the gateway remains healthy", () => {
  const result = diagnose({ ...healthyBase, upstreamLoss: 8.4, jitterMs: 65, externalProbeHealthy: true });
  assert.equal(result.faultDomain, "upstream");
  assert.ok(result.confidence >= 99);
});

test("isolates endpoint path or policy when only endpoint fails", () => {
  const result = diagnose({
    ...healthyBase,
    targetReachable: false,
    externalProbeHealthy: true,
    directIpReachable: false
  });
  assert.equal(result.faultDomain, "access_path");
  assert.ok(result.confidence >= 85);
});

test("isolates target service failure when both vantages fail", () => {
  const result = diagnose({
    ...healthyBase,
    targetReachable: false,
    externalProbeHealthy: false
  });
  assert.equal(result.faultDomain, "target_service");
  assert.ok(result.confidence >= 90);
});
