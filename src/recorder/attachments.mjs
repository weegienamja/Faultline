// Incident evidence attachments.
//
// Evidence produced ABOUT an incident after it closed - most obviously a
// Network Bisect run started from its candidate conditions.
//
// These are kept separate from the incident rather than merged into it, because
// the closed incident is the immutable record of what was OBSERVED. Running a
// later experiment must not rewrite that. The two also carry different epistemic
// weight and must not be flattened together:
//
//   incident      OBSERVED                  the recorder watched
//   attachment    DETERMINISTIC EXPERIMENT  Bisect varied one condition
//
// Provenance travels with each attachment, not only with the incident. A
// simulated incident followed by a real Bisect run is a legitimate and useful
// combination, and the capsule has to be able to say so precisely.

import { randomUUID } from "node:crypto";

import { bisectEvidence } from "../bisect/evidence.mjs";

export const EVIDENCE_KIND = Object.freeze({
  NETWORK_BISECT: "network-bisect",
  ANALYST_INTERPRETATION: "analyst-interpretation"
});

/** FLE-… Distinct from FLR-… so an id says which kind of thing it names. */
export function nextEvidenceId() {
  return `FLE-${randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

/**
 * Wrap a completed Network Bisect report as a durable attachment.
 *
 * `bisectEvidence()` already projects a report into an evidence artefact with
 * its baseline, executed and skipped experiments, unavailable axes,
 * confirmation, hypotheses, transcript, verdict, stopping reason and counters -
 * so this adds the attachment envelope rather than a second projection.
 */
export function buildBisectAttachment({ incident, report, requestedAxes = [], simulated = false, now = () => new Date() }) {
  if (!incident?.id) throw new Error("An incident is required to attach evidence.");

  // A Bisect run normally makes real connections, and is deterministic evidence
  // even when the incident that prompted it was scripted. The hosted public
  // demo is the exception: it REPLAYS an isolation run through the production
  // engine against the recorded endpoint's behaviour, because a Vercel Function
  // cannot bind a visitor's VPN adapter or lose their IPv6 path. That run is
  // still deterministic reasoning, but its trial outcomes are scripted, and the
  // attachment has to be able to say which of the two it is.
  const replayed = simulated === true;

  return {
    id: nextEvidenceId(),
    incidentId: incident.id,
    kind: EVIDENCE_KIND.NETWORK_BISECT,
    evidenceClass: replayed ? "simulated" : "deterministic",
    source: replayed ? "replay" : "measured",
    simulated: replayed,
    createdAt: now().toISOString(),
    // Why this experiment was run at all: the conditions the recorder observed.
    origin: {
      incidentId: incident.id,
      incidentSimulated: incident.simulated === true,
      incidentScenario: incident.scenario ?? null,
      requestedAxes: [...requestedAxes],
      reason: "Network Bisect was run against the conditions the Flight Recorder observed changing."
    },
    payload: bisectEvidence(report),
    epistemics: {
      establishes: replayed
        ? "How the production isolation engine reasons over the recorded endpoint's behaviour, and which condition it identifies as the discriminator."
        : "Whether changing one condition changes the outcome, under paired confirmation.",
      limit: "A confirmed discriminator establishes association, not cause.",
      // The distinction the capsule must never blur.
      relationToIncident: replayed
        ? "Both the incident and this experiment are replayed from a recorded scenario. Neither is a measurement of a real network."
        : incident.simulated === true
          ? "The incident was simulated; this experiment was not. Its measurements are real."
          : "The incident and this experiment are both real measurements."
    }
  };
}

/** Compact descriptor for lists and status. */
export function summariseAttachment(attachment) {
  return {
    id: attachment.id,
    incidentId: attachment.incidentId,
    kind: attachment.kind,
    evidenceClass: attachment.evidenceClass,
    simulated: attachment.simulated === true,
    createdAt: attachment.createdAt,
    // The one fact a list needs from a Bisect run.
    classification: attachment.payload?.conclusion?.classification ?? null,
    stoppingReason: attachment.payload?.stoppingReason ?? null,
    requestedAxes: attachment.origin?.requestedAxes ?? []
  };
}
