// Adaptive isolation run.
//
// Sequence: establish the baseline, decide what kind of run this is, form the
// competing explanations, then loop { plan → run → observe → update → decide }
// until a stopping rule fires. Every decision is recorded in a transcript so
// the run can be read back as reasoning rather than as a table of results.

import { runTrial } from "./probe.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { interfacesForTarget, ROUTE } from "./interfaces.mjs";
import { buildExperiments } from "./experiments.mjs";
import { planNext, SKIP } from "./planner.mjs";
import {
  applyObservation, buildHypotheses, live, markUntestable, STATE
} from "./hypotheses.mjs";
import {
  BASELINE_STATE, CLASSIFICATION, RESULT, STOP,
  baselineStateFrom, classifyTrials, isEvidential, transition
} from "./results.mjs";
import { Resolver } from "node:dns/promises";

const ENGINE_VERSION = "1.0";

/** Run one condition `repeat` times and classify the set. */
async function evaluate(target, assignment, { repeat, timeoutMs, trialRunner, counters }) {
  const trials = [];
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const trial = await trialRunner(target, assignment, { timeoutMs });
    counters.connections += 1;
    trials.push(trial);
    // A condition that cannot be applied will not become applicable on retry.
    if (trial.verdict === "inapplicable" || trial.verdict === "unsupported") break;
  }
  const classified = classifyTrials(trials);
  const stages = [...new Set(trials.filter(t => t.stage).map(t => t.stage))];
  const reasons = [...new Set(trials.map(t => t.reason).filter(Boolean))];
  return {
    ...classified,
    trials,
    stage: stages.length ? stages[0] : null,
    reason: reasons[0] || null,
    plan: trials[0]?.plan || {}
  };
}

/** Interleaved A/B/A/B confirmation; drift shows up as an inconsistent pattern. */
async function confirm(target, baselineAssignment, variantAssignment, { pairs, timeoutMs, trialRunner, counters }) {
  const sequence = [];
  for (let index = 0; index < pairs; index += 1) {
    const a = await trialRunner(target, baselineAssignment, { timeoutMs });
    counters.connections += 1;
    sequence.push({ arm: "baseline", verdict: a.verdict, stage: a.stage, reason: a.reason });
    const b = await trialRunner(target, variantAssignment, { timeoutMs });
    counters.connections += 1;
    sequence.push({ arm: "variant", verdict: b.verdict, stage: b.stage, reason: b.reason });
  }
  const baseArm = sequence.filter(s => s.arm === "baseline");
  const varArm = sequence.filter(s => s.arm === "variant");
  const baseAllFail = baseArm.every(s => s.verdict === "fail");
  const baseAllPass = baseArm.every(s => s.verdict === "pass");
  const varAllPass = varArm.every(s => s.verdict === "pass");
  const varAllFail = varArm.every(s => s.verdict === "fail");

  return {
    pairs, sequence,
    confirmed: (baseAllFail && varAllPass) || (baseAllPass && varAllFail),
    direction: baseAllFail && varAllPass ? "variant-repairs"
      : baseAllPass && varAllFail ? "variant-breaks" : "inconsistent",
    baselinePasses: baseArm.filter(s => s.verdict === "pass").length,
    variantPasses: varArm.filter(s => s.verdict === "pass").length
  };
}

async function resolveAnswers(host, timeoutMs) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const answers = { v4: [], v6: [] };
  try { answers.v4 = await resolver.resolve4(host); } catch { /* no A */ }
  try { answers.v6 = await resolver.resolve6(host); } catch { /* no AAAA */ }
  return answers;
}

function assignmentFor(experiment) {
  const assignment = {};
  if (experiment) {
    assignment[experiment.axisId] = experiment.value;
    if (experiment.stopAt) assignment.__stopAt = experiment.stopAt;
  }
  return assignment;
}

/**
 * Decide what a confirmed difference means, given what the baseline was doing.
 * This is where a healthy baseline stops being described as a fault.
 */
