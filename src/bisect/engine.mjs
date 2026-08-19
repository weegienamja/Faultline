// Network condition bisection engine.
//
// Given a target that misbehaves, find the SMALLEST controlled change that
// reproducibly flips the outcome, and refuse to claim one when the evidence
// does not support it.
//
// Four properties matter, and each is a deliberate piece of the algorithm:
//
// 1. REPRODUCIBILITY GATING. An intermittent fault will make a single trial
//    "prove" anything. Every condition is run `repeat` times and only a
//    unanimous result is allowed to be a discriminator. A baseline that is
//    itself unstable is reported as intermittent and bisection is refused,
//    because bisecting a flaky baseline produces confident nonsense.
//
// 2. DUPLICATE COLLAPSING. Several axes can express the same underlying
//    change (address-family=ipv4 and address=<the only A record> produce an
//    identical connection). Discriminators are grouped by the effective
//    connection tuple they produce so one physical finding is reported once,
//    attributed to the most general axis that expresses it.
//
// 3. INTERLEAVED PAIRED CONFIRMATION. Running all of A then all of B
//    confounds the comparison with time: if the network recovers midway, B
//    looks like the cure. The winning discriminator is re-tested A/B/A/B so
//    that a drifting network shows up as a failed confirmation instead of a
//    false conclusion.
//
// 4. STAGE ATTRIBUTION. Two failures that stop at different stages are not
//    the same failure. The stage is carried through so the verdict can say
//    where in the connection the difference appears.
//
// Nothing here concludes causation. A confirmed discriminator means "the
// failure is reproducibly associated with this condition", which is a
// defensible escalation signal, not a proof of root cause.

import { baselineAssignment, buildConditionSpace, effectiveTuple, variantAssignment } from "./conditions.mjs";
import { runTrial } from "./probe.mjs";
import { parseLiveTarget } from "../live/measure.mjs";
import { Resolver } from "node:dns/promises";

export const OUTCOME = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  FLAKY: "flaky",
  INAPPLICABLE: "inapplicable"
});

/**
 * Run one condition `repeat` times and classify it.
 * Unanimity is required for pass/fail; anything else is flaky.
 */
export async function evaluateCondition(target, assignment, { repeat = 3, timeoutMs = 5_000, onTrial = null, trialRunner = runTrial } = {}) {
  const trials = [];
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const trial = await trialRunner(target, assignment, { timeoutMs });
    trials.push(trial);
    if (onTrial) onTrial(trial, attempt);
    // An inapplicable condition cannot become applicable on retry.
    if (trial.verdict === "inapplicable") break;
  }

  if (trials.some(t => t.verdict === "inapplicable")) {
    return { outcome: OUTCOME.INAPPLICABLE, trials, passes: 0, fails: 0, reason: trials[0].reason, stage: null };
  }

  const passes = trials.filter(t => t.verdict === "pass").length;
  const fails = trials.filter(t => t.verdict === "fail").length;
  const stages = [...new Set(trials.filter(t => t.stage).map(t => t.stage))];
  const reasons = [...new Set(trials.map(t => t.reason).filter(Boolean))];

  let outcome = OUTCOME.FLAKY;
  if (passes === trials.length) outcome = OUTCOME.PASS;
  else if (fails === trials.length) outcome = OUTCOME.FAIL;

  return {
    outcome,
    trials,
    passes,
    fails,
    total: trials.length,
    stage: stages.length === 1 ? stages[0] : (stages[0] || null),
    reason: reasons[0] || null,
    flakeRate: trials.length ? Number((Math.min(passes, fails) / trials.length).toFixed(2)) : 0
  };
}

/**
 * Interleaved A/B/A/B confirmation. Returns the paired outcome and whether the
 * difference held under alternation.
 */
