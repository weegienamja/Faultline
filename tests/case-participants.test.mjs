import test from "node:test";
import assert from "node:assert/strict";
import { createSupportCase } from "../src/cases/service.mjs";
import {
  addParticipantContribution,
  createCaseParticipantInvitation,
  findParticipantAccess,
  revokeCaseParticipant,
  sharedCaseView
} from "../src/cases/participants.mjs";

test("creates a scoped expiring case participant credential", () => {
  const base = createSupportCase({ title: "Provider escalation" }, Date.parse("2026-08-19T00:00:00Z"));
  const result = createCaseParticipantInvitation(base, {
    name: "Alex",
    organization: "Example ISP",
    role: "contributor",
    ttlMinutes: 60
  }, Date.parse("2026-08-19T00:01:00Z"));

  assert.match(result.token, /^fl_case_/);
  assert.equal(result.invitation.organization, "Example ISP");
  assert.equal(result.caseRecord.participantInvitations[0].tokenHash.includes(result.token), false);
  const access = findParticipantAccess([result.caseRecord], result.token, Date.parse("2026-08-19T00:02:00Z"));
  assert.equal(access.caseRecord.id, base.id);
  assert.equal(access.invitation.role, "contributor");
});

test("contributor appends provenance-tagged counter-evidence without changing diagnosis", () => {
  const base = createSupportCase({ title: "Provider escalation" });
  const invited = createCaseParticipantInvitation(base, { name: "Alex", organization: "Example ISP", role: "contributor" });
  const invitation = invited.caseRecord.participantInvitations[0];
  const result = addParticipantContribution(invited.caseRecord, invitation, {
    kind: "counter-evidence",
    summary: "Provider edge reports no loss from its test vantage.",
    measurements: { packetLoss: 0, latencyMs: 18 }
  });

  assert.equal(result.contribution.kind, "counter-evidence");
  assert.equal(result.caseRecord.contributions.length, 1);
  const event = result.caseRecord.timeline.at(-1);
  assert.equal(event.type, "participant.contribution");
  assert.equal(event.evidenceKind, "observed");
  assert.equal(event.source, "Example ISP");
  assert.equal(result.caseRecord.diagnosis, undefined);
});

test("observer cannot contribute and revoked credential stops resolving", () => {
  const base = createSupportCase({ title: "Shared case" });
  const invited = createCaseParticipantInvitation(base, { name: "Viewer", organization: "SaaS Co", role: "observer" });
  const invitation = invited.caseRecord.participantInvitations[0];
  assert.throws(() => addParticipantContribution(invited.caseRecord, invitation, { summary: "Should fail" }), /read-only/);

  const revoked = revokeCaseParticipant(invited.caseRecord, invitation.id);
  assert.equal(findParticipantAccess([revoked], invited.token), null);
});

test("shared case view omits participant credential hashes", () => {
  const base = createSupportCase({ title: "Shared case" });
  const invited = createCaseParticipantInvitation(base, { name: "Viewer", organization: "SaaS Co", role: "observer" });
  const view = sharedCaseView(invited.caseRecord, { schema: "faultline.case-evidence" });
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /tokenHash/);
  assert.equal(view.evidence.schema, "faultline.case-evidence");
});
