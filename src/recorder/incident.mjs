// Incident assembly.
//
// Turns a frozen buffer plus the samples that followed into a BEFORE / DURING /
// AFTER record, and states what differs between the healthy and failing
// windows.
//
// This module is where Faultline's epistemic discipline has to hold hardest,
// because temporal adjacency is the most seductive false signal in network
// troubleshooting. The rule:
//
//   ALLOWED      "the route changed at 20:46:17"                    observed
//   ALLOWED      "connections began failing at 20:46:18"            observed
//   ALLOWED      "the failing window differs from the preceding
//                 healthy window by route selection"                deterministic
//   NOT ALLOWED  "the route change caused the outage"               causal
//
// So nothing here produces a cause. It produces a comparison, and a list of
// candidate discriminators for Network Bisect to test independently. Bisect can
// establish that changing a condition changes the outcome; the recorder cannot,
// because it only watched.

import { diffSamples, TRIGGER } from "./triggers.mjs";
import { STATE } from "./sample.mjs";
import { RESULT } from "../bisect/results.mjs";

let counter = 0;

/** FLR-YYYY-NNNN. Sequential within a process, stable once assigned. */
export function nextIncidentId(now = new Date(), sequence = null) {
  counter = sequence ?? counter + 1;
  return `FLR-${now.getUTCFullYear()}-${String(counter).padStart(4, "0")}`;
}

export function resetIncidentCounter() {
  counter = 0;
}

const healthy = sample => sample.state === STATE.HEALTHY;
const failing = sample => sample.state === STATE.FAILED || sample.state === STATE.DEGRADED;

/**
 * Build the incident record.
 *
 * `before` are frozen pre-trigger samples; `during` and `after` are collected
 * live as sampling continues. `deepCapture` may be null - a capture that failed
 * or was still running must not prevent the incident from being usable.
 */
export function buildIncident({
  id,
  target,
  trigger,
  allTriggers = [],
  before = [],
  during = [],
  after = [],
  deepCapture = null,
  contract = null,
  closedAt = null,
  closeReason = null
}) {
  const beforeWindow = before.slice();
  const duringWindow = during.slice();
  const afterWindow = after.slice();

  // The comparison basis: the last healthy sample before the trigger, and the
  // first failing sample at or after it. If either is absent there is nothing
  // honest to compare, and the incident says so rather than guessing.
  const lastHealthy = [...beforeWindow].reverse().find(healthy) ?? null;
  const firstFailing = [...duringWindow, ...afterWindow].find(failing)
    ?? duringWindow[0]
    ?? null;

  const observedChange = buildObservedChange({ lastHealthy, firstFailing, trigger, afterWindow });

  // Provenance is derived from the samples themselves rather than passed in, so
  // a simulated incident cannot be constructed as a real one by a caller that
  // forgets to say so. If any sample came from a simulation, the whole record
  // is marked, and every downstream consumer sees it.
  const allSamples = [...beforeWindow, ...duringWindow, ...afterWindow];
  const simulated = allSamples.some(sample => sample?.simulated === true);
  const scenario = simulated ? allSamples.find(sample => sample?.scenario)?.scenario ?? null : null;

  return {
    schema: "faultline.flight-recorder-incident",
    schemaVersion: 1,
    id,
    // Top-level and unmissable. Real captures carry source "measured".
    source: simulated ? "simulation" : "measured",
    simulated,
    scenario,
    evidenceClass: simulated ? "simulated" : "observed",
    target: target ? { host: target.host, port: target.port, input: target.input } : null,
    contract: contract ? { id: contract.id, version: contract.version ?? null } : null,
    trigger: {
      type: trigger?.type ?? null,
      at: trigger?.at ?? null,
      summary: trigger?.summary ?? null,
      detail: trigger?.detail ?? null,
      manual: trigger?.type === TRIGGER.MANUAL,
      note: trigger?.note ?? null
    },
    // Every trigger that fired in the same transition, so a route change that
    // coincided with the failure is preserved even though it did not open the
    // incident.
    concurrentTriggers: allTriggers
      .filter(entry => entry !== trigger)
      .map(entry => ({ type: entry.type, at: entry.at, summary: entry.summary })),
    windows: {
      before: { samples: beforeWindow, from: beforeWindow[0]?.at ?? null, to: beforeWindow.at(-1)?.at ?? null },
      during: { samples: duringWindow, from: duringWindow[0]?.at ?? null, to: duringWindow.at(-1)?.at ?? null },
      after: { samples: afterWindow, from: afterWindow[0]?.at ?? null, to: afterWindow.at(-1)?.at ?? null }
    },
    deepCapture,
    observedChange,
    candidateDiscriminators: buildCandidates(observedChange),
    closedAt,
    closeReason,
    epistemics: {
      observed: simulated
        ? "SIMULATED. These samples were generated from a scenario file. They are not measurements of any real network."
        : "Every sample is a real measurement taken from this machine at the stated time.",
      comparison: "Differences are a deterministic comparison of two observed windows.",
      limit: "Temporal association is not causation. The recorder observed; it did not experiment.",
      next: "Network Bisect can test whether a candidate condition actually changes the outcome."
    }
  };
}

/**
 * State what differs between the healthy and failing windows, and nothing more.
 */