function classifyFinding({ baselineState, experiment, observation, answers }) {
  const dir = transition(
    baselineState === BASELINE_STATE.FAILED ? RESULT.FAIL : RESULT.PASS,
    observation.result
  );

  if (baselineState === BASELINE_STATE.FAILED && dir === "fail-to-pass") {
    return {
      classification: CLASSIFICATION.FAILURE_DISCRIMINATOR,
      stop: STOP.ISOLATED,
      headline: `${experiment.axisLabel}: ${experiment.label} changes FAIL to PASS`,
      claim: `Evidence supports a fault specific to ${experiment.axisLabel.toLowerCase()}. Changing only that condition reproducibly restores the connection.`,
      workaround: `Forcing ${experiment.label} is a candidate workaround while the underlying cause is investigated.`
    };
  }

  if (baselineState === BASELINE_STATE.HEALTHY && dir === "pass-to-fail") {
    // A healthy baseline means nothing is broken. A condition that fails is a
    // capability difference; which kind depends on where it failed.
    if (experiment.axisId === "address-family") {
      // A DNS-stage failure alone does not say whose problem it is. The
      // authoritative question is whether the record exists at all, answered by
      // a direct DNS query that does not depend on local IPv6 capability:
      //
      //   record absent  -> the target does not offer that family
      //   record present -> the target offers it and this machine cannot use it
      //
      // Windows returns ENOENT/ENODATA from getaddrinfo for a AAAA lookup when
      // the host has no usable IPv6 source address, so the stage alone would
      // wrongly blame the target.
      const family = experiment.value === "ipv6" ? "AAAA" : "A";
      const published = experiment.value === "ipv6" ? answers.v6.length : answers.v4.length;

      if (published === 0) {
        return {
          classification: CLASSIFICATION.TARGET_PROPERTY,
          stop: STOP.TARGET_PROPERTY,
          headline: `${experiment.label} is unavailable because the target publishes no ${family} record`,
          claim: "Evidence supports a target property, not a local fault. Normal connectivity is unaffected.",
          recommendation: "Nothing to fix locally. A dual-stack client uses the other family automatically."
        };
      }
      return {
        classification: CLASSIFICATION.LOCAL_CAPABILITY_DEFICIENCY,
        stop: STOP.ISOLATED,
        headline: `${experiment.label} fails although the target publishes ${published} ${family} record(s)`,
        claim: `Evidence supports a local capability deficiency: the target offers ${family}, but this machine could not complete an ${experiment.value.toUpperCase()} connection to it.`,
        recommendation: "Normal dual-stack connectivity is unaffected, so this is not an active outage. It matters for hosts or networks that are IPv6-only."
      };
    }
    if (experiment.expectedDifference) {
      return {
        classification: CLASSIFICATION.TARGET_PROPERTY,
        stop: STOP.TARGET_PROPERTY,
        headline: `${experiment.axisLabel}: ${experiment.label} differs by design`,
        claim: "This difference is expected behaviour for this kind of endpoint and is not evidence of a fault."
      };
    }
    return {
      classification: CLASSIFICATION.LOCAL_CAPABILITY_DEFICIENCY,
      stop: STOP.ISOLATED,
      headline: `${experiment.axisLabel}: ${experiment.label} fails while normal connectivity is healthy`,
      claim: `Evidence supports a capability difference under ${experiment.axisLabel.toLowerCase()}. Normal connectivity is unaffected, so this is not an active outage.`
    };
  }

  return {
    classification: CLASSIFICATION.INSUFFICIENT_EVIDENCE,
    stop: STOP.INSUFFICIENT_EVIDENCE,
    headline: "The observed difference could not be classified",
    claim: "The evidence does not support a specific conclusion."
  };
}

/**
 * Adaptive isolation.
 */