export async function confirmPaired(target, baseline, variant, { pairs = 3, timeoutMs = 5_000, onTrial = null, trialRunner = runTrial } = {}) {
  const sequence = [];
  for (let index = 0; index < pairs; index += 1) {
    const a = await trialRunner(target, baseline, { timeoutMs });
    if (onTrial) onTrial({ arm: "baseline", trial: a, index });
    sequence.push({ arm: "baseline", verdict: a.verdict, stage: a.stage, reason: a.reason });
    const b = await trialRunner(target, variant, { timeoutMs });
    if (onTrial) onTrial({ arm: "variant", trial: b, index });
    sequence.push({ arm: "variant", verdict: b.verdict, stage: b.stage, reason: b.reason });
  }

  const baselineArm = sequence.filter(s => s.arm === "baseline");
  const variantArm = sequence.filter(s => s.arm === "variant");
  const baselineAllFail = baselineArm.every(s => s.verdict === "fail");
  const variantAllPass = variantArm.every(s => s.verdict === "pass");
  const baselineAllPass = baselineArm.every(s => s.verdict === "pass");
  const variantAllFail = variantArm.every(s => s.verdict === "fail");

  return {
    pairs,
    sequence,
    // The difference survived alternation in one direction or the other.
    confirmed: (baselineAllFail && variantAllPass) || (baselineAllPass && variantAllFail),
    direction: baselineAllFail && variantAllPass ? "variant-fixes"
      : baselineAllPass && variantAllFail ? "variant-breaks"
        : "inconsistent",
    baselinePasses: baselineArm.filter(s => s.verdict === "pass").length,
    variantPasses: variantArm.filter(s => s.verdict === "pass").length
  };
}

/**
 * Collapse discriminators that produce the same effective connection.
 * Keeps the most general axis for each distinct physical change.
 */
export function collapseDiscriminators(discriminators) {
  // Lower rank == more general / preferred explanation.
  const rank = { "address-family": 0, resolver: 1, "source-interface": 2, "tls-version": 3, alpn: 4, port: 5, address: 6, sni: 7 };
  const groups = new Map();
  for (const item of discriminators) {
    const key = item.tuple;
    const existing = groups.get(key);
    if (!existing) { groups.set(key, { primary: item, equivalent: [] }); continue; }
    const incumbentRank = rank[existing.primary.axisId] ?? 99;
    const challengerRank = rank[item.axisId] ?? 99;
    if (challengerRank < incumbentRank) {
      existing.equivalent.push(existing.primary);
      existing.primary = item;
    } else {
      existing.equivalent.push(item);
    }
  }
  return [...groups.values()].map(group => ({ ...group.primary, equivalentTo: group.equivalent }));
}

async function resolveAnswerSets(host, timeoutMs) {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const out = { v4: [], v6: [] };
  try { out.v4 = await resolver.resolve4(host); } catch { /* no A */ }
  try { out.v6 = await resolver.resolve6(host); } catch { /* no AAAA */ }
  return out;
}

/**
 * Full bisection run.
 */