function buildObservedChange({ lastHealthy, firstFailing, trigger, afterWindow }) {
  if (!lastHealthy || !firstFailing) {
    return {
      comparable: false,
      reason: !lastHealthy
        ? "No healthy sample was retained before the trigger, so there is nothing to compare the failing state against."
        : "No failing sample was captured, so no failing window exists to compare.",
      differences: [],
      unchanged: [],
      statement: null,
      classification: "insufficient_evidence"
    };
  }

  const { changes, unchanged } = diffSamples(lastHealthy, firstFailing);

  // A manual capture on a healthy network has no failing sample at all. Saying
  // "the failing sample" or "reachable again" in that case would put a failure
  // on the record that never happened.
  const hadFailure = failing(firstFailing);

  // Recovery only means something if reachability was actually lost.
  const recovered = hadFailure
    ? afterWindow.find(sample => sample.connectivity?.targetTcp?.state === RESULT.PASS) ?? null
    : null;
  const recoveryChanges = recovered ? diffSamples(firstFailing, recovered).changes : [];

  return {
    comparable: true,
    hadFailure,
    healthyWindow: { at: lastHealthy.at, state: lastHealthy.state },
    capturedWindow: { at: firstFailing.at, state: firstFailing.state, reasons: firstFailing.reasons || [] },
    recovery: recovered ? { at: recovered.at, changes: recoveryChanges } : null,
    differences: changes,
    unchanged,
    statement: composeStatement({ lastHealthy, firstFailing, changes, recovered, recoveryChanges, trigger, hadFailure }),
    // Named so no consumer can render this as a determination.
    classification: "temporal_association",
    note: hadFailure
      ? "This is an observed temporal association, not proof that any listed change caused the failure."
      : "Nothing failed during this capture. Any listed difference is an observation only."
  };
}

/**
 * Prose describing the comparison.
 *
 * Wording is constrained on purpose. This function states what was observed and
 * how two windows differ; it never states why. The qualification that this is
 * association rather than causation lives in `note`, deliberately NOT repeated
 * here - a statement that has to contain the word "caused" in order to deny
 * causation is one careless edit away from asserting it, and a test asserts
 * that no causal vocabulary appears in this string at all.
 */
function composeStatement({ lastHealthy, firstFailing, changes, recovered, recoveryChanges, trigger, hadFailure }) {
  const parts = [];
  const event = !hadFailure
    ? "The capture was requested while the target was still reachable"
    : trigger?.type === TRIGGER.MANUAL
      ? "The capture was requested manually"
      : firstFailing.connectivity?.targetTcp?.state === RESULT.FAIL
        ? "The target became unreachable"
        : "The observed state degraded";

  // The window is only "failing" if something actually failed.
  const windowNoun = hadFailure ? "failing" : "captured";

  if (changes.length) {
    const labels = changes.map(change => change.label.toLowerCase());
    parts.push(
      `${event} at ${firstFailing.at}. Compared with the last healthy sample at ${lastHealthy.at}, the ${windowNoun} window differs by ${listOf(labels)}.`
    );
  } else {
    parts.push(
      `${event} at ${firstFailing.at}. No watched network property differed between the last healthy sample (${lastHealthy.at}) and the ${windowNoun} sample.`
    );
    // Only meaningful when something did go wrong; otherwise nothing changed
    // and there is nothing to account for.
    if (hadFailure) parts.push("Whatever changed is not visible in what the recorder samples.");
  }

  // Recovery is appended in both branches: it is evidence regardless of whether
  // any watched property differed.
  if (recovered) {
    parts.push(
      recoveryChanges.length
        ? `The target was reachable again at ${recovered.at}, by which point ${listOf(recoveryChanges.map(c => c.label.toLowerCase()))} had changed again.`
        : `The target was reachable again at ${recovered.at} with no further change to the watched properties.`
    );
  }

  return parts.join(" ");
}

function listOf(items) {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * The handoff to Network Bisect.
 *
 * Only differences that map to a real Bisect axis become candidates. Everything
 * else is reported as observed-but-untestable rather than quietly dropped: a
 * public IP change is real evidence even though no experiment can vary it.
 */
export function buildCandidates(observedChange) {
  if (!observedChange?.comparable || !observedChange.differences.length) {
    return { testable: [], untestable: [], bisectAxes: [], available: false };
  }

  const testable = [];
  const untestable = [];
  for (const difference of observedChange.differences) {
    if (difference.bisectAxis) {
      testable.push({
        condition: difference.label,
        axis: difference.bisectAxis,
        healthyValue: difference.from,
        failingValue: difference.to
      });
    } else {
      untestable.push({
        condition: difference.label,
        healthyValue: difference.from,
        failingValue: difference.to,
        reason: "Network Bisect has no experiment that varies this condition."
      });
    }
  }

  const bisectAxes = [...new Set(testable.map(entry => entry.axis))];
  return {
    available: testable.length > 0,
    testable,
    untestable,
    bisectAxes,
    invitation: testable.length
      ? `Network Bisect can independently test ${bisectAxes.length === 1 ? "this condition" : "these conditions"} to establish whether changing it alters the outcome.`
      : null,
    note: "Candidates are differences between two observed windows. They are not causes, and Bisect may find that none of them changes the outcome."
  };
}

/** Compact projection for lists and for the Analyst. */
export function summariseIncident(incident) {
  return {
    id: incident.id,
    source: incident.source ?? "measured",
    simulated: incident.simulated === true,
    scenario: incident.scenario ?? null,
    target: incident.target?.host ?? null,
    trigger: incident.trigger?.type ?? null,
    triggerSummary: incident.trigger?.summary ?? null,
    at: incident.trigger?.at ?? null,
    closedAt: incident.closedAt ?? null,
    samples: {
      before: incident.windows.before.samples.length,
      during: incident.windows.during.samples.length,
      after: incident.windows.after.samples.length
    },
    differences: incident.observedChange?.differences?.length ?? 0,
    candidateAxes: incident.candidateDiscriminators?.bisectAxes ?? [],
    deepCapture: Boolean(incident.deepCapture),
    recovered: Boolean(incident.observedChange?.recovery)
  };
}