export async function isolate(targetInput, {
  repeat = 3,
  confirmPairs = 3,
  timeoutMs = 5_000,
  maxExperiments = 12,
  resolvers = ["1.1.1.1", "8.8.8.8", "9.9.9.9"],
  trialRunner = runTrial,
  interfaceModel = null,
  answerSets = null,
  axes = null,
  onProgress = null
} = {}) {
  const startedAt = new Date().toISOString();
  const target = parseLiveTarget(targetInput);
  const report = event => { if (onProgress) onProgress(event); };
  const counters = { connections: 0, executed: 0, skipped: 0, inapplicable: 0 };
  const transcript = [];

  const answers = answerSets || (target.isLiteralIp ? { v4: [], v6: [] } : await resolveAnswers(target.host, timeoutMs));
  const probeAddress = answers.v4[0] || answers.v6[0] || (target.isLiteralIp ? target.host : null);
  const interfaces = interfaceModel || (await interfacesForTarget(probeAddress));
  const targetIsLoopback = /^(127\.|::1$|localhost$)/i.test(target.host);

  const context = { target, answers, resolvers, interfaces: interfaces.interfaces, targetIsLoopback };
  const { experiments, unavailable, availableAxisIds } = buildExperiments(context, { axes });

  // --- Step 1: baseline -----------------------------------------------------
  report({ phase: "baseline" });
  const baseline = await evaluate(target, {}, { repeat, timeoutMs, trialRunner, counters });
  const baselineState = baselineStateFrom(baseline.result);
  transcript.push({
    step: transcript.length + 1,
    kind: "baseline",
    action: `Baseline repeated ${baseline.total} times`,
    result: baseline.result,
    detail: `${baseline.passes}/${baseline.total} succeeded${baseline.reason ? ` (${baseline.reason})` : ""}`,
    stage: baseline.stage
  });
  report({ phase: "baseline-done", result: baseline.result, passes: baseline.passes, total: baseline.total });

  // An unstable baseline makes every comparison meaningless.
  if (baselineState === BASELINE_STATE.INTERMITTENT) {
    return finish({
      target, startedAt, counters, transcript, interfaces, experiments, unavailable,
      baseline, baselineState, hypotheses: [], executed: [], skipped: [],
      verdict: {
        classification: CLASSIFICATION.UNSTABLE_BASELINE,
        stop: STOP.UNSTABLE,
        headline: "Baseline is intermittent — isolation refused",
        detail: `The target succeeded ${baseline.passes} of ${baseline.total} times with nothing changed. Any condition would appear to fix or break it by chance.`,
        claim: "No condition can be isolated while the baseline itself is unstable.",
        recommendation: "Re-run with a higher --repeat to measure the flake rate, or capture the fault while it is persistent.",
        flakeRate: baseline.flakeRate
      }
    });
  }

  if (!isEvidential(baseline.result)) {
    return finish({
      target, startedAt, counters, transcript, interfaces, experiments, unavailable,
      baseline, baselineState, hypotheses: [], executed: [], skipped: [],
      verdict: {
        classification: CLASSIFICATION.INAPPLICABLE_CONDITION,
        stop: STOP.UNSUPPORTED,
        headline: "The baseline could not be measured",
        detail: baseline.reason || "The baseline connection could not be attempted on this machine.",
        claim: "No conclusion can be drawn without a measurable baseline."
      }
    });
  }

  const baselineFailed = baselineState === BASELINE_STATE.FAILED;

  // --- Step 2: hypotheses ---------------------------------------------------
  const hypotheses = markUntestable(buildHypotheses({ baselineFailed }), availableAxisIds);
  transcript.push({
    step: transcript.length + 1,
    kind: "hypotheses",
    action: baselineFailed
      ? "Formed competing explanations for the failure"
      : "Baseline is healthy — running differential capability analysis",
    detail: `${live(hypotheses).length} explanations in play${unavailable.length ? `, ${unavailable.length} axes unavailable` : ""}`,
    live: live(hypotheses).map(h => h.id)
  });

  // --- Step 3: adaptive loop ------------------------------------------------
  const executed = [];
  const skippedAll = [];
  const executedIds = new Set();
  const resolvedAxes = new Set();
  const seenTuples = new Set();
  let verdict = null;
  let confirmation = null;

  while (executed.length < maxExperiments) {
    const { selected, skipped } = planNext(hypotheses, experiments, {
      executed: executedIds,
      resolvedAxes,
      seenTuples,
      allowExpectedDifference: false
    });

    // Record newly skipped experiments once each, with the reason.
    for (const entry of skipped) {
      if (executedIds.has(entry.experiment.id) || skippedAll.some(s => s.id === entry.experiment.id)) continue;
      skippedAll.push({
        id: entry.experiment.id, axisId: entry.experiment.axisId, axisLabel: entry.experiment.axisLabel,
        label: entry.experiment.label, skip: entry.skip, reason: entry.reason
      });
      if (entry.skip === SKIP.INAPPLICABLE) counters.inapplicable += 1;
      else counters.skipped += 1;
    }

    if (!selected) break;

    const experiment = selected.experiment;
    report({ phase: "experiment", label: `${experiment.axisLabel}: ${experiment.label}`, why: selected.reason });

    const assignment = assignmentFor(experiment);
    const observation = await evaluate(target, assignment, { repeat, timeoutMs, trialRunner, counters });
    executedIds.add(experiment.id);
    counters.executed += 1;

    const tuple = observation.plan ? JSON.stringify([
      observation.plan.family ?? "auto", observation.plan.address ?? "resolved",
      observation.plan.localAddress ?? "auto", observation.plan.port,
      observation.plan.tlsVersion ?? "auto", observation.plan.alpn ?? "auto",
      observation.plan.sni === false ? "no-sni" : "sni"
    ]) : null;
    if (tuple) seenTuples.add(tuple);

    const changes = applyObservation(hypotheses, {
      axisId: experiment.axisId, value: experiment.value,
      result: observation.result, stage: observation.stage
    }, { baselineResult: baseline.result });

    const record = {
      id: experiment.id, axisId: experiment.axisId, axisLabel: experiment.axisLabel,
      label: experiment.label, result: observation.result,
      passes: observation.passes, total: observation.total,
      stage: observation.stage, reason: observation.reason,
      selectionScore: selected.score, selectionReason: selected.reason,
      expectedRemaining: selected.expectedRemaining ?? null, tuple
    };
    executed.push(record);

    transcript.push({
      step: transcript.length + 1,
      kind: "experiment",
      action: `${experiment.axisLabel}: ${experiment.label}`,
      why: `Highest discrimination score (${selected.score}). ${selected.reason}`,
      result: observation.result,
      detail: `${observation.passes}/${observation.total}${observation.reason ? ` — ${observation.reason}` : ""}`,
      stage: observation.stage,
      contradicted: changes.filter(c => c.to === STATE.CONTRADICTED).map(c => c.id),
      supported: changes.filter(c => c.to === STATE.SUPPORTED).map(c => c.id)
    });
    report({ phase: "experiment-done", result: observation.result, passes: observation.passes, total: observation.total });

    // A difference worth confirming: the outcome flipped relative to baseline.
    const dir = transition(baseline.result, observation.result);
    if (dir === "fail-to-pass" || dir === "pass-to-fail") {
      report({ phase: "confirm", label: experiment.label });
      const baselineAssignment = experiment.stopAt ? { __stopAt: experiment.stopAt } : {};
      confirmation = {
        experimentId: experiment.id, label: experiment.label,
        ...(await confirm(target, baselineAssignment, assignment, { pairs: confirmPairs, timeoutMs, trialRunner, counters }))
      };
      transcript.push({
        step: transcript.length + 1,
        kind: "confirmation",
        action: `Interleaved A/B confirmation of ${experiment.label}`,
        why: "Running all of one arm then the other would confound the comparison with time; alternating exposes a network that simply recovered.",
        result: confirmation.confirmed ? "CONFIRMED" : "NOT CONFIRMED",
        detail: confirmation.sequence.map(s => `${s.arm === "baseline" ? "A" : "B"}${s.verdict === "pass" ? "+" : "-"}`).join(" ")
      });
      report({ phase: "confirm-done", confirmed: confirmation.confirmed });

      if (confirmation.confirmed) {
        resolvedAxes.add(experiment.axisId);
        verdict = {
          ...classifyFinding({ baselineState, experiment, observation, answers }),
          detail: baselineFailed
            ? `Baseline failed ${baseline.fails}/${baseline.total} times at the ${baseline.stage || "connection"} stage${baseline.reason ? ` (${baseline.reason})` : ""}. Changing only ${experiment.axisLabel.toLowerCase()} to "${experiment.label}" produced ${observation.passes}/${observation.total} successes, and the difference held under ${confirmation.pairs} interleaved A/B pairs.`
            : `Baseline succeeded ${baseline.passes}/${baseline.total} times. Changing only ${experiment.axisLabel.toLowerCase()} to "${experiment.label}" failed ${observation.total - observation.passes}/${observation.total} times at the ${observation.stage || "connection"} stage${observation.reason ? ` (${observation.reason})` : ""}, and the difference held under ${confirmation.pairs} interleaved A/B pairs.`,
          experiment: record
        };
        break;
      }

      // Not confirmed: the sweep result was time drift, not a condition.
      verdict = {
        classification: CLASSIFICATION.INSUFFICIENT_EVIDENCE,
        stop: STOP.INSUFFICIENT_EVIDENCE,
        headline: "Candidate condition did not survive paired confirmation",
        detail: `${experiment.label} looked like a differentiator, but under alternation the baseline arm passed ${confirmation.baselinePasses}/${confirmation.pairs} and the variant ${confirmation.variantPasses}/${confirmation.pairs}. That pattern fits a network changing over time rather than the condition itself.`,
        claim: "No condition can be isolated from this evidence.",
        recommendation: "Treat this as an intermittent fault and re-run with a higher --repeat.",
        experiment: record
      };
      break;
    }
  }

  // --- Step 4: stopping rules ----------------------------------------------
  if (!verdict) {
    const remaining = live(hypotheses);
    const allSame = executed.length > 0 && executed.every(e => e.result === baseline.result);

    if (!executed.length) {
      verdict = {
        classification: CLASSIFICATION.INAPPLICABLE_CONDITION, stop: STOP.UNSUPPORTED,
        headline: "No applicable experiment was available",
        detail: `No condition could be varied for this target on this machine. ${unavailable.map(u => u.reason).join(" ")}`.trim(),
        claim: "Nothing could be isolated because no experiment applied."
      };
    } else if (baselineFailed && allSame) {
      verdict = {
        classification: CLASSIFICATION.NO_MEANINGFUL_DIFFERENCE, stop: STOP.NO_DISCRIMINATOR,
        headline: "Failure is not specific to any tested condition",
        detail: `The target failed under every applicable condition, stopping at the ${baseline.stage || "connection"} stage${baseline.reason ? ` (${baseline.reason})` : ""}.`,
        claim: "Evidence points away from client-side path or protocol selection and towards the target or the wider path."
      };
    } else if (!baselineFailed && allSame) {
      verdict = {
        classification: CLASSIFICATION.NO_MEANINGFUL_DIFFERENCE, stop: STOP.NO_DISCRIMINATOR,
        headline: "No meaningful capability difference found",
        detail: "Normal connectivity is healthy and every applicable condition behaved the same way.",
        claim: "There is no fault to isolate and no condition-specific difference."
      };
    } else {
      verdict = {
        classification: CLASSIFICATION.INSUFFICIENT_EVIDENCE, stop: STOP.INSUFFICIENT_EVIDENCE,
        headline: "Evidence did not separate the remaining explanations",
        detail: `${remaining.length} explanation(s) remain consistent with the observations: ${remaining.map(h => h.label).join("; ")}.`,
        claim: "No single condition accounts for the observations.",
        recommendation: "Run with --all for the full condition matrix."
      };
    }
  }

  return finish({
    target, startedAt, counters, transcript, interfaces, experiments, unavailable,
    baseline, baselineState, hypotheses, executed, skipped: skippedAll, verdict, confirmation
  });
}

