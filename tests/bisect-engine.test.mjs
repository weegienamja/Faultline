import test from "node:test";
import assert from "node:assert/strict";
import {
  bisect,
  collapseDiscriminators,
  confirmPaired,
  evaluateCondition,
  OUTCOME
} from "../src/bisect/engine.mjs";
import { baselineAssignment, buildConditionSpace, effectiveTuple, variantAssignment } from "../src/bisect/conditions.mjs";
import { planFromAssignment, STAGE } from "../src/bisect/probe.mjs";
import { parseLiveTarget } from "../src/live/measure.mjs";

// The bisection algorithm is tested with an injected trial runner, so these
// tests are fully deterministic and never touch the network.

const TARGET = parseLiveTarget("https://example.test");

function runner(decide) {
  const calls = [];
  const fn = async (_target, assignment) => {
    calls.push({ ...assignment });
    return decide(assignment, calls.length);
  };
  fn.calls = calls;
  return fn;
}

// Fakes return the same connection plan the real probe would build, so the
// engine's duplicate-collapsing sees realistic effective tuples.
const planFor = assignment => planFromAssignment(TARGET, assignment || {}).plan || {};
const pass = (reason = "HTTP 200") => assignment => ({ verdict: "pass", stage: null, reason, stages: {}, plan: planFor(assignment) });
const fail = (stage = STAGE.TCP, reason = "timeout") => assignment => ({ verdict: "fail", stage, reason, stages: {}, plan: planFor(assignment) });

// ---------------------------------------------------------------------------
// Condition space
// ---------------------------------------------------------------------------

test("condition space only offers axes that apply to the target", () => {
  const https = buildConditionSpace(parseLiveTarget("https://example.test"), { resolvedAddresses: { v4: [], v6: [] } });
  const ids = https.map(a => a.id);
  assert.ok(ids.includes("address-family"));
  assert.ok(ids.includes("resolver"));
  assert.ok(ids.includes("tls-version"));
  assert.ok(ids.includes("sni"));

  // A literal IP needs neither DNS nor address-family selection.
  const literal = buildConditionSpace(parseLiveTarget("1.1.1.1"), { resolvedAddresses: { v4: [], v6: [] } });
  const literalIds = literal.map(a => a.id);
  assert.equal(literalIds.includes("address-family"), false);
  assert.equal(literalIds.includes("resolver"), false);

  // A plain HTTP target has no TLS axes.
  const plain = buildConditionSpace(parseLiveTarget("http://example.test"), { resolvedAddresses: { v4: [], v6: [] } });
  const plainIds = plain.map(a => a.id);
  assert.equal(plainIds.includes("tls-version"), false);
  assert.equal(plainIds.includes("sni"), false);
});

test("the specific-address axis only appears when there is more than one answer", () => {
  const one = buildConditionSpace(TARGET, { resolvedAddresses: { v4: ["1.2.3.4"], v6: [] } });
  assert.equal(one.some(a => a.id === "address"), false);
  const many = buildConditionSpace(TARGET, { resolvedAddresses: { v4: ["1.2.3.4", "5.6.7.8"], v6: [] } });
  assert.equal(many.some(a => a.id === "address"), true);
});

test("a variant assignment changes exactly one axis", () => {
  const axes = buildConditionSpace(TARGET, { resolvedAddresses: { v4: [], v6: [] } });
  const base = baselineAssignment(axes);
  const variant = variantAssignment(axes, "address-family", "ipv6");
  const changed = Object.keys(variant).filter(key => variant[key] !== base[key]);
  assert.deepEqual(changed, ["address-family"], "single-factor trials are what make a difference attributable");
});

// ---------------------------------------------------------------------------
// Plan translation — each condition must reach the connection
// ---------------------------------------------------------------------------

test("each condition translates into the connection plan", () => {
  const t = parseLiveTarget("https://example.test");
  assert.equal(planFromAssignment(t, { "address-family": "ipv4" }).plan.family, 4);
  assert.equal(planFromAssignment(t, { "address-family": "ipv6" }).plan.family, 6);
  assert.equal(planFromAssignment(t, { resolver: "1.1.1.1" }).plan.resolver, "1.1.1.1");
  assert.equal(planFromAssignment(t, { resolver: "system" }).plan.resolver, null);
  assert.equal(planFromAssignment(t, { "source-interface": "192.168.1.5" }).plan.localAddress, "192.168.1.5");
  assert.equal(planFromAssignment(t, { "tls-version": "TLSv1.2" }).plan.tlsVersion, "TLSv1.2");
  assert.equal(planFromAssignment(t, { alpn: "h2" }).plan.alpn, "h2");
  assert.equal(planFromAssignment(t, { sni: "off" }).plan.sni, false);
  assert.equal(planFromAssignment(t, { port: 80 }).plan.port, 80);
  assert.equal(planFromAssignment(t, { port: 80 }).plan.scheme, "http");

  // Pinning an address also pins its family.
  const pinned = planFromAssignment(t, { address: "2606:4700::1" }).plan;
  assert.equal(pinned.address, "2606:4700::1");
  assert.equal(pinned.family, 6);
});

