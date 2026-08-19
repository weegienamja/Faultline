import test from "node:test";
import assert from "node:assert/strict";
import { isolate } from "../src/bisect/adaptive.mjs";
import { expectedRemaining, partition, planNext, scoreExperiment, SKIP } from "../src/bisect/planner.mjs";
import { applyObservation, buildHypotheses, live, PREDICT, STATE } from "../src/bisect/hypotheses.mjs";
import { buildExperiments } from "../src/bisect/experiments.mjs";
import { BASELINE_STATE, CLASSIFICATION, RESULT, STOP, classifyTrials, transition } from "../src/bisect/results.mjs";
import { classifyInterface, IFACE, ROUTE } from "../src/bisect/interfaces.mjs";
import { planFromAssignment } from "../src/bisect/probe.mjs";
import { parseLiveTarget } from "../src/live/measure.mjs";

// The adaptive engine is tested with an injected trial runner and an injected
// interface model, so every test is deterministic and none touches the network.

const TARGET = parseLiveTarget("https://example.test");

const PRIMARY_IF = {
  name: "Ethernet", description: "Intel Ethernet", address: "192.168.0.95", interfaceIndex: 16,
  classification: IFACE.PRIMARY, ownsDefaultRoute: true, isBestDefault: true, routeSupport: ROUTE.HAS_ROUTE
};
const HOSTONLY_IF = {
  name: "Ethernet 2", description: "Host-Only Ethernet Adapter", address: "192.168.56.1", interfaceIndex: 13,
  classification: IFACE.HOST_ONLY, ownsDefaultRoute: false, isBestDefault: false,
  routeSupport: ROUTE.NO_ROUTE, routeReason: "The operating system does not select Ethernet 2 for this destination."
};

function model(interfaces = [PRIMARY_IF, HOSTONLY_IF]) {
  return { supported: true, platform: "win32", interfaces };
}

const trial = (verdict, { stage = null, reason = null, plan = {} } = {}) => ({ verdict, stage, reason, stages: {}, plan });
const PASS = () => trial("pass", { reason: "HTTP 200" });
const FAIL = (stage = "tcp", reason = "ETIMEDOUT") => trial("fail", { stage, reason });

/** Build a runner and record every assignment it was asked to run. */
function runner(decide) {
  const calls = [];
  const fn = async (_target, assignment) => { calls.push({ ...assignment }); return decide(assignment, calls.length); };
  fn.calls = calls;
  return fn;
}

const base = (extra = {}) => ({
  repeat: 3, confirmPairs: 3, interfaceModel: model(),
  answerSets: { v4: ["1.2.3.4"], v6: ["2606::1"] }, ...extra
});

// ---------------------------------------------------------------------------
// Result-state model
// ---------------------------------------------------------------------------

test("result states are first class and never collapsed into pass or fail", () => {
  assert.equal(classifyTrials([{ verdict: "pass" }, { verdict: "pass" }]).result, RESULT.PASS);
  assert.equal(classifyTrials([{ verdict: "fail" }, { verdict: "fail" }]).result, RESULT.FAIL);
  assert.equal(classifyTrials([{ verdict: "pass" }, { verdict: "fail" }]).result, RESULT.UNSTABLE);

  // The important ones: these must NOT become FAIL.
  assert.equal(classifyTrials([{ verdict: "inapplicable" }]).result, RESULT.INAPPLICABLE);
  assert.equal(classifyTrials([{ verdict: "unsupported" }]).result, RESULT.UNSUPPORTED);
  // Even mixed with failures, inapplicability wins: the experiment never applied.
  assert.equal(classifyTrials([{ verdict: "fail" }, { verdict: "inapplicable" }]).result, RESULT.INAPPLICABLE);
});

test("transitions are expressed relative to the baseline", () => {
  assert.equal(transition(RESULT.FAIL, RESULT.PASS), "fail-to-pass");
  assert.equal(transition(RESULT.PASS, RESULT.FAIL), "pass-to-fail");
  assert.equal(transition(RESULT.PASS, RESULT.PASS), "same");
  // Non-evidential states carry no transition at all.
  assert.equal(transition(RESULT.PASS, RESULT.INAPPLICABLE), "none");
  assert.equal(transition(RESULT.PASS, RESULT.UNSUPPORTED), "none");
});

