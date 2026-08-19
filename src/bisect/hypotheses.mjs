// Hypothesis model.
//
// The engine maintains an explicit set of competing explanations and updates
// their state from observed experiment outcomes. There are no probabilities
// and no scores that pretend to be probabilities. A hypothesis is in exactly
// one deterministic state, and every transition is caused by a named
// observation that can be printed back to the user.
//
// The critical mechanic is `predict`: for a given experiment, a hypothesis
// states what it expects to happen. That prediction is what makes a hypothesis
// falsifiable and what lets the planner choose between experiments - an
// experiment is only worth running if live hypotheses disagree about it.

import { RESULT } from "./results.mjs";

export const STATE = Object.freeze({
  SUPPORTED: "SUPPORTED",       // an observation matched a distinctive prediction
  STILL_POSSIBLE: "STILL_POSSIBLE",
  WEAKENED: "WEAKENED",         // an observation fits poorly but does not exclude it
  CONTRADICTED: "CONTRADICTED", // an observation is incompatible with it
  NOT_TESTABLE: "NOT_TESTABLE"  // this machine/target cannot test it
});

export const DOMAIN = Object.freeze({
  LOCAL: "local-network",
  PATH: "path",
  PROTOCOL: "protocol",
  TARGET: "target-property",
  DNS: "dns",
  UNKNOWN: "unknown"
});

/** Predictions a hypothesis can make about an experiment's outcome. */
export const PREDICT = Object.freeze({
  PASS: "pass",
  FAIL: "fail",
  UNCHANGED: "unchanged",  // same as baseline, whatever that was
  // "The outcome differs from baseline." Used by a hypothesis about an axis
  // when it knows the axis matters but not which variant is the bad one - a
  // TLS-version incompatibility means one of the two versions fails, not both.
  // Resolved against the real baseline when the observation arrives.
  DIFFERS: "differs",
  UNKNOWN: "unknown"       // makes no commitment; contributes nothing to discrimination
});

/**
 * Hypothesis catalogue.
 *
 * `predict(axisId, value, context)` returns what this hypothesis expects if
 * that experiment is run, given a failing or healthy baseline. Returning
 * UNKNOWN means "this hypothesis does not care", which correctly removes it
 * from the discrimination calculation for that experiment.
 */
function hypothesis(id, label, domain, config) {
  return { id, label, domain, state: STATE.STILL_POSSIBLE, notes: [], ...config };
}