test("an impossible combination is reported as inapplicable, not as a network failure", () => {
  const blocked = planFromAssignment(TARGET, { "source-interface": "192.168.1.5", "address-family": "ipv6" });
  assert.ok(blocked.blocked, "binding an IPv4 source to an IPv6 connection cannot be attempted");
  assert.match(blocked.blocked, /IPv4 source interface/);
});

test("baseline plan applies no overrides at all", () => {
  const { plan } = planFromAssignment(TARGET, { "address-family": "auto", resolver: "system", sni: "on", "tls-version": "auto", alpn: "auto" });
  assert.equal(plan.family, null);
  assert.equal(plan.resolver, null);
  assert.equal(plan.tlsVersion, null);
  assert.equal(plan.alpn, null);
  assert.equal(plan.sni, true);
  assert.equal(plan.localAddress, null);
});

// ---------------------------------------------------------------------------
// Reproducibility gating
// ---------------------------------------------------------------------------

test("a condition is only pass or fail when every trial agrees", async () => {
  const allPass = await evaluateCondition(TARGET, {}, { repeat: 3, trialRunner: runner(a => pass()(a)) });
  assert.equal(allPass.outcome, OUTCOME.PASS);
  assert.equal(allPass.passes, 3);

  const allFail = await evaluateCondition(TARGET, {}, { repeat: 3, trialRunner: runner(a => fail()(a)) });
  assert.equal(allFail.outcome, OUTCOME.FAIL);

  let n = 0;
  const mixed = await evaluateCondition(TARGET, {}, { repeat: 3, trialRunner: runner(a => (n++ % 2 ? pass()(a) : fail()(a))) });
  assert.equal(mixed.outcome, OUTCOME.FLAKY, "a mixed result must never be treated as a clean signal");
  assert.ok(mixed.flakeRate > 0);
});

test("an inapplicable condition is not retried", async () => {
  const r = runner(() => ({ verdict: "inapplicable", stage: null, reason: "cannot apply", stages: {}, plan: null }));
  const result = await evaluateCondition(TARGET, {}, { repeat: 5, trialRunner: r });
  assert.equal(result.outcome, OUTCOME.INAPPLICABLE);
  assert.equal(r.calls.length, 1, "an inapplicable condition cannot become applicable on retry");
});

test("bisection refuses to run on an intermittent baseline", async () => {
  // Baseline alternates pass/fail; every variant passes. A naive tool would
  // confidently report the first variant as the fix.
  let baselineCall = 0;
  const trialRunner = async (_t, assignment) => {
    const isBaseline = assignment["address-family"] === "auto" && assignment.resolver === "system" && assignment.sni === "on";
    if (isBaseline) return (baselineCall++ % 2 === 0) ? fail()(assignment) : pass()(assignment);
    return pass()(assignment);
  };

  const report = await bisect("https://example.test", {
    repeat: 4, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });

  assert.equal(report.verdict.kind, "intermittent");
  assert.match(report.verdict.headline, /bisection refused/i);
  assert.equal(report.discriminators.length, 0, "no condition may be blamed when the baseline itself is unstable");
  assert.ok(report.verdict.flakeRate > 0);
});

// ---------------------------------------------------------------------------
// Duplicate collapsing
// ---------------------------------------------------------------------------

test("discriminators producing the same connection collapse to one finding", () => {
  const collapsed = collapseDiscriminators([
    { axisId: "address", axisLabel: "Specific resolved address", label: "address 1.2.3.4", tuple: "4|1.2.3.4|auto|443|auto|auto|sni" },
    { axisId: "address-family", axisLabel: "IP address family", label: "IPv4 only", tuple: "4|1.2.3.4|auto|443|auto|auto|sni" },
    { axisId: "resolver", axisLabel: "DNS resolver", label: "resolver 8.8.8.8", tuple: "auto|9.9.9.9|auto|443|auto|auto|sni" }
  ]);
  assert.equal(collapsed.length, 2, "two distinct connections, not three findings");
  const primary = collapsed.find(c => c.tuple.startsWith("4|"));
  assert.equal(primary.axisId, "address-family", "the more general axis is preferred as the explanation");
  assert.equal(primary.equivalentTo.length, 1);
  assert.equal(primary.equivalentTo[0].axisId, "address");
});

