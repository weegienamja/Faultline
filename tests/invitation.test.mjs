import test from "node:test";
import assert from "node:assert/strict";
import {
  claimDiagnosticInvitation,
  createDiagnosticSession,
  exchangeClientLaunch,
  findSessionByInvitationToken,
  publicSession
} from "../src/session/service.mjs";
import { verifySessionRole } from "../src/security/auth.mjs";

const NOW = Date.parse("2026-08-18T20:00:00.000Z");

test("creates an ephemeral session without pre-minting endpoint access", () => {
  const created = createDiagnosticSession({
    target: "https://example.com/health",
    ttlMinutes: 30,
    ephemeral: true
  }, NOW);

  assert.equal(created.session.mode, "ephemeral");
  assert.equal(created.session.endpointTokenHash, null);
  assert.equal(typeof created.credentials.invitationToken, "string");
  assert.equal(created.credentials.invitationToken.startsWith("fl_inv_"), true);
  assert.equal("endpointToken" in created.credentials, false);
  assert.equal(publicSession(created.session, NOW).invitation.status, "available");
});

test("finds an invitation only with the correct high-entropy secret", () => {
  const created = createDiagnosticSession({ target: "example.com", ephemeral: true }, NOW);
  assert.equal(findSessionByInvitationToken([created.session], "wrong"), null);
  assert.equal(findSessionByInvitationToken([created.session], created.credentials.invitationToken)?.id, created.session.id);
});

test("requires explicit consent before creating client launch access", () => {
  const created = createDiagnosticSession({ target: "example.com", ephemeral: true }, NOW);
  assert.throws(
    () => claimDiagnosticInvitation(created.session, created.credentials.invitationToken, { consent: false }, NOW + 1_000),
    /Explicit consent is required/
  );
  assert.equal(created.session.endpointTokenHash, null);
});

test("claiming consumes invitation but still does not mint endpoint access", () => {
  const created = createDiagnosticSession({ target: "example.com", ephemeral: true }, NOW);
  const claimed = claimDiagnosticInvitation(
    created.session,
    created.credentials.invitationToken,
    { consent: true, includeTopology: false },
    NOW + 5_000
  );

  assert.equal(claimed.clientLaunchToken.startsWith("fl_launch_"), true);
  assert.equal(claimed.session.endpointTokenHash, null);
  assert.equal(claimed.session.invitation.tokenHash, null);
  assert.equal(claimed.session.invitation.includeTopology, false);
  assert.equal(claimed.session.invitation.claimedAt, "2026-08-18T20:00:05.000Z");
  assert.equal(findSessionByInvitationToken([claimed.session], created.credentials.invitationToken), null);
  assert.equal(publicSession(claimed.session, NOW + 5_000).invitation.clientLaunchStatus, "available");
});

test("Windows client exchange mints endpoint credential once and consumes launcher", () => {
  const created = createDiagnosticSession({ target: "example.com", ephemeral: true }, NOW);
  const claimed = claimDiagnosticInvitation(
    created.session,
    created.credentials.invitationToken,
    { consent: true, includeTopology: true },
    NOW + 5_000
  );
  const exchanged = exchangeClientLaunch(claimed.session, claimed.clientLaunchToken, NOW + 8_000);

  assert.equal(exchanged.endpointToken.startsWith("fl_ep_"), true);
  assert.equal(exchanged.includeTopology, true);
  assert.equal(verifySessionRole(exchanged.session, exchanged.endpointToken, "endpoint"), true);
  assert.equal(exchanged.session.invitation.clientLaunch.tokenHash, null);
  assert.equal(exchanged.session.invitation.clientLaunch.exchangedAt, "2026-08-18T20:00:08.000Z");
  assert.equal(publicSession(exchanged.session, NOW + 8_000).invitation.clientLaunchStatus, "exchanged");
  assert.throws(
    () => exchangeClientLaunch(exchanged.session, claimed.clientLaunchToken, NOW + 9_000),
    /invalid or already used/
  );
});

test("expired invitations cannot be claimed", () => {
  const created = createDiagnosticSession({ target: "example.com", ttlMinutes: 5, ephemeral: true }, NOW);
  assert.throws(
    () => claimDiagnosticInvitation(created.session, created.credentials.invitationToken, { consent: true }, NOW + 5 * 60_000),
    /expired/
  );
});

test("direct sessions keep the existing endpoint-token workflow", () => {
  const created = createDiagnosticSession({ target: "example.com" }, NOW);
  assert.equal(created.session.mode, "direct");
  assert.equal(created.session.invitation, null);
  assert.equal(created.credentials.endpointToken.startsWith("fl_ep_"), true);
  assert.equal(verifySessionRole(created.session, created.credentials.endpointToken, "endpoint"), true);
});
