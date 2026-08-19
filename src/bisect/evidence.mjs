// Turning a completed bisect run into Faultline case evidence.
//
// The report is already a self-describing record, so this only needs to select
// the parts that belong in an evidence package and tag the evidence class.
// Nothing here contacts the network or stores credentials.

/**
 * Build the evidence object for a completed adaptive or exhaustive run.
 * Evidence class is DETERMINISTIC: the conclusion follows from fixed rules
 * over observed measurements, with no external context involved.
 */
export function bisectEvidence(report) {
  if (!report || report.schema !== "faultline.network-bisect") {
    throw new Error("A Network Bisect report is required.");
  }
  return {
    schema: report.schema,
    schemaVersion: report.schemaVersion,
    evidenceClass: "deterministic",
    mode: report.mode || "exhaustive",
    engineVersion: report.engineVersion || null,
    target: report.target,
    startedAt: report.startedAt,
    completedAt: report.completedAt,
    baseline: report.baseline,
    // Interface classification is local context and carries no addresses beyond
    // this machine's own, which never leave the control plane.
    interfaces: report.interfaces || [],
    experiments: {
      available: report.experimentsAvailable ?? null,
      executed: report.executed || [],
      skipped: report.skipped || [],
      unavailableAxes: report.axesUnavailable || []
    },
    confirmation: report.confirmation || null,
    hypotheses: report.hypotheses || [],
    transcript: report.transcript || [],
    conclusion: report.verdict,
    stoppingReason: report.verdict?.stop || report.verdict?.kind || null,
    counters: report.counters || null,
    note: "Association, not proof of cause. Experiment selection and the conclusion follow deterministic rules."
  };
}

/** Timeline event so a bisect result can be attached to a support case. */
export function bisectCaseEvent(report) {
  const v = report.verdict || {};
  return {
    type: "diagnostic.network_bisect",
    actor: "faultline",
    source: "network-bisect",
    summary: `${v.classification || v.kind || "result"}: ${v.headline || "network bisect completed"}`,
    evidenceKind: "deterministic",
    metadata: {
      target: report.target?.host || null,
      baseline: report.baseline?.state || null,
      stoppingReason: v.stop || v.kind || null,
      connections: report.counters?.connections ?? report.trialCount ?? null
    }
  };
}
