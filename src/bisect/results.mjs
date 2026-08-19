// Result semantics.
//
// The first model had two outcomes, pass and fail, and everything else was
// forced into one of them. That is how a host-only adapter with no route to
// the target ended up reported as a network failure and competed with genuine
// findings.
//
// These states are first-class and never collapsed into each other:
//
//   PASS          the connection completed under this condition
//   FAIL          the connection did not complete, and it could have
//   INAPPLICABLE  the condition cannot be applied to this target/machine pair
//                 (no route from that source, IPv4 source to an IPv6 target)
//   UNSUPPORTED   the machine cannot perform the experiment at all
//                 (no IPv6 stack, no second interface, tool unavailable)
//   UNSTABLE      repeated trials disagreed
//
// INAPPLICABLE and UNSUPPORTED are statements about the experiment, not about
// the network. Only PASS and FAIL are evidence about connectivity.

export const RESULT = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  INAPPLICABLE: "INAPPLICABLE",
  UNSUPPORTED: "UNSUPPORTED",
  UNSTABLE: "UNSTABLE"
});

/** Only these two carry information about whether the network works. */
export const EVIDENTIAL = Object.freeze([RESULT.PASS, RESULT.FAIL]);

export function isEvidential(result) {
  return EVIDENTIAL.includes(result);
}

export const BASELINE_STATE = Object.freeze({
  HEALTHY: "HEALTHY_BASELINE",
  FAILED: "FAILED_BASELINE",
  INTERMITTENT: "INTERMITTENT_BASELINE",
  UNSUPPORTED: "UNSUPPORTED_BASELINE"
});

/**
 * What the run as a whole concluded.
 *
 * The distinction that matters most: a FAILURE_DISCRIMINATOR is found only
 * when the baseline was failing and a condition repaired it. When the baseline
 * is healthy, a condition that breaks it is not a fault - it is a capability
 * difference, and the wording must not imply something is wrong.
 */
export const CLASSIFICATION = Object.freeze({
  FAILURE_DISCRIMINATOR: "FAILURE_DISCRIMINATOR",           // FAIL -> PASS, baseline was broken
  WORKAROUND_CANDIDATE: "WORKAROUND_CANDIDATE",             // a condition that restores service
  LOCAL_CAPABILITY_DEFICIENCY: "LOCAL_CAPABILITY_DEFICIENCY", // this machine cannot do it; target can
  TARGET_PROPERTY: "TARGET_PROPERTY",                       // the target does not offer it
  NO_MEANINGFUL_DIFFERENCE: "NO_MEANINGFUL_DIFFERENCE",     // nothing changed the outcome
  UNSTABLE_BASELINE: "UNSTABLE_BASELINE",
  INAPPLICABLE_CONDITION: "INAPPLICABLE_CONDITION",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE"
});

/** Why the engine stopped making connections. */
export const STOP = Object.freeze({
  ISOLATED: "ISOLATED",
  NO_DISCRIMINATOR: "NO_DISCRIMINATOR",
  TARGET_PROPERTY: "TARGET_PROPERTY",
  UNSTABLE: "UNSTABLE",
  INSUFFICIENT_EVIDENCE: "INSUFFICIENT_EVIDENCE",
  UNSUPPORTED: "UNSUPPORTED",
  EXHAUSTED: "EXHAUSTED",
  BUDGET: "BUDGET"
});

/**
 * Classify a set of repeated trials into one result state.
 *
 * Unanimity is required for PASS or FAIL. A mixed set is UNSTABLE, never
 * rounded to the majority: an intermittent condition is a different kind of
 * finding from a consistent one, and treating it as either pass or fail is
 * how tools produce confident nonsense.
 */
export function classifyTrials(trials) {
  const verdicts = trials.map(t => t.verdict);
  if (!verdicts.length) return { result: RESULT.UNSUPPORTED, passes: 0, fails: 0, total: 0, flakeRate: 0 };

  // An experiment that could not be applied is reported as such regardless of
  // how many times it was attempted.
  if (verdicts.some(v => v === "inapplicable")) {
    return { result: RESULT.INAPPLICABLE, passes: 0, fails: 0, total: verdicts.length, flakeRate: 0 };
  }
  if (verdicts.some(v => v === "unsupported")) {
    return { result: RESULT.UNSUPPORTED, passes: 0, fails: 0, total: verdicts.length, flakeRate: 0 };
  }

  const passes = verdicts.filter(v => v === "pass").length;
  const fails = verdicts.filter(v => v === "fail").length;
  const total = verdicts.length;
  const flakeRate = total ? Number((Math.min(passes, fails) / total).toFixed(2)) : 0;

  if (passes === total) return { result: RESULT.PASS, passes, fails, total, flakeRate: 0 };
  if (fails === total) return { result: RESULT.FAIL, passes, fails, total, flakeRate: 0 };
  return { result: RESULT.UNSTABLE, passes, fails, total, flakeRate };
}

/**
 * Map a result state onto the baseline state vocabulary.
 */
export function baselineStateFrom(result) {
  switch (result) {
    case RESULT.PASS: return BASELINE_STATE.HEALTHY;
    case RESULT.FAIL: return BASELINE_STATE.FAILED;
    case RESULT.UNSTABLE: return BASELINE_STATE.INTERMITTENT;
    default: return BASELINE_STATE.UNSUPPORTED;
  }
}

/**
 * A transition between the baseline result and a variant result, expressed in
 * the direction that matters diagnostically.
 */
export function transition(baselineResult, variantResult) {
  if (!isEvidential(baselineResult) || !isEvidential(variantResult)) return "none";
  if (baselineResult === RESULT.FAIL && variantResult === RESULT.PASS) return "fail-to-pass";
  if (baselineResult === RESULT.PASS && variantResult === RESULT.FAIL) return "pass-to-fail";
  return "same";
}