export function buildHypotheses({ baselineFailed = true } = {}) {
  const all = [
    hypothesis("ipv6-path", "IPv6 path is broken between this machine and the target", DOMAIN.PATH, {
      explains: "Traffic over IPv6 does not reach the target, while IPv4 does.",
      predict: (axisId, value) => {
        if (axisId === "address-family" && value === "ipv4") return PREDICT.PASS;
        if (axisId === "address-family" && value === "ipv6") return PREDICT.FAIL;
        if (axisId === "address") return PREDICT.UNKNOWN; // depends which family the address is
        return PREDICT.UNCHANGED;
      },
      // A path problem must show up after the name resolves. A DNS-stage
      // failure means there was never an address to route, which is a
      // different explanation entirely.
      expectedFailStage: { axisId: "address-family", value: "ipv6", notStage: "dns" }
    }),

    hypothesis("ipv4-path", "IPv4 path is broken between this machine and the target", DOMAIN.PATH, {
      explains: "Traffic over IPv4 does not reach the target, while IPv6 does.",
      predict: (axisId, value) => {
        if (axisId === "address-family" && value === "ipv6") return PREDICT.PASS;
        if (axisId === "address-family" && value === "ipv4") return PREDICT.FAIL;
        return PREDICT.UNCHANGED;
      }
    }),

    hypothesis("target-no-aaaa", "The target publishes no AAAA record", DOMAIN.TARGET, {
      explains: "IPv6-only connections cannot even resolve, because the name has no AAAA record.",
      // Distinctive: fails at DNS, not at TCP. The engine checks the stage.
      predict: (axisId, value) => {
        if (axisId === "address-family" && value === "ipv6") return PREDICT.FAIL;
        if (axisId === "address-family" && value === "ipv4") return PREDICT.PASS;
        return PREDICT.UNCHANGED;
      },
      distinctiveStage: { axisId: "address-family", value: "ipv6", stage: "dns" }
    }),

    hypothesis("no-local-ipv6", "This machine has no usable IPv6 connectivity", DOMAIN.LOCAL, {
      explains: "IPv6 is unavailable locally, so IPv6-only connections cannot be attempted meaningfully.",
      predict: (axisId, value) => {
        if (axisId === "address-family" && value === "ipv6") return PREDICT.FAIL;
        if (axisId === "address-family" && value === "ipv4") return PREDICT.PASS;
        return PREDICT.UNCHANGED;
      },
      expectedFailStage: { axisId: "address-family", value: "ipv6", notStage: "dns" }
    }),

    hypothesis("resolver", "The configured resolver answers differently or not at all", DOMAIN.DNS, {
      explains: "A different resolver returns a usable answer where the system resolver does not.",
      predict: (axisId) => (axisId === "resolver" ? PREDICT.PASS : PREDICT.UNCHANGED)
    }),

    hypothesis("address-specific", "One specific destination address is unhealthy", DOMAIN.PATH, {
      explains: "Some resolved addresses work and others do not, within the same family.",
      predict: (axisId) => (axisId === "address" ? PREDICT.DIFFERS : PREDICT.UNCHANGED),
      requiresAxis: "address"
    }),

    hypothesis("source-routing", "Egress interface or routing selection is the difference", DOMAIN.LOCAL, {
      explains: "The connection succeeds from one local interface and not another.",
      predict: (axisId) => (axisId === "source-interface" ? PREDICT.DIFFERS : PREDICT.UNCHANGED),
      requiresAxis: "source-interface"
    }),

    hypothesis("tls-version", "A TLS version is not negotiable end to end", DOMAIN.PROTOCOL, {
      explains: "Pinning one TLS version succeeds where the other fails, which is typical of an inspecting middlebox.",
      predict: (axisId) => (axisId === "tls-version" ? PREDICT.DIFFERS : PREDICT.UNCHANGED),
      requiresAxis: "tls-version"
    }),

    hypothesis("alpn", "A negotiated application protocol is not supported end to end", DOMAIN.PROTOCOL, {
      explains: "One ALPN protocol cannot be negotiated while the other can.",
      predict: (axisId) => (axisId === "alpn" ? PREDICT.DIFFERS : PREDICT.UNCHANGED),
      requiresAxis: "alpn"
    }),

    hypothesis("sni-dependency", "The endpoint requires SNI to serve this name", DOMAIN.TARGET, {
      explains: "Omitting SNI changes the outcome, which is normal for name-based virtual hosting.",
      predict: (axisId) => (axisId === "sni" ? PREDICT.FAIL : PREDICT.UNCHANGED),
      requiresAxis: "sni",
      expectedBehaviour: true
    }),

    hypothesis("port-filtering", "Reachability is specific to the destination port", DOMAIN.PATH, {
      explains: "A different port behaves differently, suggesting port-based filtering.",
      predict: (axisId) => (axisId === "port" ? PREDICT.DIFFERS : PREDICT.UNCHANGED),
      requiresAxis: "port"
    }),

    hypothesis("target-down", "The target service is not answering for anyone", DOMAIN.TARGET, {
      explains: "Every condition fails identically, so nothing about this client's selection matters.",
      // The distinctive signature of a dead target: nothing helps.
      predict: () => PREDICT.FAIL
    }),

    hypothesis("general-connectivity", "This machine has no working connectivity at all", DOMAIN.LOCAL, {
      explains: "Every condition fails, including ones that exercise unrelated paths.",
      predict: () => PREDICT.FAIL
    })
  ];

  // With a healthy baseline there is no fault to explain. The live set becomes
  // the capability-difference hypotheses only, and "target is down" is
  // immediately contradicted by the baseline itself.
  if (!baselineFailed) {
    for (const h of all) {
      if (h.id === "target-down" || h.id === "general-connectivity") {
        h.state = STATE.CONTRADICTED;
        h.notes.push("The baseline connection succeeded, so the target and general connectivity are working.");
      }
    }
  }
  return all;
}

/**
 * Remove hypotheses that cannot be tested on this machine/target pair, so the
 * planner never scores an experiment against an untestable explanation.
 */
export function markUntestable(hypotheses, availableAxisIds) {
  for (const h of hypotheses) {
    if (h.requiresAxis && !availableAxisIds.includes(h.requiresAxis)) {
      h.state = STATE.NOT_TESTABLE;
      h.notes.push(`No ${h.requiresAxis} experiment is available for this target or machine.`);
    }
  }
  return hypotheses;
}

export function live(hypotheses) {
  return hypotheses.filter(h => h.state === STATE.STILL_POSSIBLE || h.state === STATE.SUPPORTED || h.state === STATE.WEAKENED);
}