function finish({ target, startedAt, counters, transcript, interfaces, experiments, unavailable, baseline, baselineState, hypotheses, executed, skipped, verdict, confirmation = null }) {
  return {
    schema: "faultline.network-bisect",
    schemaVersion: 2,
    mode: "adaptive",
    engineVersion: ENGINE_VERSION,
    startedAt,
    completedAt: new Date().toISOString(),
    target: { input: target.input, host: target.host, port: target.port, scheme: target.scheme, url: target.url },
    baseline: {
      state: baselineState, result: baseline.result,
      passes: baseline.passes, total: baseline.total,
      stage: baseline.stage, reason: baseline.reason, flakeRate: baseline.flakeRate
    },
    interfaces: (interfaces?.interfaces || []).map(i => ({
      name: i.name, address: i.address, classification: i.classification,
      routeSupport: i.routeSupport ?? ROUTE.UNKNOWN, routeReason: i.routeReason || null,
      ownsDefaultRoute: i.ownsDefaultRoute ?? null, isBestDefault: i.isBestDefault ?? null
    })),
    hypotheses: hypotheses.map(h => ({
      id: h.id, label: h.label, domain: h.domain, state: h.state,
      explains: h.explains, notes: h.notes
    })),
    experimentsAvailable: experiments.length,
    axesUnavailable: unavailable,
    executed,
    skipped,
    confirmation,
    transcript,
    counters: {
      connections: counters.connections,
      executed: counters.executed,
      skipped: counters.skipped,
      inapplicable: counters.inapplicable
    },
    verdict,
    evidence: {
      observed: "Every result is a real connection attempt made from this machine.",
      deterministic: "Experiment selection, hypothesis updates and the verdict follow fixed rules with no probabilities.",
      note: "A confirmed discriminator establishes association, not causation."
    }
  };
}

export { ENGINE_VERSION };