export async function bisect(targetInput, {
  repeat = 3,
  timeoutMs = 5_000,
  confirmPairs = 3,
  includeSourceInterface = true,
  resolvers = ["1.1.1.1", "8.8.8.8", "9.9.9.9"],
  onProgress = null,
  // Injectable so the algorithm can be tested deterministically offline.
  trialRunner = runTrial,
  answerSets = null
} = {}) {
  const startedAt = new Date().toISOString();
  const target = parseLiveTarget(targetInput);
  const report = progress => { if (onProgress) onProgress(progress); };

  const resolvedAddresses = answerSets ? answerSets
    : target.isLiteralIp ? { v4: [], v6: [] }
      : await resolveAnswerSets(target.host, timeoutMs);
  const axes = buildConditionSpace(target, { resolvers, includeSourceInterface, resolvedAddresses });
  const baseline = baselineAssignment(axes);

  // --- Step 1: baseline stability -----------------------------------------
  report({ phase: "baseline", label: "baseline (system defaults)" });
  const baselineResult = await evaluateCondition(target, baseline, { repeat, timeoutMs, trialRunner });
  report({ phase: "baseline-done", outcome: baselineResult.outcome, passes: baselineResult.passes, total: baselineResult.total });

  const conditions = [{
    axisId: BASELINE_ID,
    axisLabel: "Baseline",
    value: "default",
    label: "baseline (system defaults)",
    outcome: baselineResult.outcome,
    passes: baselineResult.passes,
    total: baselineResult.total,
    stage: baselineResult.stage,
    reason: baselineResult.reason,
    tuple: effectiveTuple(baselineResult.trials[0]?.plan || {})
  }];

  if (baselineResult.outcome === OUTCOME.FLAKY) {
    return finish({
      target, startedAt, axes, conditions, baselineResult,
      verdict: {
        kind: "intermittent",
        headline: "Baseline is intermittent - bisection refused",
        detail: `The target succeeded ${baselineResult.passes} of ${baselineResult.total} times under unchanged conditions. Any condition would appear to "fix" it by chance, so no differentiating condition is reported.`,
        recommendation: "Re-run with a higher --repeat to measure the flake rate, or capture the fault while it is persistent.",
        flakeRate: baselineResult.flakeRate
      },
      discriminators: [], confirmation: null
    });
  }

  const baselineFails = baselineResult.outcome === OUTCOME.FAIL;

  // --- Step 2: single-factor sweep ----------------------------------------
  const discriminators = [];
  for (const axis of axes) {
    for (const variant of axis.variants) {
      const value = typeof variant === "object" ? variant.value : variant;
      const label = typeof variant === "object" ? variant.label : String(variant);
      report({ phase: "sweep", axis: axis.id, label });

      const assignment = variantAssignment(axes, axis.id, value);
      // Carry the axis's stage scoping into the trial so a TLS-only condition
      // is not judged by an HTTP request this client cannot make.
      if (axis.stopAt) assignment.__stopAt = axis.stopAt;
      const result = await evaluateCondition(target, assignment, { repeat, timeoutMs, trialRunner });
      const tuple = effectiveTuple(result.trials[0]?.plan || {});

      const entry = {
        axisId: axis.id, axisLabel: axis.label, value, label,
        outcome: result.outcome, passes: result.passes, total: result.total ?? repeat,
        stage: result.stage, reason: result.reason, tuple, rationale: axis.rationale || null,
        stopAt: axis.stopAt || null,
        expectedDifference: Boolean(axis.expectedDifference)
      };
      conditions.push(entry);
      report({ phase: "sweep-done", axis: axis.id, label, outcome: result.outcome });

      // A discriminator flips the baseline outcome, unanimously.
      const flips = baselineFails
        ? result.outcome === OUTCOME.PASS
        : result.outcome === OUTCOME.FAIL;
      if (flips) discriminators.push(entry);
    }
  }

  // Expected-by-design differences (omitting SNI breaks name-based hosting)
  // are reported but never promoted above a genuine finding.
  const collapsed = collapseDiscriminators(discriminators)
    .sort((a, b) => Number(a.expectedDifference) - Number(b.expectedDifference));

  // --- Step 3: paired confirmation of the strongest discriminator ---------
  let confirmation = null;
  if (collapsed.length) {
    const winner = collapsed[0];
    report({ phase: "confirm", label: winner.label });
    const winnerAssignment = variantAssignment(axes, winner.axisId, winner.value);
    const winnerBaseline = { ...baseline };
    if (winner.stopAt) { winnerAssignment.__stopAt = winner.stopAt; winnerBaseline.__stopAt = winner.stopAt; }
    confirmation = {
      axisId: winner.axisId, value: winner.value, label: winner.label,
      ...(await confirmPaired(target, winnerBaseline, winnerAssignment, { pairs: confirmPairs, timeoutMs, trialRunner }))
    };
    report({ phase: "confirm-done", confirmed: confirmation.confirmed });
  }

  // --- Step 4: verdict -----------------------------------------------------
  let verdict;
  if (!baselineFails && !collapsed.length) {
    verdict = {
      kind: "healthy",
      headline: "No fault reproduced",
      detail: `The target succeeded under baseline conditions ${baselineResult.passes}/${baselineResult.total} times and no tested condition broke it.`,
      recommendation: "If the fault is intermittent, re-run while it is occurring, or raise --repeat."
    };
  } else if (baselineFails && !collapsed.length) {
    verdict = {
      kind: "unconditional",
      headline: "Failure is not condition-specific",
      detail: `The target failed under every tested condition, stopping at the ${baselineResult.stage || "connection"} stage (${baselineResult.reason || "no detail"}). No address family, resolver, source interface, TLS version, ALPN, SNI or port variation changed the outcome.`,
      recommendation: "The evidence points away from a client-side path or protocol selection issue and towards the target or the wider path."
    };
  } else if (confirmation && !confirmation.confirmed) {
    verdict = {
      kind: "unstable",
      headline: "Candidate condition did not survive paired confirmation",
      detail: `${collapsed[0].label} looked like a differentiator during the sweep, but under interleaved A/B testing the baseline passed ${confirmation.baselinePasses}/${confirmation.pairs} times and the variant ${confirmation.variantPasses}/${confirmation.pairs}. That pattern is consistent with a network changing over time rather than with the condition itself.`,
      recommendation: "Treat this as an intermittent fault. Re-run with a higher --repeat."
    };
  } else if (isMissingRecord(collapsed[0])) {
    // The variant failed at DNS because the target publishes no record of that
    // family. That is a property of the target, not evidence of a local fault.
    const winner = collapsed[0];
    const family = winner.value === "ipv6" ? "AAAA" : "A";
    verdict = {
      kind: "not-published",
      headline: `${winner.label} is unavailable because the target publishes no ${family} record`,
      detail: `Changing address family to "${winner.label}" failed at the DNS stage (${winner.reason}). That means ${target.host} does not publish a ${family} record at all, so this is a property of the target rather than evidence of a fault on this network.`,
      recommendation: `Nothing to fix locally. A dual-stack client will use the other family automatically.`,
      claim: `Evidence supports: ${target.host} publishes no ${family} record. This is not a local network fault.`,
      alsoDiffering: collapsed.slice(1).filter(d => !d.expectedDifference).map(d => `${d.axisLabel}: ${d.label}`),
      expectedDifferences: collapsed.filter(d => d.expectedDifference).map(d => `${d.axisLabel}: ${d.label} (expected for name-based hosting)`)
    };
  } else {
    const winner = collapsed[0];
    const direction = baselineFails ? "flips FAIL to PASS" : "flips PASS to FAIL";
    verdict = {
      kind: "isolated",
      headline: `${winner.axisLabel}: ${winner.label} ${direction}`,
      detail: baselineFails
        ? `Baseline failed ${baselineResult.fails}/${baselineResult.total} times at the ${baselineResult.stage || "connection"} stage (${baselineResult.reason || "no detail"}). Changing only ${winner.axisLabel.toLowerCase()} to "${winner.label}" made it succeed unanimously, and the difference held under ${confirmation?.pairs || 0} interleaved A/B pairs.`
        : `Baseline succeeded ${baselineResult.passes}/${baselineResult.total} times. Changing only ${winner.axisLabel.toLowerCase()} to "${winner.label}" made it fail unanimously at the ${winner.stage || "connection"} stage (${winner.reason || "no detail"}), and the difference held under ${confirmation?.pairs || 0} interleaved A/B pairs.`,
      recommendation: winner.rationale || null,
      // Deliberate wording: association, never causation.
      claim: `Evidence supports: the failure is reproducibly associated with ${winner.axisLabel.toLowerCase()} = ${winner.label}.`,
      alsoDiffering: collapsed.slice(1).filter(d => !d.expectedDifference).map(d => `${d.axisLabel}: ${d.label}`),
      expectedDifferences: collapsed.filter(d => d.expectedDifference).map(d => `${d.axisLabel}: ${d.label} (expected for name-based hosting)`),
      equivalentTo: (winner.equivalentTo || []).map(d => `${d.axisLabel}: ${d.label}`)
    };
  }

  return finish({ target, startedAt, axes, conditions, baselineResult, verdict, discriminators: collapsed, confirmation });
}