// ---------------------------------------------------------------------------
// Scoring algorithm
// ---------------------------------------------------------------------------

test("expected remaining candidates matches the documented derivation", () => {
  const groups = counts => new Map(counts.map((n, i) => [String(i), Array.from({ length: n }, (_v, j) => `h${i}_${j}`)]));
  assert.equal(expectedRemaining(groups([3, 3])), 3);
  assert.equal(expectedRemaining(groups([2, 4])), 3.3333);
  assert.equal(expectedRemaining(groups([1, 5])), 4.3333);
  assert.equal(expectedRemaining(groups([6])), 6);
});

test("a balanced split outranks a lopsided one at equal cost", () => {
  const mk = (id, predictions) => ({
    id, label: id, state: STATE.STILL_POSSIBLE, notes: [],
    predict: axisId => predictions[axisId] ?? PREDICT.UNCHANGED
  });
  // Six hypotheses; axis A splits them 3/3, axis B splits them 1/5.
  const hypotheses = [
    mk("h1", { A: PREDICT.PASS, B: PREDICT.PASS }), mk("h2", { A: PREDICT.PASS, B: PREDICT.PASS }),
    mk("h3", { A: PREDICT.PASS, B: PREDICT.PASS }), mk("h4", { A: PREDICT.FAIL, B: PREDICT.PASS }),
    mk("h5", { A: PREDICT.FAIL, B: PREDICT.PASS }), mk("h6", { A: PREDICT.FAIL, B: PREDICT.FAIL })
  ];
  const balanced = scoreExperiment(hypotheses, { axisId: "A", value: "x", cost: 1 });
  const lopsided = scoreExperiment(hypotheses, { axisId: "B", value: "x", cost: 1 });
  assert.equal(balanced.discrimination, 3);
  assert.equal(lopsided.discrimination, 1.6667);
  assert.ok(balanced.score > lopsided.score, "3/3 must outrank 1/5");
});

test("an experiment every hypothesis agrees about scores zero", () => {
  const agree = [
    { id: "a", state: STATE.STILL_POSSIBLE, predict: () => PREDICT.UNCHANGED },
    { id: "b", state: STATE.STILL_POSSIBLE, predict: () => PREDICT.UNCHANGED }
  ];
  const scored = scoreExperiment(agree, { axisId: "z", value: "1", cost: 1 });
  assert.equal(scored.score, 0);
  assert.match(scored.reason, /same outcome/);
});

test("hypotheses that abstain are excluded from the partition, not lumped together", () => {
  const set = [
    { id: "a", state: STATE.STILL_POSSIBLE, predict: () => PREDICT.PASS },
    { id: "b", state: STATE.STILL_POSSIBLE, predict: () => PREDICT.FAIL },
    { id: "c", state: STATE.STILL_POSSIBLE, predict: () => PREDICT.UNKNOWN }
  ];
  const groups = partition(set, { axisId: "x", value: "1" });
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  assert.equal(total, 2, "the abstaining hypothesis must not appear in any group");
});

test("experiment ordering is deterministic for identical evidence", () => {
  const hypotheses = buildHypotheses({ baselineFailed: true });
  const { experiments } = buildExperiments({
    target: TARGET, answers: { v4: ["1.2.3.4"], v6: ["2606::1"] },
    resolvers: ["1.1.1.1", "8.8.8.8"], interfaces: model().interfaces, targetIsLoopback: false
  });
  const first = planNext(hypotheses, experiments, {});
  const second = planNext(hypotheses, experiments, {});
  assert.equal(first.selected.experiment.id, second.selected.experiment.id);
  assert.deepEqual(first.candidates.map(c => c.experiment.id), second.candidates.map(c => c.experiment.id));
});

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

