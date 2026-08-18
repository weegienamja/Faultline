import test from "node:test";
import assert from "node:assert/strict";
import { generateCredential, hashCredential, isSessionExpired, verifyCredential, verifySessionRole } from "../src/security/auth.mjs";
import { createDiagnosticSession, normaliseSessionInput, publicSession } from "../src/session/service.mjs";

test("generates opaque role-scoped credentials and stores hashes", () => {
  const { session, credentials } = createDiagnosticSession({ target: "example.com" }, Date.UTC(2026, 7, 18, 18, 0));
  assert.match(credentials.endpointToken, /^fl_ep_/);
  assert.match(credentials.probeToken, /^fl_pr_/);
  assert.notEqual(credentials.endpointToken, credentials.probeToken);
  assert.equal(session.endpointTokenHash, hashCredential(credentials.endpointToken));
  assert.equal(session.probeTokenHash, hashCredential(credentials.probeToken));
  assert.equal(JSON.stringify(session).includes(credentials.endpointToken), false);
});

test("assigned registered-probe sessions do not mint one-off probe tokens", () => {
  const { session, credentials } = createDiagnosticSession({ target: "example.com", assignedProbeId: "PRB-TEST" });
  assert.match(credentials.endpointToken, /^fl_ep_/);
  assert.equal("probeToken" in credentials, false);
  assert.equal(session.probeTokenHash, null);
  assert.equal(session.assignedProbeId, "PRB-TEST");
  assert.equal(publicSession(session).assignedProbeId, "PRB-TEST");
});

test("verifies credentials using hashed constant-time comparison", () => {
  const credential = generateCredential("fl_test");
  const hash = hashCredential(credential);
  assert.equal(verifyCredential(credential, hash), true);
  assert.equal(verifyCredential(`${credential}x`, hash), false);
});

test("enforces endpoint and probe roles independently", () => {
  const { session, credentials } = createDiagnosticSession({ target: "example.com" });
  assert.equal(verifySessionRole(session, credentials.endpointToken, "endpoint"), true);
  assert.equal(verifySessionRole(session, credentials.endpointToken, "probe"), false);
  assert.equal(verifySessionRole(session, credentials.probeToken, "probe"), true);
});

test("reports session expiry without leaking credential hashes", () => {
  const now = Date.UTC(2026, 7, 18, 18, 0);
  const { session } = createDiagnosticSession({ target: "example.com", ttlMinutes: 10 }, now);
  assert.equal(isSessionExpired(session, now + 9 * 60_000), false);
  assert.equal(isSessionExpired(session, now + 11 * 60_000), true);
  const exposed = publicSession(session, now);
  assert.equal("endpointTokenHash" in exposed, false);
  assert.equal("probeTokenHash" in exposed, false);
});

test("infers HTTP and HTTPS ports correctly", () => {
  assert.equal(normaliseSessionInput({ target: "http://example.com/health" }).target.port, 80);
  assert.equal(normaliseSessionInput({ target: "https://example.com/health" }).target.port, 443);
  assert.equal(normaliseSessionInput({ target: "https://example.com:8443/health" }).target.port, 8443);
});