const BASELINE_ID = "__baseline__";

// A DNS-stage failure for a forced address family means the target publishes no
// record of that family. Distinguishing this from a broken path matters: one is
// a property of the target, the other is a local fault.
const NO_RECORD_CODES = new Set(["ENODATA", "ENOTFOUND", "no address returned"]);
function isMissingRecord(discriminator) {
  return Boolean(discriminator)
    && discriminator.axisId === "address-family"
    && discriminator.stage === "dns"
    && NO_RECORD_CODES.has(String(discriminator.reason || ""));
}

function finish({ target, startedAt, axes, conditions, baselineResult, verdict, discriminators, confirmation }) {
  return {
    schema: "faultline.network-bisect",
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    target: { input: target.input, host: target.host, port: target.port, scheme: target.scheme, url: target.url },
    axesTested: axes.map(a => ({ id: a.id, label: a.label, variants: a.variants.length })),
    trialCount: conditions.reduce((sum, c) => sum + (c.total || 0), 0),
    baseline: {
      outcome: baselineResult.outcome,
      passes: baselineResult.passes,
      total: baselineResult.total,
      stage: baselineResult.stage,
      reason: baselineResult.reason,
      flakeRate: baselineResult.flakeRate
    },
    conditions,
    discriminators,
    confirmation,
    verdict,
    evidence: {
      observed: "Every row is a real connection attempt made from this machine.",
      deterministic: "The verdict is produced by unanimity and paired-confirmation rules only.",
      note: "A confirmed discriminator establishes association, not causation."
    }
  };
}

export { BASELINE_ID };