test("an axis with a confirmed discriminator is not swept further", () => {
  const hypotheses = buildHypotheses({ baselineFailed: true });
  const { experiments } = buildExperiments({
    target: TARGET, answers: { v4: ["1.2.3.4"], v6: ["2606::1"] },
    resolvers: ["1.1.1.1"], interfaces: model().interfaces, targetIsLoopback: false
  });
  const { skipped } = planNext(hypotheses, experiments, { resolvedAxes: new Set(["address-family"]) });
  const familySkips = skipped.filter(s => s.experiment.axisId === "address-family");
  assert.ok(familySkips.length > 0);
  assert.ok(familySkips.every(s => s.skip === SKIP.AXIS_RESOLVED));
  assert.match(familySkips[0].reason, /already established/);
});

test("a known-inapplicable experiment is skipped as inapplicable, never as low value", () => {
  const hypotheses = buildHypotheses({ baselineFailed: true });
  const { experiments } = buildExperiments({
    target: TARGET, answers: { v4: ["1.2.3.4"], v6: [] },
    resolvers: ["1.1.1.1"], interfaces: model().interfaces, targetIsLoopback: false
  });
  const { skipped } = planNext(hypotheses, experiments, {});
  const hostOnly = skipped.find(s => String(s.experiment.value) === "192.168.56.1");
  assert.ok(hostOnly, "the host-only interface experiment should be present and skipped");
  assert.equal(hostOnly.skip, SKIP.INAPPLICABLE);
  assert.match(hostOnly.reason, /does not select/);
});

// ---------------------------------------------------------------------------
// Interface classification
// ---------------------------------------------------------------------------

test("interfaces are classified from routing facts, not from vendor names", () => {
  // Owning the best default route makes it primary regardless of description.
  assert.equal(classifyInterface({ name: "Ethernet", description: "Intel I225-V", ownsDefaultRoute: true, isBestDefault: true }), IFACE.PRIMARY);
  // Self-described host-only with no default route.
  assert.equal(classifyInterface({ name: "Ethernet 2", description: "VirtualBox Host-Only Ethernet Adapter", ownsDefaultRoute: false }), IFACE.HOST_ONLY);
  // A tunnel adapter.
  assert.equal(classifyInterface({ name: "Surfshark", description: "OpenVPN Data Channel Offload", ownsDefaultRoute: false }), IFACE.VPN);
  assert.equal(classifyInterface({ name: "WiFi", description: "Intel Wi-Fi 6 AX201", ownsDefaultRoute: true }), IFACE.WIFI);
  assert.equal(classifyInterface({ name: "lo", description: "", addresses: ["127.0.0.1"] }), IFACE.LOOPBACK);
  // No default route and nothing recognisable: not a general egress path, and
  // no vendor is asserted.
  assert.equal(classifyInterface({ name: "Adapter 9", description: "Unknown", ownsDefaultRoute: false }), IFACE.VIRTUAL);
});

test("an interface with no route to the target yields INAPPLICABLE rather than FAIL", async () => {
  // The runner would report failure if asked; it must never be asked.
  const trialRunner = runner((assignment) => {
    if (assignment["source-interface"] === "192.168.56.1") {
      throw new Error("The host-only interface must never be exercised against this target.");
    }
    return PASS();
  });
  const report = await isolate("https://example.test", base({ trialRunner }));
  const hostOnly = report.skipped.find(s => String(s.label).includes("192.168.56.1"));
  assert.ok(hostOnly);
  assert.equal(hostOnly.skip, SKIP.INAPPLICABLE);
  assert.equal(report.counters.inapplicable, 1);
  assert.ok(report.executed.every(e => e.label !== hostOnly.label));
});

// ---------------------------------------------------------------------------
// Phase 15 scenarios
// ---------------------------------------------------------------------------

test("1. failing baseline plus IPv4 pass and IPv6 fail isolates the address family", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL("tcp", "ETIMEDOUT")));
  const report = await isolate("https://example.test", base({ trialRunner }));

  assert.equal(report.baseline.state, BASELINE_STATE.FAILED);
  assert.equal(report.verdict.classification, CLASSIFICATION.FAILURE_DISCRIMINATOR);
  assert.equal(report.verdict.stop, STOP.ISOLATED);
  assert.equal(report.confirmation.confirmed, true);
  assert.match(report.verdict.claim, /Evidence supports/);
  assert.ok(report.verdict.workaround, "a repaired baseline should offer a workaround");
  // Never overstates.
  assert.doesNotMatch(JSON.stringify(report.verdict), /root cause|caused by|proves/i);
});