// ---------------------------------------------------------------------------
// Interleaved paired confirmation
// ---------------------------------------------------------------------------

test("paired confirmation accepts a genuine difference", async () => {
  const trialRunner = async (_t, assignment) => (assignment.flip === "yes" ? pass()(assignment) : fail()(assignment));
  const result = await confirmPaired(TARGET, { flip: "no" }, { flip: "yes" }, { pairs: 3, trialRunner });
  assert.equal(result.confirmed, true);
  assert.equal(result.direction, "variant-fixes");
  assert.equal(result.sequence.length, 6);
});

test("paired confirmation rejects a difference that is really time drift", async () => {
  // The network "recovers" partway through: everything passes from call 4 on.
  // Sequential testing would credit whichever variant ran later; interleaving
  // exposes it because the baseline arm also starts passing.
  let call = 0;
  const trialRunner = async (_t, assignment) => (++call <= 3 ? fail()(assignment) : pass()(assignment));
  const result = await confirmPaired(TARGET, { a: 1 }, { b: 2 }, { pairs: 3, trialRunner });
  assert.equal(result.confirmed, false, "a drifting network must not be reported as a confirmed condition");
  assert.equal(result.direction, "inconsistent");
});

test("a sweep discriminator that fails paired confirmation is reported as unstable", async () => {
  let call = 0;
  const trialRunner = async (_t, assignment) => {
    call += 1;
    const isBaseline = assignment["address-family"] === "auto";
    // During the sweep the baseline fails and ipv4 passes. During confirmation
    // (later calls) everything passes, i.e. the network recovered.
    if (call > 12) return pass()(assignment);
    if (isBaseline) return fail()(assignment);
    return assignment["address-family"] === "ipv4" ? pass()(assignment) : fail()(assignment);
  };

  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 3, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });
  assert.equal(report.verdict.kind, "unstable");
  assert.match(report.verdict.detail, /interleaved A\/B/);
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

test("isolates the single condition that fixes a failing baseline", async () => {
  const trialRunner = async (_t, assignment) => (assignment["address-family"] === "ipv4" ? pass()(assignment) : fail(STAGE.TCP, "ETIMEDOUT")(assignment));
  const report = await bisect("https://example.test", {
    repeat: 3, confirmPairs: 3, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: ["2606::1"] }, includeSourceInterface: false
  });

  assert.equal(report.verdict.kind, "isolated");
  assert.equal(report.discriminators[0].axisId, "address-family");
  assert.equal(report.discriminators[0].value, "ipv4");
  assert.equal(report.confirmation.confirmed, true);
  // Wording must claim association, never causation.
  assert.match(report.verdict.claim, /Evidence supports/);
  assert.doesNotMatch(JSON.stringify(report.verdict), /caused by|root cause|proves/i);
});

test("reports a failure that no condition changes as not condition-specific", async () => {
  const trialRunner = async (_t, assignment) => fail(STAGE.DNS, "ENOTFOUND")(assignment);
  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });
  assert.equal(report.verdict.kind, "unconditional");
  assert.equal(report.discriminators.length, 0);
  assert.match(report.verdict.detail, /dns/);
});

test("reports a healthy target when nothing fails", async () => {
  const trialRunner = async (_t, assignment) => pass()(assignment);
  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });
  assert.equal(report.verdict.kind, "healthy");
});

test("a missing AAAA record is reported as a target property, not a local fault", async () => {
  // Baseline passes over IPv4; forcing IPv6 fails at DNS with ENODATA.
  const trialRunner = async (_t, assignment) =>
    (assignment["address-family"] === "ipv6" ? fail(STAGE.DNS, "ENODATA")(assignment) : pass()(assignment));

  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });

  assert.equal(report.verdict.kind, "not-published");
  assert.match(report.verdict.claim, /publishes no AAAA record/);
  assert.match(report.verdict.claim, /not a local network fault/i);
});

test("a broken IPv6 path is NOT classified as a missing record", async () => {
  // AAAA resolves; the failure happens at TCP. This is a real local fault.
  const trialRunner = async (_t, assignment) =>
    (assignment["address-family"] === "ipv6" ? fail(STAGE.TCP, "ENETUNREACH")(assignment) : pass()(assignment));

  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: ["2606::1"] }, includeSourceInterface: false
  });

  assert.equal(report.verdict.kind, "isolated");
  assert.match(report.verdict.detail, /ENETUNREACH/);
});

