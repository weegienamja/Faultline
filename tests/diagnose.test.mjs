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
  externalProbeHealthy: true,
  targetReachable: true,
  targetHttpMs: 30
};

test("identifies a healthy path", () => {
  const result = diagnose(healthyBase);
  assert.equal(result.faultDomain, "healthy");
  assert.ok(result.confidence >= 90);
});

test("isolates local network loss", () => {
  const result = diagnose({ ...healthyBase, gatewayLoss: 11, gatewayLatencyMs: 55, upstreamLoss: 12 });
  assert.equal(result.faultDomain, "local_network");
  assert.ok(result.confidence >= 90);
});

test("isolates DNS when direct IP connectivity works", () => {
  const result = diagnose({ ...healthyBase, dnsResolved: false, directIpReachable: true, targetReachable: false });
  assert.equal(result.faultDomain, "dns");
  assert.ok(result.confidence >= 90);
});

test("isolates a missing VPN route", () => {
  const result = diagnose({
    ...healthyBase,
    vpnRequired: true,
    vpnConnected: true,
    expectedRoutePresent: false,
    targetReachable: false
  });
  assert.equal(result.faultDomain, "vpn");
  assert.equal(result.confidence, 99);
});

test("isolates upstream loss when the gateway remains healthy", () => {
  const result = diagnose({ ...healthyBase, upstreamLoss: 8.4, jitterMs: 65 });
  assert.equal(result.faultDomain, "upstream");
  assert.ok(result.confidence >= 90);
});

test("isolates target service failure across independent probes", () => {
  const result = diagnose({ ...healthyBase, targetReachable: false, externalProbeHealthy: false });
  assert.equal(result.faultDomain, "target_service");
  assert.ok(result.confidence >= 80);
});
