import test from "node:test";
import assert from "node:assert/strict";
import {
  assertLiteralTargetAllowed,
  assertPortAllowed,
  classifyAddress,
  validateResolvedAddresses
} from "../src/security/target.mjs";

test("classifies private and local address space as blocked for public probes", () => {
  for (const address of ["127.0.0.1", "10.20.30.40", "172.16.1.2", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
    assert.equal(classifyAddress(address).public, false, address);
  }
  assert.equal(classifyAddress("8.8.8.8").public, true);
  assert.equal(classifyAddress("2606:4700:4700::1111").public, true);
});

test("public probes reject private literal targets and unapproved ports", () => {
  assert.throws(() => assertLiteralTargetAllowed("http://127.0.0.1", 80, "public"), /Public probes cannot target/);
  assert.throws(() => assertLiteralTargetAllowed("example.com", 22, "public"), /approved ports/);
  assert.doesNotThrow(() => assertLiteralTargetAllowed("example.com", 443, "public"));
});

test("private probes may target private networks and arbitrary valid ports", () => {
  assert.doesNotThrow(() => assertLiteralTargetAllowed("https://10.0.0.5", 9443, "private"));
  assert.equal(assertPortAllowed(22, "private"), 22);
});

test("public DNS validation rejects a mixed public and private answer set", () => {
  assert.throws(() => validateResolvedAddresses([
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.2", family: 4 }
  ], "public"), /blocked address/);
});
