// Portable Incident Capsule.
//
// One self-contained evidence container for a single Flight Recorder incident:
// what was observed, what changed, what was tested, what was concluded, and
// what was explicitly NOT concluded.
//
// The organising rule is that the capsule never flattens evidence classes. Four
// kinds of statement live in here and a reader must never have to infer which
// is which:
//
//   OBSERVED                  Flight Recorder samples
//   DETERMINISTIC COMPARISON  what differed between two observed windows
//   DETERMINISTIC EXPERIMENT  Network Bisect, which varied one condition
//   INTERPRETATION            optional Analyst explanation
//
// Provenance belongs to each artefact as well as to the capsule. A simulated
// incident followed by a real Bisect run is a legitimate combination - and a
// good demonstration of the evidence model - so the capsule must be able to say
// "this half was scripted, this half was measured" rather than stamping one
// flag at the root and implying it covers everything.

import { sealIntegrity } from "./integrity.mjs";
import { redactCapsule } from "./redaction.mjs";
import { summariseAttachment } from "../recorder/attachments.mjs";

export const CAPSULE_SCHEMA = "faultline.incident-capsule";
export const CAPSULE_SCHEMA_VERSION = 1;

/** Semantic grouping for observed differences. */
const DIFFERENCE_GROUPS = Object.freeze({
  activeInterface: "Network path",
  defaultRoute: "Network path",
  gateway: "Network path",
  vpn: "Network path",
  wifiSsid: "Network path",
  wifiBssid: "Network path",
  publicIp: "Network path",
  resolvers: "Name resolution",
  resolvedAddress: "Name resolution",
  ipv4: "Connectivity",
  ipv6: "Connectivity"
});

const GROUP_ORDER = ["Network path", "Name resolution", "Connectivity", "Other"];

/**
 * Group differences semantically.
 *
 * A VPN coming up produces interface, route, gateway and VPN-state changes at
 * once. Rendering those as four peers invites a reader to treat them as four
 * independent hypotheses when they are one event seen four ways.
 */
export function groupDifferences(differences = []) {
  const groups = new Map();
  for (const difference of differences) {
    const name = DIFFERENCE_GROUPS[difference.key] || "Other";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({
      key: difference.key,
      property: difference.label,
      from: difference.from,
      to: difference.to,
      testable: Boolean(difference.bisectAxis),
      bisectAxis: difference.bisectAxis ?? null
    });
  }
  return GROUP_ORDER
    .filter(name => groups.has(name))
    .map(name => ({ group: name, changes: groups.get(name) }));
}

/**
 * Fold candidate conditions together with any experiment that tested them.
 *
 * The vpn-route-loss case is the reason this exists: five simultaneous observed
 * differences collapse to ONE testable axis, and the capsule should say that
 * rather than presenting five equal-weight candidates.
 */
export function buildTestableConditions(incident, attachments) {
  const candidates = incident.candidateDiscriminators || {};
  const bisectRuns = attachments.filter(entry => entry.kind === "network-bisect");

  const conditions = (candidates.bisectAxes || []).map(axis => {
    const contributing = (candidates.testable || []).filter(entry => entry.axis === axis);
    const run = bisectRuns.find(entry => (entry.origin?.requestedAxes || []).includes(axis)) ?? null;

    return {
      axis,
      // Stated explicitly so a single axis backed by four observations is not
      // mistaken for a single observation.
      derivedFrom: contributing.map(entry => entry.condition),
      derivedFromCount: contributing.length,
      note: contributing.length > 1
        ? "Derived from multiple simultaneous observed changes."
        : null,
      tested: Boolean(run),
      experiment: run
        ? {
            evidenceId: run.id,
            evidenceClass: run.evidenceClass,
            simulated: run.simulated === true,
            classification: run.payload?.conclusion?.classification ?? null,
            stoppingReason: run.payload?.stoppingReason ?? null,
            confirmed: run.payload?.confirmation?.confirmed ?? null
          }
        : null
    };
  });

  return {
    count: conditions.length,
    conditions,
    untestable: (candidates.untestable || []).map(entry => ({
      condition: entry.condition,
      reason: entry.reason
    })),
    note: candidates.note ?? null
  };
}