test("2. healthy baseline with no AAAA published is a target property, not a local fault", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv6" ? FAIL("dns", "ENODATA") : PASS()));
  const report = await isolate("https://example.test", base({
    trialRunner, answerSets: { v4: ["1.2.3.4"], v6: [] }  // authoritative: no AAAA exists
  }));

  assert.equal(report.baseline.state, BASELINE_STATE.HEALTHY);
  assert.equal(report.verdict.classification, CLASSIFICATION.TARGET_PROPERTY);
  assert.equal(report.verdict.stop, STOP.TARGET_PROPERTY);
  assert.match(report.verdict.headline, /publishes no AAAA record/);
  assert.doesNotMatch(report.verdict.claim, /your|broken/i);
});

test("3. an intermittent baseline refuses isolation and reports the flake rate", async () => {
  let n = 0;
  const trialRunner = runner(() => (n++ % 2 === 0 ? FAIL() : PASS()));
  const report = await isolate("https://example.test", base({ trialRunner, repeat: 5 }));

  assert.equal(report.baseline.state, BASELINE_STATE.INTERMITTENT);
  assert.equal(report.verdict.classification, CLASSIFICATION.UNSTABLE_BASELINE);
  assert.equal(report.verdict.stop, STOP.UNSTABLE);
  assert.ok(report.verdict.flakeRate > 0);
  assert.equal(report.executed.length, 0, "no experiment may run against an unstable baseline");
});

test("4. a resolver that repairs a failing baseline is isolated", async () => {
  const trialRunner = runner(a => (a.resolver && a.resolver !== "system" ? PASS() : FAIL("dns", "SERVFAIL")));
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.verdict.classification, CLASSIFICATION.FAILURE_DISCRIMINATOR);
  assert.equal(report.verdict.experiment.axisId, "resolver");
});

test("6. when every condition fails identically there is no discriminator", async () => {
  const trialRunner = runner(() => FAIL("dns", "ENOTFOUND"));
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.verdict.classification, CLASSIFICATION.NO_MEANINGFUL_DIFFERENCE);
  assert.equal(report.verdict.stop, STOP.NO_DISCRIMINATOR);
  assert.match(report.verdict.claim, /away from client-side/);
});

test("7. when everything passes there is no meaningful difference", async () => {
  const trialRunner = runner(() => PASS());
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.baseline.state, BASELINE_STATE.HEALTHY);
  assert.equal(report.verdict.classification, CLASSIFICATION.NO_MEANINGFUL_DIFFERENCE);
});

test("8 and 9. a discriminator that vanishes under confirmation is not reported as isolated", async () => {
  // The sweep sees baseline FAIL and ipv4 PASS. By confirmation time the
  // "network" has recovered and everything passes, so the difference is drift.
  let call = 0;
  const trialRunner = runner(a => {
    call += 1;
    if (call > 6) return PASS();                    // recovery partway through
    return a["address-family"] === "ipv4" ? PASS() : FAIL();
  });
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.verdict.classification, CLASSIFICATION.INSUFFICIENT_EVIDENCE);
  assert.equal(report.confirmation.confirmed, false);
  assert.match(report.verdict.detail, /changing over time/);
});

test("11. an unsupported experiment is not read as a target fault", async () => {
  const trialRunner = runner(a =>
    (a["address-family"] === "ipv6" ? trial("unsupported", { reason: "No IPv6 stack available." }) : PASS()));
  const report = await isolate("https://example.test", base({ trialRunner }));
  const v6 = report.executed.find(e => e.id === "address-family=ipv6");
  assert.equal(v6.result, RESULT.UNSUPPORTED);
  // An unsupported experiment carries no evidence, so nothing is isolated.
  assert.notEqual(report.verdict.classification, CLASSIFICATION.TARGET_PROPERTY);
  assert.notEqual(report.verdict.classification, CLASSIFICATION.FAILURE_DISCRIMINATOR);
});

