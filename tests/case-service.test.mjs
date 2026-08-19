import test from "node:test";
import assert from "node:assert/strict";
import {
  addCaseNote,
  attachSessionToCase,
  createSupportCase,
  recordCaseEvent,
  updateSupportCase
} from "../src/cases/service.mjs";

test("creates a support case with explicit evidence timeline metadata", () => {
  const created = createSupportCase({
    title: "Calls dropping",
    customer: "Northstar Design",
    affectedService: "Voice platform",
    severity: "high",
    tags: ["Remote", "Voice", "remote"]
  }, Date.parse("2026-08-19T00:00:00.000Z"));

  assert.match(created.id, /^CASE-/);
  assert.equal(created.status, "open");
  assert.equal(created.severity, "high");
  assert.deepEqual(created.tags, ["remote", "voice"]);
  assert.equal(created.timeline[0].type, "case.created");
  assert.equal(created.timeline[0].evidenceKind, "observed");
});

test("attaches diagnostics once and records notes, evidence and resolution", () => {
  let record = createSupportCase({ title: "VPN incident" }, Date.parse("2026-08-19T00:00:00.000Z"));
  record = attachSessionToCase(record, "FL-ONE", Date.parse("2026-08-19T00:01:00.000Z"));
  record = attachSessionToCase(record, "FL-ONE", Date.parse("2026-08-19T00:02:00.000Z"));
  assert.deepEqual(record.sessionIds, ["FL-ONE"]);

  const noted = addCaseNote(record, { author: "Jamie", body: "Customer reproduced after reconnecting VPN." }, Date.parse("2026-08-19T00:03:00.000Z"));
  record = noted.caseRecord;
  assert.equal(record.notes.length, 1);
  assert.equal(record.timeline.at(-1).evidenceKind, "annotation");

  record = recordCaseEvent(record, {
    type: "diagnostic.endpoint_evidence",
    sessionId: "FL-ONE",
    summary: "Endpoint evidence received.",
    evidenceKind: "observed"
  }, Date.parse("2026-08-19T00:04:00.000Z"));
  assert.equal(record.timeline.at(-1).sessionId, "FL-ONE");

  record = updateSupportCase(record, {
    status: "resolved",
    resolution: "Corrected the split-tunnel route."
  }, Date.parse("2026-08-19T00:05:00.000Z"));
  assert.equal(record.status, "resolved");
  assert.equal(record.resolution.summary, "Corrected the split-tunnel route.");
  assert.ok(record.timeline.some(event => event.type === "case.status_changed"));
  assert.ok(record.timeline.some(event => event.type === "case.resolution_recorded"));
});

test("rejects unsupported case states and overlong notes", () => {
  const record = createSupportCase({ title: "Test" });
  assert.throws(() => updateSupportCase(record, { status: "waiting-on-magic" }), /not supported/);
  assert.throws(() => addCaseNote(record, { body: "x".repeat(2001) }), /2000 characters/);
});
