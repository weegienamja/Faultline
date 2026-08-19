// Adaptive experiment planner.
//
// The question this answers is: given what is already known, which remaining
// experiment best separates the explanations still in play?
//
// THE SCORING ALGORITHM
// ---------------------
// For a candidate experiment, ask every live hypothesis what it predicts. That
// partitions the live set into groups by predicted outcome. If every hypothesis
// predicts the same thing, running the experiment cannot change anything we
// believe, and it scores zero.
//
// Otherwise we use the expected size of the surviving hypothesis set:
//
//     expectedRemaining = Σ over groups g:  (|g| / N) · |g|
//
// This is the standard "expected remaining candidates" measure used by
// decision-tree and Mastermind-style solvers. Reading it plainly: if the
// experiment produces the outcome that group g predicted, then roughly the
// members of g survive; the chance of landing in g is taken as |g|/N because
// that many live hypotheses expect it. Lower is better.
//
//     discrimination = N − expectedRemaining
//
// Worked examples with N = 6 live hypotheses:
//
//     split 3 / 3   → (3/6)·3 + (3/6)·3 = 3.00  → discrimination 3.00
//     split 2 / 4   → (2/6)·2 + (4/6)·4 = 3.33  → discrimination 2.67
//     split 1 / 5   → (1/6)·1 + (5/6)·5 = 4.33  → discrimination 1.67
//     split 6 / 0   → (6/6)·6            = 6.00  → discrimination 0.00
//
// So a balanced 3/3 split outranks a 1/5 split at equal cost, which is exactly
// the property a bisection strategy needs. Hypotheses that answer UNKNOWN make
// no commitment and are excluded from the partition rather than being lumped
// into a group they never claimed.
//
//     score = discrimination / cost
//
// Ties break deterministically: lower cost, then lower intrusiveness, then
// axis order in the registry, then experiment id. The same evidence therefore
// always produces the same plan.
//
// PRUNING
// -------
// An experiment is dropped before scoring when:
//   - its axis is already resolved (a discriminator was confirmed on it),
//   - an equivalent experiment already ran (same effective connection),
//   - it is known-inapplicable (no route from that source),
//   - or it scores zero, meaning no live hypothesis disagrees about it.
// Every drop records a reason, so "skipped" is always explainable and is never
// confused with "unsupported".

import { PREDICT, live } from "./hypotheses.mjs";

export const SKIP = Object.freeze({
  NO_DISCRIMINATION: "no-discrimination",
  AXIS_RESOLVED: "axis-resolved",
  EQUIVALENT: "equivalent-already-run",
  INAPPLICABLE: "inapplicable",
  BUDGET: "budget-exhausted",
  EXPECTED_ONLY: "expected-difference-only"
});

/**
 * Partition live hypotheses by what they predict for this experiment.
 * Returns null when fewer than two hypotheses commit to an outcome.
 */
export function partition(hypotheses, experiment) {
  const groups = new Map();
  for (const h of hypotheses) {
    const prediction = h.predict(experiment.axisId, experiment.value);
    if (prediction === PREDICT.UNKNOWN) continue;
    if (!groups.has(prediction)) groups.set(prediction, []);
    groups.get(prediction).push(h.id);
  }
  return groups;
}

/**
 * Expected number of hypotheses still standing after this experiment.
 * See the header comment for the derivation.
 */
export function expectedRemaining(groups) {
  const total = [...groups.values()].reduce((sum, g) => sum + g.length, 0);
  if (!total) return 0;
  let expected = 0;
  for (const group of groups.values()) {
    expected += (group.length / total) * group.length;
  }
  return Number(expected.toFixed(4));
}

export function scoreExperiment(hypotheses, experiment) {
  const groups = partition(hypotheses, experiment);
  const committed = [...groups.values()].reduce((sum, g) => sum + g.length, 0);

  if (groups.size < 2) {
    return {
      score: 0,
      discrimination: 0,
      committed,
      groups: [...groups.entries()].map(([outcome, ids]) => ({ outcome, ids })),
      reason: committed === 0
        ? "No live explanation makes a prediction about this experiment."
        : "Every live explanation predicts the same outcome, so the result cannot change what is believed."
    };
  }

  const remaining = expectedRemaining(groups);
  const discrimination = Number((committed - remaining).toFixed(4));
  const score = Number((discrimination / Math.max(1, experiment.cost)).toFixed(4));

  return {
    score,
    discrimination,
    expectedRemaining: remaining,
    committed,
    groups: [...groups.entries()].map(([outcome, ids]) => ({ outcome, ids })),
    reason: `Separates ${committed} live explanations into ${groups.size} predicted outcomes (${[...groups.values()].map(g => g.length).join("/")}).`
  };
}

/**
 * Rank the candidate experiments and explain every inclusion and exclusion.
 */
export function planNext(hypotheses, experiments, state = {}) {
  const {
    executed = new Set(),
    resolvedAxes = new Set(),
    seenTuples = new Set(),
    remainingBudget = Infinity,
    allowExpectedDifference = false
  } = state;

  const liveSet = live(hypotheses);
  const candidates = [];
  const skipped = [];

  for (const experiment of experiments) {
    if (executed.has(experiment.id)) continue;

    if (experiment.inapplicable) {
      skipped.push({ experiment, skip: SKIP.INAPPLICABLE, reason: experiment.inapplicableReason || "The experiment cannot be applied to this target." });
      continue;
    }
    if (resolvedAxes.has(experiment.axisId)) {
      skipped.push({ experiment, skip: SKIP.AXIS_RESOLVED, reason: `A discriminator was already established on ${experiment.axisLabel.toLowerCase()}; further variants of the same axis add nothing.` });
      continue;
    }
    if (experiment.expectedDifference && !allowExpectedDifference) {
      skipped.push({ experiment, skip: SKIP.EXPECTED_ONLY, reason: "This condition differs by design rather than because of a fault, so it is only run in exhaustive mode." });
      continue;
    }
    if (experiment.tuple && seenTuples.has(experiment.tuple)) {
      skipped.push({ experiment, skip: SKIP.EQUIVALENT, reason: "An equivalent experiment producing the same connection has already run." });
      continue;
    }
    if (experiment.cost > remainingBudget) {
      skipped.push({ experiment, skip: SKIP.BUDGET, reason: "The connection budget for this run is exhausted." });
      continue;
    }

    const scored = scoreExperiment(liveSet, experiment);
    if (scored.score <= 0) {
      skipped.push({ experiment, skip: SKIP.NO_DISCRIMINATION, reason: scored.reason });
      continue;
    }
    candidates.push({ experiment, ...scored });
  }

  // Deterministic ordering: score desc, then cost asc, then intrusiveness asc,
  // then registry order, then id. Identical evidence always yields the same plan.
  const axisOrder = new Map(experiments.map((e, index) => [e.id, index]));
  candidates.sort((a, b) =>
    b.score - a.score
    || a.experiment.cost - b.experiment.cost
    || a.experiment.intrusiveness - b.experiment.intrusiveness
    || axisOrder.get(a.experiment.id) - axisOrder.get(b.experiment.id)
    || String(a.experiment.id).localeCompare(String(b.experiment.id)));

  return { selected: candidates[0] || null, candidates, skipped };
}