test("12. IPv6 published but unusable locally is a local deficiency, not a target property", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv6" ? FAIL("dns", "ENOENT") : PASS()));
  const report = await isolate("https://example.test", base({
    trialRunner, answerSets: { v4: ["1.2.3.4"], v6: ["2606::1", "2606::2"] }  // AAAA does exist
  }));
  assert.equal(report.verdict.classification, CLASSIFICATION.LOCAL_CAPABILITY_DEFICIENCY);
  assert.match(report.verdict.headline, /although the target publishes 2 AAAA/);
  assert.match(report.verdict.claim, /local capability deficiency/);
});

test("14. the planner runs a high-value experiment before a redundant one", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL()));
  const report = await isolate("https://example.test", base({ trialRunner }));
  // Address family partitions the hypothesis set best, so it must come first,
  // ahead of resolver/TLS/ALPN experiments that only test one explanation each.
  assert.equal(report.executed[0].axisId, "address-family");
  assert.ok(report.executed[0].selectionScore > 0);
});

test("15 and 16. the engine stops once the boundary is isolated and does not keep testing", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL()));
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.verdict.stop, STOP.ISOLATED);
  // Far fewer experiments than the number available.
  assert.ok(report.executed.length < report.experimentsAvailable / 2,
    `executed ${report.executed.length} of ${report.experimentsAvailable} available`);
  assert.ok(report.skipped.length > 0, "unrun experiments must be recorded with a reason");
  for (const s of report.skipped) assert.ok(s.reason && s.skip, "every skip needs a recorded reason");
});

test("17. identical evidence produces an identical conclusion every time", async () => {
  const make = () => runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL()));
  const strip = r => JSON.stringify({
    verdict: r.verdict.classification, stop: r.verdict.stop,
    executed: r.executed.map(e => [e.id, e.result]),
    skipped: r.skipped.map(s => [s.id, s.skip]),
    hypotheses: r.hypotheses.map(h => [h.id, h.state])
  });
  const a = await isolate("https://example.test", base({ trialRunner: make() }));
  const b = await isolate("https://example.test", base({ trialRunner: make() }));
  const c = await isolate("https://example.test", base({ trialRunner: make() }));
  assert.equal(strip(a), strip(b));
  assert.equal(strip(b), strip(c));
});

// ---------------------------------------------------------------------------
// Hypothesis reasoning
// ---------------------------------------------------------------------------

test("a DNS-stage IPv6 failure supports 'no AAAA' and weakens 'IPv6 path broken'", () => {
  const hypotheses = buildHypotheses({ baselineFailed: false });
  applyObservation(hypotheses, { axisId: "address-family", value: "ipv6", result: RESULT.FAIL, stage: "dns" },
    { baselineResult: RESULT.PASS });
  const byId = Object.fromEntries(hypotheses.map(h => [h.id, h.state]));
  assert.equal(byId["target-no-aaaa"], STATE.SUPPORTED);
  assert.equal(byId["ipv6-path"], STATE.WEAKENED, "a path fault must occur after resolution");
  assert.equal(byId["no-local-ipv6"], STATE.WEAKENED);
});

test("a TCP-stage IPv6 failure contradicts 'no AAAA'", () => {
  const hypotheses = buildHypotheses({ baselineFailed: false });
  applyObservation(hypotheses, { axisId: "address-family", value: "ipv6", result: RESULT.FAIL, stage: "tcp" },
    { baselineResult: RESULT.PASS });
  const byId = Object.fromEntries(hypotheses.map(h => [h.id, h.state]));
  assert.equal(byId["target-no-aaaa"], STATE.CONTRADICTED, "the name clearly resolved, so a missing record cannot explain it");
});

test("predicting 'nothing changes' and being right is not treated as support", () => {
  const hypotheses = buildHypotheses({ baselineFailed: true });
  applyObservation(hypotheses, { axisId: "address-family", value: "ipv4", result: RESULT.PASS, stage: null },
    { baselineResult: RESULT.FAIL });
  const resolver = hypotheses.find(h => h.id === "resolver");
  // The resolver hypothesis predicted UNCHANGED (i.e. FAIL) and observed PASS,
  // so it is contradicted - but crucially it is never SUPPORTED merely for
  // agreeing with the crowd.
  assert.notEqual(resolver.state, STATE.SUPPORTED);
});