/**
 * Update hypothesis states from one observed experiment outcome.
 *
 * Rules, applied in order and all deterministic:
 *
 *  - A hypothesis that predicted PASS but the experiment FAILED (or the
 *    reverse) is CONTRADICTED.
 *  - A hypothesis that predicted the observed outcome distinctively - meaning
 *    at least one live hypothesis predicted something else - is SUPPORTED.
 *  - A hypothesis with a `distinctiveStage` is contradicted when the stage
 *    does not match, which is what separates "no AAAA published" (fails at
 *    DNS) from "IPv6 path broken" (fails at TCP).
 *  - UNKNOWN predictions never change state; they carried no commitment.
 */
export function applyObservation(hypotheses, { axisId, value, result, stage }, { baselineResult } = {}) {
  const changes = [];
  const liveBefore = live(hypotheses);
  const predictions = new Map(liveBefore.map(h => [h.id, h.predict(axisId, value, { baselineResult })]));
  const committed = [...predictions.values()].filter(p => p !== PREDICT.UNKNOWN);
  const disagreement = new Set(committed).size > 1;

  for (const h of liveBefore) {
    const predicted = predictions.get(h.id);
    if (predicted === PREDICT.UNKNOWN) continue;

    const opposite = baselineResult === RESULT.PASS ? RESULT.FAIL : RESULT.PASS;
    const expected = predicted === PREDICT.UNCHANGED ? baselineResult
      : predicted === PREDICT.DIFFERS ? opposite
        : (predicted === PREDICT.PASS ? RESULT.PASS : RESULT.FAIL);

    // Stage-level discrimination: a hypothesis can claim not just the outcome
    // but where in the connection it must happen.
    if (h.distinctiveStage && h.distinctiveStage.axisId === axisId && h.distinctiveStage.value === value) {
      if (result === RESULT.FAIL && stage && stage !== h.distinctiveStage.stage) {
        h.state = STATE.CONTRADICTED;
        h.notes.push(`Failed at the ${stage} stage, but this explanation requires a failure at the ${h.distinctiveStage.stage} stage.`);
        changes.push({ id: h.id, to: STATE.CONTRADICTED });
        continue;
      }
      if (result === RESULT.FAIL && stage === h.distinctiveStage.stage) {
        h.state = STATE.SUPPORTED;
        h.notes.push(`Failed at the ${stage} stage under ${axisId}=${value}, which is the signature of this explanation.`);
        changes.push({ id: h.id, to: STATE.SUPPORTED });
        continue;
      }
    }

    // A hypothesis that expected a failure at a particular point is weakened
    // when the failure happens somewhere else. This is what separates "the
    // target publishes no AAAA" (fails at DNS) from "the IPv6 path is broken"
    // (fails at TCP).
    if (h.expectedFailStage && h.expectedFailStage.axisId === axisId && h.expectedFailStage.value === value
        && result === RESULT.FAIL && stage && stage === h.expectedFailStage.notStage) {
      h.state = STATE.WEAKENED;
      h.notes.push(`Failed at the ${stage} stage; this explanation predicts a failure after name resolution, not during it.`);
      changes.push({ id: h.id, to: STATE.WEAKENED });
      continue;
    }

    if (result === RESULT.PASS || result === RESULT.FAIL) {
      if (expected !== result && predicted === PREDICT.DIFFERS) {
        // Only says "some variant of this axis differs". This one did not, so
        // the explanation is weaker but not excluded while variants remain.
        h.state = STATE.WEAKENED;
        h.notes.push(`${axisId}=${value} behaved the same as baseline, so this explanation depends on a remaining variant of the same axis.`);
        changes.push({ id: h.id, to: STATE.WEAKENED });
      } else if (expected !== result) {
        h.state = STATE.CONTRADICTED;
        h.notes.push(`Predicted ${expected} for ${axisId}=${value} but observed ${result}.`);
        changes.push({ id: h.id, to: STATE.CONTRADICTED });
      } else if (disagreement && predicted !== PREDICT.UNCHANGED) {
        // Support requires a DISTINCTIVE prediction that was borne out.
        // Predicting "nothing changes" is the default expectation shared by
        // most explanations; being right about it is not evidence for any of
        // them, so those stay STILL_POSSIBLE.
        h.state = STATE.SUPPORTED;
        h.notes.push(`Observed ${result} for ${axisId}=${value}, matching a distinctive prediction while others predicted otherwise.`);
        changes.push({ id: h.id, to: STATE.SUPPORTED });
      }
    }
    // UNSTABLE / INAPPLICABLE / UNSUPPORTED outcomes deliberately change nothing:
    // they are statements about the experiment, not about the network.
  }
  return changes;
}
