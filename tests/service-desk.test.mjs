import test from "node:test";
import assert from "node:assert/strict";
import {
  buildServiceDeskUpdate,
  configureServiceDesk,
  listServiceDeskProviders,
  signIntegrationEnvelope,
  verifyIntegrationEnvelope
} from "../src/integrations/service-desk.mjs";

test("lists the planned service desk integration targets", () => {
  const ids = listServiceDeskProviders().map(item => item.id);
  for (const expected of ["servicenow", "jira-service-management", "zendesk", "halopsa", "freshservice", "connectwise", "generic-webhook"]) {
    assert.ok(ids.includes(expected));
  }
});

test("configures ticket correlation without storing transport credentials", () => {
  const configured = configureServiceDesk({ provider: "zendesk", externalTicketId: "ZD-901", externalTicketUrl: "https://support.example/tickets/901" }, 0);
  assert.equal(configured.provider, "zendesk");
  assert.equal(configured.externalTicketId, "ZD-901");
  assert.equal(configured.createdAt, "1970-01-01T00:00:00.000Z");
  assert.equal("token" in configured, false);
});

test("builds a provenance-preserving support update", () => {
  const integration = configureServiceDesk({ provider: "servicenow", externalTicketId: "INC00123" });
  const evidence = {
    integrity: { sha256: "abc123" },
    evidence: {
      runs: [{ sessionId: "FL-1", collectedAt: "2026-01-01T00:00:00.000Z", diagnosis: { faultDomain: "upstream", confidence: 91 } }]
    }
  };
  const update = buildServiceDeskUpdate({
    integration,
    caseRecord: { id: "CASE-1", title: "Calls failing", customer: "Example", status: "open", severity: "high" },
    evidence,
    baseUrl: "https://faultline.example.com"
  });
  assert.equal(update.ticket.id, "INC00123");
  assert.equal(update.update.faultDomain, "upstream");
  assert.equal(update.update.confidence, 91);
  assert.equal(update.provenance.evidencePackageDigest, "abc123");
  assert.match(update.update.evidenceUrl, /CASE-1\/report/);
});

test("signs integration envelopes deterministically", () => {
  const payload = { caseId: "CASE-1", status: "ready" };
  const envelope = signIntegrationEnvelope(payload, "secret", 0);
  assert.equal(verifyIntegrationEnvelope(envelope, "secret"), true);
  assert.equal(verifyIntegrationEnvelope(envelope, "wrong"), false);
});

test("rejects unsupported providers", () => {
  assert.throws(() => configureServiceDesk({ provider: "made-up", externalTicketId: "X" }), /Unsupported service desk provider/);
});