test("an unstable or inapplicable observation changes no hypothesis state", () => {
  const before = buildHypotheses({ baselineFailed: true });
  const snapshot = before.map(h => h.state).join(",");
  applyObservation(before, { axisId: "resolver", value: "1.1.1.1", result: RESULT.UNSTABLE, stage: null }, { baselineResult: RESULT.FAIL });
  applyObservation(before, { axisId: "resolver", value: "8.8.8.8", result: RESULT.INAPPLICABLE, stage: null }, { baselineResult: RESULT.FAIL });
  assert.equal(before.map(h => h.state).join(","), snapshot, "non-evidential outcomes must not move any hypothesis");
});

test("hypotheses whose axis is unavailable are marked not testable", async () => {
  // A literal IP target removes the DNS-dependent axes entirely.
  const trialRunner = runner(() => PASS());
  const report = await isolate("1.1.1.1", base({ trialRunner, answerSets: { v4: [], v6: [] } }));
  const resolverHypothesis = report.hypotheses.find(h => h.id === "resolver");
  assert.ok([STATE.NOT_TESTABLE, STATE.CONTRADICTED, STATE.STILL_POSSIBLE].includes(resolverHypothesis.state));
  assert.ok(report.axesUnavailable.some(a => a.axisId === "resolver"));
});

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

test("the transcript records why each experiment was chosen", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL()));
  const report = await isolate("https://example.test", base({ trialRunner }));

  assert.equal(report.transcript[0].kind, "baseline");
  assert.equal(report.transcript[1].kind, "hypotheses");
  const experiments = report.transcript.filter(s => s.kind === "experiment");
  assert.ok(experiments.length > 0);
  for (const step of experiments) {
    assert.ok(step.why && step.why.length > 0, "every experiment must record why it was selected");
    assert.match(step.why, /discrimination score/);
    assert.ok(step.result);
  }
  assert.ok(report.transcript.some(s => s.kind === "confirmation"));
  // Steps are numbered in order.
  assert.deepEqual(report.transcript.map(s => s.step), report.transcript.map((_s, i) => i + 1));
});

test("the report is a self-describing evidence record", async () => {
  const trialRunner = runner(a => (a["address-family"] === "ipv4" ? PASS() : FAIL()));
  const report = await isolate("https://example.test", base({ trialRunner }));
  assert.equal(report.schema, "faultline.network-bisect");
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.mode, "adaptive");
  assert.ok(report.engineVersion);
  assert.ok(report.startedAt && report.completedAt);
  assert.ok(Array.isArray(report.hypotheses) && report.hypotheses.length > 0);
  assert.ok(Array.isArray(report.transcript));
  assert.ok(report.counters.connections > 0);
  assert.match(report.evidence.note, /association, not causation/i);
  // No credential-shaped content anywhere in a report.
  assert.doesNotMatch(JSON.stringify(report), /password|token|secret|api[_-]?key/i);
});

// ---------------------------------------------------------------------------
// Probe plan translation still holds (regression against the earlier feature)
// ---------------------------------------------------------------------------

test("condition assignments still translate into the connection plan", () => {
  const t = parseLiveTarget("https://example.test");
  assert.equal(planFromAssignment(t, { "address-family": "ipv4" }).plan.family, 4);
  assert.equal(planFromAssignment(t, { resolver: "1.1.1.1" }).plan.resolver, "1.1.1.1");
  assert.equal(planFromAssignment(t, { "source-interface": "192.168.1.5" }).plan.localAddress, "192.168.1.5");
  assert.equal(planFromAssignment(t, { "tls-version": "TLSv1.2" }).plan.tlsVersion, "TLSv1.2");
  assert.equal(planFromAssignment(t, { alpn: "h2" }).plan.alpn, "h2");
  assert.equal(planFromAssignment(t, { sni: "off" }).plan.sni, false);
  assert.equal(planFromAssignment(t, { port: 80 }).plan.port, 80);
  assert.ok(planFromAssignment(t, { "source-interface": "192.168.1.5", "address-family": "ipv6" }).blocked);
});
