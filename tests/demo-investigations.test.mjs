// Recorded demo investigations.
//
// The claim these make is strong: that the hosted demo demonstrates the
// endpoint half of Faultline by running the PRODUCTION engines over recorded
// evidence, rather than by shipping a hand-written result. These tests hold
// that claim to account from both directions:
//
//   1. the engines really did run - a real incident record, real candidate
//      discriminators, a real adaptive isolation run with a real verdict;
//   2. nothing anywhere claims to be a measurement. Provenance has to survive
//      every hop: sample -> incident -> attachment -> capsule -> API payload.

import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_INCIDENTS, findDemoIncident } from "../src/demo/catalogue.mjs";
import { getInvestigation, listInvestigations, projectInvestigation } from "../src/demo/investigations.mjs";
import { createScriptedTrialRunner } from "../src/demo/replay.mjs";
import { parseLiveTarget } from "../src/live/measure.mjs";

test("the catalogue advertises three recorded investigations", () => {
  assert.equal(DEMO_INCIDENTS.length, 3);
  const slugs = DEMO_INCIDENTS.map(entry => entry.slug);
  assert.deepEqual(slugs, ["ipv6-path-failure", "dns-resolver-disagreement", "vpn-routing-regression"]);

  for (const entry of DEMO_INCIDENTS) {
    assert.match(entry.id, /^FLR-DEMO-[A-Z0-9]+$/);
    assert.ok(entry.whyRecorded.length > 40, "each must say why it is recorded rather than measured");
    for (const step of ["capture", "isolate", "explain", "preserve"]) {
      assert.ok(entry.story[step], `${entry.slug} is missing the ${step} step`);
    }
  }

  assert.equal(findDemoIncident("ipv6-path-failure")?.id, "FLR-DEMO-IPV6");
  assert.equal(findDemoIncident("FLR-DEMO-VPN")?.slug, "vpn-routing-regression");
  assert.equal(findDemoIncident("nope"), null);
});

test("the listing carries the recorded-evidence notice without replaying anything", () => {
  for (const entry of listInvestigations()) {
    assert.equal(entry.notice.evidenceClass, "simulated");
    assert.equal(entry.notice.label, "RECORDED DEMO INCIDENT");
  }
});

test("each investigation is built by the production recorder and marked simulated", async t => {
  for (const entry of DEMO_INCIDENTS) {
    await t.test(entry.slug, async () => {
      const investigation = await getInvestigation(entry.slug);
      const incident = investigation.incident;

      // Built by buildIncident(), which derives provenance from the samples.
      assert.equal(incident.schema, "faultline.flight-recorder-incident");
      assert.equal(incident.simulated, true);
      assert.equal(incident.source, "simulation");
      assert.equal(incident.evidenceClass, "simulated");
      assert.equal(incident.scenario, entry.scenario);
      assert.equal(incident.id, entry.id);
      assert.match(incident.epistemics.observed, /^SIMULATED/);

      // A real capture: a healthy window to compare against, a trigger, a
      // failing window, and a recovery.
      assert.ok(incident.windows.before.samples.length >= 5, "needs a healthy window");
      assert.ok(incident.windows.during.samples.length >= 5, "needs a failing window");
      assert.ok(incident.windows.after.samples.length >= 1, "needs an after window");
      assert.equal(incident.trigger.type, "TARGET_REACHABILITY_TRANSITION");
      assert.ok(incident.observedChange.comparable);
      assert.ok(incident.observedChange.recovery, "every demo must recover, so AFTER means something");

      // Every sample carries its own provenance.
      const all = [
        ...incident.windows.before.samples,
        ...incident.windows.during.samples,
        ...incident.windows.after.samples
      ];
      for (const sample of all) {
        assert.equal(sample.simulated, true);
        assert.equal(sample.source, "simulation");
        assert.equal(sample.scenario, entry.scenario);
      }

      // The recorder observed; it did not conclude.
      assert.equal(incident.observedChange.classification, "temporal_association");
      assert.doesNotMatch(incident.observedChange.statement, /\bcaused\b/i);
    });
  }
});

test("each investigation runs the real isolation engine to a confirmed verdict", async t => {
  const expected = {
    "ipv6-path-failure": { axis: "address-family", headline: /IPv4 only changes FAIL to PASS/ },
    "dns-resolver-disagreement": { axis: "resolver", headline: /resolver .* changes FAIL to PASS/ },
    "vpn-routing-regression": { axis: "source-interface", headline: /via Ethernet .* changes FAIL to PASS/ }
  };

  for (const entry of DEMO_INCIDENTS) {
    await t.test(entry.slug, async () => {
      const { bisect, attachment } = await getInvestigation(entry.slug);
      assert.ok(bisect, "a testable condition must produce an isolation run");

      assert.equal(bisect.schema, "faultline.network-bisect");
      assert.equal(bisect.mode, "adaptive");
      assert.equal(bisect.baseline.state, "FAILED_BASELINE");
      assert.equal(bisect.verdict.classification, "FAILURE_DISCRIMINATOR");
      assert.equal(bisect.confirmation.confirmed, true);
      assert.equal(bisect.confirmation.direction, "variant-repairs");
      assert.ok(bisect.transcript.length >= 4, "the reasoning transcript must be present");

      const { axis, headline } = expected[entry.slug];
      assert.equal(bisect.verdict.experiment.axisId, axis);
      assert.match(bisect.verdict.headline, headline);

      // The replay is never presented as a measurement.
      assert.equal(bisect.simulated, true);
      assert.equal(bisect.evidenceClass, "simulated");
      assert.match(bisect.evidence.observed, /^REPLAYED/);
      assert.doesNotMatch(bisect.evidence.observed, /real connection/i);

      assert.equal(attachment.simulated, true);
      assert.equal(attachment.evidenceClass, "simulated");
      assert.equal(attachment.source, "replay");
      assert.match(attachment.epistemics.relationToIncident, /Neither is a measurement/);
      assert.match(attachment.epistemics.limit, /association, not cause/i);
    });
  }
});