// ---------------------------------------------------------------------------
// Report shape and evidence discipline
// ---------------------------------------------------------------------------

test("the report is a complete, self-describing evidence record", async () => {
  const trialRunner = async (_t, assignment) => (assignment["address-family"] === "ipv4" ? pass()(assignment) : fail()(assignment));
  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: ["2606::1"] }, includeSourceInterface: false
  });

  assert.equal(report.schema, "faultline.network-bisect");
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.startedAt && report.completedAt);
  assert.ok(report.trialCount > 0);
  assert.ok(Array.isArray(report.conditions) && report.conditions.length > 1);
  assert.equal(report.conditions[0].axisId, "__baseline__");
  // Every row carries its own evidence: outcome, sample size and reason.
  for (const row of report.conditions) {
    assert.ok(["pass", "fail", "flaky", "inapplicable"].includes(row.outcome));
    assert.equal(typeof row.total, "number");
  }
  assert.match(report.evidence.note, /association, not causation/i);
});

test("expected differences never outrank a real finding", async () => {
  // Both "no SNI" and a genuine IPv4/IPv6 split differ from baseline.
  const trialRunner = async (_t, assignment) => {
    if (assignment.sni === "off") return fail(STAGE.TLS, "handshake")(assignment);
    if (assignment["address-family"] === "ipv6") return fail(STAGE.TCP, "ENETUNREACH")(assignment);
    return pass()(assignment);
  };
  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: ["2606::1"] }, includeSourceInterface: false
  });
  assert.equal(report.discriminators[0].axisId, "address-family", "SNI must not win over a real fault");
  assert.ok(report.verdict.expectedDifferences.some(x => /SNI/i.test(x)));
});

test("effective tuples distinguish genuinely different connections", () => {
  const a = effectiveTuple({ family: 4, address: "1.2.3.4", port: 443 });
  const b = effectiveTuple({ family: 6, address: "2606::1", port: 443 });
  const c = effectiveTuple({ family: 4, address: "1.2.3.4", port: 443 });
  assert.notEqual(a, b);
  assert.equal(a, c);
});

// ---------------------------------------------------------------------------
// Correctness fixes found by running the tool against real servers
// ---------------------------------------------------------------------------

test("the source-interface axis is not offered for a loopback target", () => {
  // Binding a LAN source address to 127.0.0.1 can never work, so offering it
  // would manufacture a false discriminator.
  for (const host of ["https://127.0.0.1:8443/", "http://localhost:8080/"]) {
    const axes = buildConditionSpace(parseLiveTarget(host), { resolvedAddresses: { v4: [], v6: [] } });
    assert.equal(axes.some(a => a.id === "source-interface"), false, host);
  }
  // It is still offered for an ordinary target (when more than one source exists).
  const axes = buildConditionSpace(parseLiveTarget("https://example.test"), { resolvedAddresses: { v4: [], v6: [] } });
  assert.ok(axes.every(a => a.id !== "source-interface") || axes.some(a => a.id === "source-interface"));
});

test("an unusable source binding is inapplicable, never a discriminator", async () => {
  // EADDRNOTAVAIL means the kernel refused the source for this destination.
  // Treating it as a failure would blame the network for a scope mismatch.
  const trialRunner = async (_t, assignment) => {
    if (assignment["source-interface"] && assignment["source-interface"] !== "auto") {
      return { verdict: "inapplicable", stage: null, reason: "Source cannot originate to this destination.", stages: {}, plan: {} };
    }
    return pass()(assignment);
  };
  const report = await bisect("https://example.test", {
    repeat: 2, confirmPairs: 2, trialRunner,
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: true
  });
  assert.equal(report.discriminators.length, 0);
  assert.equal(report.verdict.kind, "healthy");
  const inapplicable = report.conditions.filter(c => c.outcome === "inapplicable");
  for (const row of inapplicable) assert.equal(row.passes, 0);
});

test("an explicit resolver is queried directly and never falls back to the system path", async () => {
  // If a chosen resolver could silently fall back to the OS resolver, the
  // resolver axis would be meaningless.
  const seen = [];
  const trialRunner = async (_t, assignment) => {
    seen.push(assignment.resolver);
    return pass()(assignment);
  };
  await bisect("https://example.test", {
    repeat: 1, confirmPairs: 1, trialRunner, resolvers: ["9.9.9.9"],
    answerSets: { v4: ["1.2.3.4"], v6: [] }, includeSourceInterface: false
  });
  assert.ok(seen.includes("9.9.9.9"), "the requested resolver must reach the trial");
  assert.ok(seen.includes("system"), "the baseline must use the system path");
});
