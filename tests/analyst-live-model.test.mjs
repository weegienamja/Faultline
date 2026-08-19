import test from "node:test";
import assert from "node:assert/strict";

import { createOllamaClient } from "../src/analyst/ollama.mjs";
import { resolveStatus } from "../src/analyst/lifecycle.mjs";
import { createEvidenceRegistry, EVIDENCE_KIND } from "../src/analyst/registry.mjs";
import { createConversationStore } from "../src/analyst/conversation.mjs";
import { createAnalystGateway } from "../src/analyst/gateway.mjs";
import { buildDocIndex } from "../src/analyst/docs.mjs";

// Retrieval-breadth regression, against a REAL local model.
//
// Skipped unless FAULTLINE_ANALYST_LIVE_TEST=1, so `npm test` and CI never
// depend on an Ollama installation, a downloaded model, a GPU or the Internet.
// Everything else about the Analyst is covered deterministically in
// analyst-gateway.test.mjs and analyst-ollama.test.mjs.
//
// Run it with:
//   FAULTLINE_ANALYST_LIVE_TEST=1 node --test tests/analyst-live-model.test.mjs
//
// Why this test exists: an 8B model answers honestly but does not always
// notice that relevant evidence exists. Asked what Faultline knows about a
// target, it used to call get_current_target, receive a hostname, and stop -
// never retrieving the completed Network Bisect run one call away. The
// evidence inventory in the system prompt is the fix, and this pins it.

const ENABLED = process.env.FAULTLINE_ANALYST_LIVE_TEST === "1";
const MODEL = process.env.FAULTLINE_ANALYST_MODEL || "qwen3:8b";

const BISECT_REPORT = {
  schema: "faultline.network-bisect",
  schemaVersion: 2,
  mode: "adaptive",
  id: "bis_live_regression",
  startedAt: "2026-08-19T10:00:00.000Z",
  completedAt: "2026-08-19T10:01:00.000Z",
  target: { input: "example.com", host: "example.com", port: 443, scheme: "https" },
  baseline: { state: "HEALTHY_BASELINE", result: "PASS", passes: 2, total: 2, stage: null, reason: "HTTP 200" },
  executed: [
    { id: "family=ipv4", axisId: "family", axisLabel: "IP address family", label: "IPv4 only", result: "PASS", passes: 2, total: 2, stage: null, reason: "HTTP 200", selectionReason: "Highest discrimination score" },
    { id: "family=ipv6", axisId: "family", axisLabel: "IP address family", label: "IPv6 only", result: "FAIL", passes: 0, total: 2, stage: "dns", reason: "ENOENT", selectionReason: "Confirms the split" }
  ],
  skipped: [],
  axesUnavailable: [],
  hypotheses: [{ id: "h-ipv6", label: "This machine has no usable IPv6 connectivity", domain: "local-network", state: "WEAKENED" }],
  confirmation: { experimentId: "family=ipv6", label: "IPv6 only", confirmed: true, pairs: 2, baselinePasses: 2, variantPasses: 0 },
  counters: { connections: 12, executed: 2, skipped: 0, inapplicable: 0 },
  verdict: {
    classification: "LOCAL_CAPABILITY_DEFICIENCY",
    stop: "ISOLATED",
    headline: "IPv6 only fails although the target publishes 2 AAAA record(s)",
    detail: "Changing only the address family to IPv6 removed connectivity.",
    claim: "The endpoint cannot complete IPv6 connections to this target."
  }
};

const store = {
  listCases: async () => [],
  getCase: async () => null,
  listProbes: async () => [],
  getProbe: async () => null,
  listSessions: async () => [],
  listRuns: async () => [],
  getRun: async () => null
};

async function runtimeReady() {
  try {
    const status = await resolveStatus(createOllamaClient(), { model: MODEL });
    return status.ready;
  } catch {
    return false;
  }
}

test("retrieval breadth: a question about the target retrieves the bisect evidence too", { skip: !ENABLED && "set FAULTLINE_ANALYST_LIVE_TEST=1 to run against a real local model" }, async () => {
  assert.ok(await runtimeReady(), `${MODEL} must be installed and Ollama running for this test`);

  const registry = createEvidenceRegistry();
  registry.record(EVIDENCE_KIND.BISECT, BISECT_REPORT);

  const gateway = createAnalystGateway({
    client: createOllamaClient(),
    store,
    registry,
    docs: await buildDocIndex(),
    conversations: createConversationStore(),
    model: MODEL
  });

  const tools = [];
  let result = null;
  for await (const event of gateway.ask({
    question: "What does Faultline currently know about this target?",
    view: { view: "bisect", target: "example.com" }
  })) {
    if (event.type === "tool") tools.push(event.name);
    if (event.type === "result") result = event;
    if (event.type === "error") assert.fail(`analyst error: ${event.message}`);
  }

  assert.ok(tools.includes("get_current_target"), `expected get_current_target, got: ${tools.join(", ") || "(none)"}`);
  assert.ok(tools.includes("get_latest_bisect_run"), `expected get_latest_bisect_run, got: ${tools.join(", ") || "(none)"}`);

  // Retrieving it is only half the point: the answer must actually use it.
  assert.ok(result, "expected a result event");
  assert.ok(result.evidence.some(entry => entry.ref === "CONF-01" || entry.ref.startsWith("EXP-")),
    "bisect evidence references should be offered to the UI");
});

test("retrieval breadth: the deterministic verdict is reported as Faultline's, not the Analyst's", { skip: !ENABLED && "set FAULTLINE_ANALYST_LIVE_TEST=1 to run against a real local model" }, async () => {
  assert.ok(await runtimeReady(), `${MODEL} must be installed and Ollama running for this test`);

  const registry = createEvidenceRegistry();
  registry.record(EVIDENCE_KIND.BISECT, BISECT_REPORT);

  const gateway = createAnalystGateway({
    client: createOllamaClient(),
    store,
    registry,
    docs: await buildDocIndex(),
    conversations: createConversationStore(),
    model: MODEL
  });

  let result = null;
  for await (const event of gateway.ask({
    question: "Explain the latest Network Bisect result.",
    view: { view: "bisect", target: "example.com" }
  })) {
    if (event.type === "result") result = event;
  }

  assert.ok(result, "expected a result event");

  // Every hypothesis is stamped by Faultline, never by the model.
  for (const problem of result.response.possibleProblems) {
    assert.equal(problem.classification, "analyst_hypothesis");
  }

  // Any deterministic finding it claims must be tied to retrieved evidence;
  // uncited ones are demoted before they reach here.
  for (const finding of result.response.deterministicFindings) {
    assert.ok(finding.evidenceIds.length > 0, `uncited deterministic finding leaked: ${finding.finding}`);
  }
});
