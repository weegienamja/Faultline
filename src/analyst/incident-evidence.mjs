// Flight Recorder incident projection for the Analyst.
//
// Kept separate from evidence.mjs because it projects a recorder record rather
// than a diagnostic one, and because the epistemic shape is different: an
// incident is a comparison of two observed windows, not a determination.
//
// The projection is aggressive about size. A raw incident carries every sample
// in all three windows - potentially a hundred objects - which would dominate
// an 8B model's context and bury the two facts that matter: what differed, and
// what can be tested. Samples are reduced to the boundary ones plus counts.
//
// Two properties are preserved exactly, because they are what stop the model
// turning adjacency into cause:
//
//   classification  stays "temporal_association"
//   note            the qualification travels with the record

const pad = index => String(index + 1).padStart(2, "0");

function trim(value, max = 400) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** One sample reduced to the fields an explanation actually needs. */
function compactSample(sample) {
  if (!sample) return null;
  return {
    at: sample.at,
    state: sample.state,
    targetTcp: sample.connectivity?.targetTcp?.state ?? null,
    targetTcpMs: sample.connectivity?.targetTcp?.ms ?? null,
    ipv4: sample.connectivity?.ipv4?.state ?? null,
    ipv6: sample.connectivity?.ipv6?.state ?? null,
    activeInterface: sample.local?.activeInterface ?? null,
    gateway: sample.local?.gateway ?? null,
    resolvers: sample.local?.resolvers ?? [],
    vpn: sample.local?.vpn?.active ?? null,
    reasons: sample.reasons ?? []
  };
}

export function projectIncident(incident) {
  if (!incident || typeof incident !== "object") return null;

  const refs = [];
  const change = incident.observedChange || {};

  refs.push({ ref: incident.id, kind: "incident", view: "recorder", label: incident.trigger?.summary || incident.id });

  const differences = (change.differences || []).map((difference, index) => {
    const ref = `CHG-${pad(index)}`;
    refs.push({ ref, kind: "change", view: "recorder", label: `${difference.label} changed` });
    return {
      ref,
      property: difference.label,
      healthyValue: trim(difference.from, 160),
      failingValue: trim(difference.to, 160),
      testableByBisect: Boolean(difference.bisectAxis),
      bisectAxis: difference.bisectAxis ?? null
    };
  });

  const windows = incident.windows || {};
  const boundary = entry => ({
    count: entry?.samples?.length ?? 0,
    from: entry?.from ?? null,
    to: entry?.to ?? null,
    // First and last only: the shape of the window without its bulk.
    first: compactSample(entry?.samples?.[0]),
    last: compactSample(entry?.samples?.at?.(-1))
  });

  if (incident.deepCapture?.available) {
    refs.push({ ref: "DEEP-01", kind: "deep-capture", view: "recorder", label: "Deep capture at the trigger" });
  }

  return {
    artefact: "flight_recorder_incident",
    // Observed, not deterministic: the recorder watched, it did not experiment.
    evidenceClass: incident.simulated ? "simulated" : "observed",
    simulated: incident.simulated === true,
    scenario: incident.scenario ?? null,
    id: incident.id,
    target: incident.target ? { host: incident.target.host, port: incident.target.port } : null,
    trigger: {
      type: incident.trigger?.type ?? null,
      at: incident.trigger?.at ?? null,
      summary: trim(incident.trigger?.summary, 200),
      manual: incident.trigger?.manual === true
    },
    concurrentTriggers: (incident.concurrentTriggers || []).map(entry => ({ type: entry.type, at: entry.at, summary: trim(entry.summary, 160) })),
    windows: { before: boundary(windows.before), during: boundary(windows.during), after: boundary(windows.after) },
    observedChange: {
      comparable: change.comparable === true,
      hadFailure: change.hadFailure ?? null,
      reason: trim(change.reason, 300),
      statement: trim(change.statement, 800),
      differences,
      unchangedCount: (change.unchanged || []).length,
      recovery: change.recovery ? { at: change.recovery.at } : null,
      // Copied verbatim. The model must not restate these more strongly.
      classification: change.classification ?? null,
      note: trim(change.note, 300)
    },
    candidateDiscriminators: {
      available: incident.candidateDiscriminators?.available === true,
      testable: (incident.candidateDiscriminators?.testable || []).map(entry => ({
        condition: entry.condition,
        axis: entry.axis,
        healthyValue: trim(entry.healthyValue, 120),
        failingValue: trim(entry.failingValue, 120)
      })),
      untestable: (incident.candidateDiscriminators?.untestable || []).map(entry => ({
        condition: entry.condition,
        reason: entry.reason
      })),
      bisectAxes: incident.candidateDiscriminators?.bisectAxes || [],
      note: trim(incident.candidateDiscriminators?.note, 300)
    },
    deepCapture: incident.deepCapture?.available
      ? {
          ref: "DEEP-01",
          stages: (incident.deepCapture.stages || []).map(stage => ({ name: stage.name, state: stage.state, ms: stage.ms, detail: trim(stage.detail, 160) })),
          external: incident.deepCapture.external ?? null,
          // The engine's own conclusion, unmodified.
          deterministic: incident.deepCapture.deterministic ?? null
        }
      : { available: false, reason: trim(incident.deepCapture?.reason, 200) },
    epistemics: {
      ...incident.epistemics,
      forTheAnalyst: incident.simulated
        ? "THIS INCIDENT IS SIMULATED. It was generated from a scenario file and is not a measurement of any real network. Say so explicitly in your answer, and never present it as evidence about the user's network."
        : "This is a comparison of two observed windows. Do not describe any difference as the cause of the failure. Network Bisect is what can test a candidate condition."
    },
    refs
  };
}