/** The one-line answer, if the evidence produced one. */
function buildConclusion(incident, attachments) {
  const run = attachments.find(entry => entry.kind === "network-bisect" && entry.payload?.conclusion);
  if (!run) {
    return {
      available: false,
      reason: "No experiment was run against this incident, so nothing was tested and no deterministic conclusion exists.",
      // Said here rather than left to the reader, because the absence of a
      // conclusion is itself information.
      observedOnly: true
    };
  }

  const conclusion = run.payload.conclusion;
  return {
    available: true,
    evidenceClass: "deterministic",
    evidenceId: run.id,
    classification: conclusion.classification ?? null,
    headline: conclusion.headline ?? null,
    detail: conclusion.detail ?? null,
    claim: conclusion.claim ?? null,
    stoppingReason: run.payload.stoppingReason ?? null,
    confirmed: run.payload.confirmation?.confirmed ?? null,
    establishes: "Changing this condition changed the outcome reproducibly, under interleaved A/B confirmation.",
    // The boundary Faultline exists to hold.
    doesNotEstablish: "Why that condition fails. A confirmed discriminator is an association, not a cause."
  };
}

/** Ordered events, so a reader can follow what happened without reading JSON. */
function buildTimeline(incident, attachments) {
  const events = [];
  const windows = incident.windows || {};

  if (windows.before?.from) {
    events.push({ at: windows.before.from, kind: "recording", label: "Recording started", detail: `${windows.before.samples?.length ?? 0} healthy samples retained` });
  }
  if (incident.trigger?.at) {
    events.push({ at: incident.trigger.at, kind: "trigger", label: incident.trigger.summary || "Trigger", detail: incident.trigger.detail ?? null });
  }
  if (incident.deepCapture?.available && incident.deepCapture.startedAt) {
    events.push({ at: incident.deepCapture.startedAt, kind: "deep-capture", label: "Deep capture", detail: "One heavyweight diagnostic run at the trigger" });
  }
  if (incident.observedChange?.recovery?.at) {
    events.push({ at: incident.observedChange.recovery.at, kind: "recovery", label: "Target reachable again", detail: null });
  }
  for (const attachment of attachments) {
    events.push({
      at: attachment.createdAt,
      kind: "experiment",
      label: attachment.kind === "network-bisect" ? "Network Bisect run" : attachment.kind,
      detail: attachment.payload?.conclusion?.classification ?? null,
      evidenceId: attachment.id
    });
  }
  if (incident.closedAt) {
    events.push({ at: incident.closedAt, kind: "closed", label: "Incident closed", detail: incident.closeReason ?? null });
  }

  return events
    .filter(event => event.at)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Build the capsule.
 *
 * `interpretation` is optional and never fetched here: export must not depend
 * on a language model being installed or running.
 */
export function buildCapsule({
  incident,
  attachments = [],
  interpretation = null,
  redaction = "none",
  faultlineVersion = "unknown",
  now = () => new Date()
}) {
  if (!incident?.id) {
    const error = new Error("An incident is required to build a capsule.");
    error.statusCode = 400;
    throw error;
  }

  const observedChange = incident.observedChange || {};

  const payload = {
    schema: CAPSULE_SCHEMA,
    schemaVersion: CAPSULE_SCHEMA_VERSION,
    generatedAt: now().toISOString(),

    incident: {
      id: incident.id,
      // Provenance for the recorder half specifically.
      source: incident.source ?? "measured",
      simulated: incident.simulated === true,
      scenario: incident.scenario ?? null,
      evidenceClass: incident.evidenceClass ?? "observed",
      target: incident.target ?? null,
      trigger: incident.trigger ?? null,
      concurrentTriggers: incident.concurrentTriggers ?? [],
      closedAt: incident.closedAt ?? null,
      closeReason: incident.closeReason ?? null,
      contract: incident.contract ?? null
    },

    timeline: buildTimeline(incident, attachments),

    evidence: {
      // OBSERVED -----------------------------------------------------------
      recorder: {
        evidenceClass: incident.simulated ? "simulated" : "observed",
        simulated: incident.simulated === true,
        windows: incident.windows ?? { before: {}, during: {}, after: {} },
        deepCapture: incident.deepCapture ?? null,
        epistemics: incident.epistemics ?? null
      },

      // DETERMINISTIC COMPARISON -------------------------------------------
      comparison: {
        evidenceClass: "deterministic-comparison",
        comparable: observedChange.comparable === true,
        hadFailure: observedChange.hadFailure ?? null,
        reason: observedChange.reason ?? null,
        statement: observedChange.statement ?? null,
        classification: observedChange.classification ?? null,
        note: observedChange.note ?? null,
        differenceCount: (observedChange.differences || []).length,
        groups: groupDifferences(observedChange.differences || []),
        unchanged: observedChange.unchanged ?? [],
        recovery: observedChange.recovery ?? null
      },

      // DETERMINISTIC EXPERIMENT -------------------------------------------
      testableConditions: buildTestableConditions(incident, attachments),
      experiments: attachments.map(attachment => ({
        id: attachment.id,
        kind: attachment.kind,
        evidenceClass: attachment.evidenceClass,
        // Per-artefact provenance: a real experiment inside a simulated capsule.
        source: attachment.source ?? "measured",
        simulated: attachment.simulated === true,
        createdAt: attachment.createdAt,
        origin: attachment.origin ?? null,
        epistemics: attachment.epistemics ?? null,
        payload: attachment.payload ?? null
      })),

      // INTERPRETATION -----------------------------------------------------
      interpretation: interpretation
        ? {
            evidenceClass: "interpretation",
            note: "Generated by a local language model. Explanatory only; it is not a Faultline determination.",
            ...interpretation
          }
        : null
    },

    conclusion: buildConclusion(incident, attachments),

    provenance: {
      faultlineVersion,
      capsuleVersion: CAPSULE_SCHEMA_VERSION,
      // Two flags, deliberately separate. `containsSimulated` says something
      // scripted is inside; `fullySimulated` says everything is.
      containsSimulated: incident.simulated === true || attachments.some(entry => entry.simulated === true),
      fullySimulated: incident.simulated === true && attachments.every(entry => entry.simulated === true),
      artefacts: [
        { id: incident.id, kind: "flight-recorder-incident", evidenceClass: incident.evidenceClass ?? "observed", simulated: incident.simulated === true, scenario: incident.scenario ?? null },
        ...attachments.map(summariseAttachment).map(entry => ({
          id: entry.id, kind: entry.kind, evidenceClass: entry.evidenceClass, simulated: entry.simulated, scenario: null
        }))
      ],
      evidenceClasses: {
        observed: "Measured by the Flight Recorder from the machine that ran it.",
        "deterministic-comparison": "A fixed-rule comparison of two observed windows. Association, never cause.",
        deterministic: "A controlled experiment that varied one condition, with paired confirmation.",
        simulated: "Generated from a scenario file. Not a measurement of any real network.",
        interpretation: "A language model's explanation of the evidence. Not a Faultline determination."
      }
    }
  };

  const { payload: redactedPayload, redaction: redactionState } = redactCapsule(payload, redaction);

  // Integrity is sealed last, over the payload that will actually ship.
  return sealIntegrity(
    { ...redactedPayload, redaction: redactionState },
    { scope: "canonical capsule payload excluding the integrity field" }
  );
}

/** Filename for an exported capsule. */
export function capsuleFilename(incidentId, { extension = "html" } = {}) {
  // Identifier characters only. Dots are excluded as well as separators, so a
  // traversal attempt cannot survive as a leading-dot filename either.
  const safe = String(incidentId).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "incident";
  return `faultline-${safe}.${extension}`;
}