test("the exported capsule preserves provenance end to end", async () => {
  const investigation = await getInvestigation("vpn-routing-regression");
  const capsule = investigation.capsule;

  assert.equal(capsule.incident.simulated, true);
  assert.equal(capsule.incident.evidenceClass, "simulated");
  assert.equal(capsule.incident.source, "simulation");
  assert.ok(capsule.integrity?.digest, "a capsule must be integrity-tagged");
  assert.equal(capsule.integrity.algorithm, "sha256");
  assert.match(investigation.capsuleFilename, /^faultline-FLR-DEMO-VPN\.html$/);
});

test("a replay is deterministic and cached, so every visitor sees the same record", async () => {
  const first = await getInvestigation("ipv6-path-failure");
  const second = await getInvestigation("FLR-DEMO-IPV6");
  assert.equal(first, second, "the same investigation must be reused, not rebuilt");
  assert.equal(first.incident.trigger.at, second.incident.trigger.at);
  assert.equal(first.capsule.integrity.digest, second.capsule.integrity.digest);
});

test("concurrent first requests share one build", async () => {
  const [a, b, c] = await Promise.all([
    getInvestigation("dns-resolver-disagreement"),
    getInvestigation("dns-resolver-disagreement"),
    getInvestigation("dns-resolver-disagreement")
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
});

test("an unknown investigation is a 404, not a crash", async () => {
  await assert.rejects(() => getInvestigation("does-not-exist"), error => error.statusCode === 404);
});

test("the browser projection stays honest and bounded", async () => {
  const view = projectInvestigation(await getInvestigation("dns-resolver-disagreement"));

  assert.equal(view.notice.evidenceClass, "simulated");
  assert.equal(view.isolate.available, true);
  assert.equal(view.isolate.evidenceClass, "simulated");
  assert.ok(view.capture.timeline.length >= 10);
  assert.ok(view.capture.windows.before.count > 0);
  assert.ok(view.capture.recovery, "recovery must be projected so AFTER can be drawn");

  // The resolver demo's whole point: DNS keeps succeeding while the ANSWER
  // changes, so a pass/fail DNS check would call it healthy.
  const failing = view.capture.timeline.filter(row => row.window === "during");
  assert.ok(failing.length > 0);
  assert.ok(failing.every(row => row.dns === "PASS"), "DNS must keep passing during the fault");
  assert.ok(failing.every(row => row.targetTcp === "FAIL"));
  const answers = new Set(view.capture.timeline.map(row => row.resolvedAddress));
  assert.ok(answers.size >= 2, "the resolved answer must be seen to change");

  // The Analyst is absent and said to be absent, and the deterministic engine
  // still produced the finding.
  assert.ok(view.explain.deterministic.headline);
  assert.match(view.explain.limit, /association under a controlled variation, not proof of cause/i);

  // Full sample objects are not shipped to the browser.
  assert.equal("samples" in view.capture, false);
  assert.equal(view.capture.windows.before.samples, undefined);
});

test("the scripted trial runner cannot see anything but the connection plan", async () => {
  const seen = [];
  const runner = createScriptedTrialRunner(plan => {
    seen.push(plan);
    return { verdict: "pass" };
  });

  const target = parseLiveTarget("https://example.com/");
  const trial = await runner(target, { "address-family": "ipv4" }, { timeoutMs: 1_000 });

  assert.equal(trial.verdict, "pass");
  assert.equal(trial.stage, null);
  assert.equal(seen.length, 1);
  // The plan is the production one, built by planFromAssignment.
  assert.equal(seen[0].family, 4);
  assert.equal(seen[0].host, "example.com");
  assert.equal(seen[0].port, 443);
  // No hypothesis, score, experiment id or engine state reaches the world model.
  for (const key of ["hypotheses", "experiment", "score", "axisId", "baseline"]) {
    assert.equal(key in seen[0], false, `${key} must not be visible to the scripted world`);
  }
});

test("a blocked plan is inapplicable rather than a failure", async () => {
  const runner = createScriptedTrialRunner(() => ({ verdict: "pass" }));
  const target = parseLiveTarget("https://example.com/");
  // Binding an IPv4 source to an IPv6-only connection cannot work, and must not
  // be scored as evidence about the network.
  const trial = await runner(target, { "address-family": "ipv6", "source-interface": "192.168.1.24" }, {});
  assert.equal(trial.verdict, "inapplicable");
  assert.equal(trial.plan, null);
});
