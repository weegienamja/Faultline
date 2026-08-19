// Evidence projection.
//
// Turns Faultline's internal records into the compact, referenceable form the
// Analyst is allowed to see. Two jobs:
//
//   1. Shrink. A bisect report carries a full transcript, per-trial detail and
//      interface tables. Feeding that to an 8B model wastes context and buries
//      the discriminating facts. Tools return the decision-relevant subset.
//   2. Reference. Every fact the model can cite gets a stable short id -
//      EXP-01, CONF-01, BASE-01, STG-TCP, DIAG-01 - so an answer can point at
//      the evidence that supports it and the UI can link back to the panel.
//
// Ids are positional and derived deterministically from the record, so the same
// report always yields the same ids and a citation stays meaningful.
//
// Nothing here interprets. Classification, verdicts and stopping reasons are
// copied from the deterministic engine verbatim; this module never invents a
// conclusion or softens one.

const pad = index => String(index + 1).padStart(2, "0");

/** Cap free text coming from a record so one field cannot flood the context. */
function trim(value, max = 400) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Compact view of a Network Bisect report.
 *
 * `refs` is the citation table: the model is told these ids and only these ids
 * exist for this artefact, and the UI resolves them back to a destination.
 */
export function projectBisectRun(report) {
  if (!report || typeof report !== "object") return null;

  const refs = [];
  const executed = Array.isArray(report.executed) ? report.executed : [];

  const baseline = report.baseline
    ? {
        ref: "BASE-01",
        state: report.baseline.state ?? null,
        result: report.baseline.result ?? null,
        passes: report.baseline.passes ?? null,
        total: report.baseline.total ?? null,
        stage: report.baseline.stage ?? null,
        reason: trim(report.baseline.reason, 200)
      }
    : null;
  if (baseline) {
    refs.push({ ref: "BASE-01", kind: "baseline", view: "bisect", label: `Baseline ${baseline.result ?? ""}`.trim() });
  }

  const experiments = executed.map((entry, index) => {
    const ref = `EXP-${pad(index)}`;
    refs.push({
      ref,
      kind: "experiment",
      view: "bisect",
      label: `${entry.axisLabel || entry.axisId || "Experiment"}: ${entry.label ?? ""}`.trim()
    });
    return {
      ref,
      id: entry.id ?? null,
      axis: entry.axisId ?? null,
      axisLabel: entry.axisLabel ?? null,
      variant: entry.label ?? null,
      result: entry.result ?? null,
      passes: entry.passes ?? null,
      total: entry.total ?? null,
      stage: entry.stage ?? null,
      reason: trim(entry.reason, 200),
      // Why the engine picked this experiment - the question users actually ask.
      chosenBecause: trim(entry.selectionReason, 240)
    };
  });

  let confirmation = null;
  if (report.confirmation) {
    refs.push({ ref: "CONF-01", kind: "confirmation", view: "bisect", label: "Interleaved A/B confirmation" });
    confirmation = {
      ref: "CONF-01",
      experimentId: report.confirmation.experimentId ?? null,
      label: report.confirmation.label ?? null,
      confirmed: report.confirmation.confirmed ?? null,
      pairs: report.confirmation.pairs ?? null,
      baselinePasses: report.confirmation.baselinePasses ?? null,
      variantPasses: report.confirmation.variantPasses ?? null
    };
  }

  // Skipped work matters: INAPPLICABLE is a real state and the model must not
  // be allowed to silently reinterpret an untested axis as a failing one.
  const skipped = (Array.isArray(report.skipped) ? report.skipped : []).slice(0, 12).map(entry => ({
    axis: entry.axisId ?? entry.axis ?? null,
    variant: entry.label ?? null,
    reason: trim(entry.skip || entry.reason, 160)
  }));

  const hypotheses = (Array.isArray(report.hypotheses) ? report.hypotheses : []).map(entry => ({
    id: entry.id ?? null,
    label: entry.label ?? null,
    domain: entry.domain ?? null,
    state: entry.state ?? null
  }));

  return {
    artefact: "network_bisect_run",
    evidenceClass: "deterministic",
    runId: report.id ?? null,
    schema: report.schema ?? null,
    mode: report.mode ?? null,
    engineVersion: report.engineVersion ?? null,
    startedAt: report.startedAt ?? null,
    completedAt: report.completedAt ?? null,
    target: report.target
      ? { host: report.target.host ?? null, port: report.target.port ?? null, scheme: report.target.scheme ?? null }
      : null,
    baseline,
    experiments,
    confirmation,
    skipped,
    axesUnavailable: (Array.isArray(report.axesUnavailable) ? report.axesUnavailable : [])
      .slice(0, 8)
      .map(entry => ({ axis: entry.axisId ?? entry.axis ?? null, reason: trim(entry.reason, 160) })),
    hypotheses,
    verdict: report.verdict
      ? {
          classification: report.verdict.classification ?? null,
          stoppingReason: report.verdict.stop ?? report.verdict.kind ?? null,
          headline: trim(report.verdict.headline, 240),
          detail: trim(report.verdict.detail, 700),
          claim: trim(report.verdict.claim, 300),
          recommendation: trim(report.verdict.recommendation, 300)
        }
      : null,
    counters: report.counters ?? null,
    epistemics: {
      observed: "Every result is a real connection attempt made from this machine.",
      limit: "A confirmed discriminator establishes association, not causation.",
      authority: "This verdict is a deterministic Faultline finding. It is not an Analyst opinion."
    },
    refs
  };
}

/** Compact view of a live diagnostic run. */
export function projectLiveDiagnostic(run) {
  if (!run || typeof run !== "object") return null;

  const refs = [];
  const stages = (run.observed?.stages || []).map(stage => {
    const key = String(stage.name || "STAGE").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const ref = `STG-${key}`;
    refs.push({ ref, kind: "stage", view: "live", label: `${stage.name} stage` });
    return {
      ref,
      name: stage.name ?? null,
      state: stage.state ?? null,
      ms: stage.ms ?? null,
      detail: trim(stage.detail, 200)
    };
  });

  const diagnosis = run.deterministic?.diagnosis || null;
  if (diagnosis) {
    refs.push({ ref: "DIAG-01", kind: "diagnosis", view: "live", label: "Deterministic fault-domain conclusion" });
  }

  const path = (run.observed?.path || []).slice(0, 20).map((hop, index) => {
    const ref = `PATH-${pad(index)}`;
    refs.push({ ref, kind: "hop", view: "topology", label: `Hop ${hop.hop ?? index + 1}` });
    return {
      ref,
      hop: hop.hop ?? index + 1,
      address: hop.address ?? null,
      rttMs: hop.rttMs ?? null,
      asn: hop.asn ?? hop.origin ?? null,
      holder: trim(hop.holder, 120)
    };
  });

  return {
    artefact: "live_diagnostic",
    evidenceClass: "mixed",
    runId: run.id ?? null,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    scope: run.scope ?? null,
    target: run.target
      ? {
          host: run.target.host ?? null,
          port: run.target.port ?? null,
          resolvedAddress: run.target.resolvedAddress ?? null,
          resolvedFamily: run.target.resolvedFamily ?? null,
          resolveError: trim(run.target.resolveError, 200),
          addressScope: run.target.addressScope ?? null
        }
      : null,
    observed: {
      stages,
      local: run.observed?.local
        ? {
            platform: run.observed.local.platform ?? null,
            supported: run.observed.local.supported ?? null,
            state: run.observed.local.state ?? null,
            ipv4: run.observed.local.ipv4 ?? null,
            ipv6: run.observed.local.ipv6 ?? null,
            gateway: run.observed.local.gateway ?? null,
            vpn: run.observed.local.vpn ?? null,
            internetReachable: run.observed.local.internetReachable ?? null
          }
        : null,
      dnsState: run.observed?.dns?.state ?? null,
      traceroute: run.observed?.traceroute ?? null
    },
    // Kept separate from `observed` so the model cannot present a derived
    // topology as something that was measured.
    inferred: run.inferred?.topology
      ? { topology: { shape: run.inferred.topology.shape ?? null, confidence: run.inferred.topology.confidence ?? null } }
      : null,
    deterministic: diagnosis
      ? {
          ref: "DIAG-01",
          faultDomain: diagnosis.faultDomain ?? null,
          faultDomainLabel: diagnosis.faultDomainLabel ?? null,
          confidence: diagnosis.confidence ?? null,
          severity: diagnosis.severity ?? null,
          summary: trim(diagnosis.summary, 400),
          evidence: (diagnosis.evidence || []).slice(0, 14).map(item => ({
            label: item.label ?? null,
            status: item.status ?? null,
            value: item.value ?? null,
            detail: trim(item.detail, 200)
          })),
          actions: (diagnosis.actions || []).slice(0, 6).map(action => trim(action, 200))
        }
      : null,
    path,
    // External context is supporting material only. Labelled so the model is
    // structurally discouraged from treating it as a measurement.
    externalContext: run.internetContext
      ? {
          note: "Public Internet context. Supporting evidence only, never proof of a local fault.",
          asn: run.internetContext.asn ?? null,
          holder: trim(run.internetContext.holder, 160),
          prefix: run.internetContext.prefix ?? null,
          rpki: run.internetContext.rpki ?? null
        }
      : null,
    epistemics: {
      authority: "The deterministic fault domain is the authoritative Faultline finding.",
      limit: "Stages marked not-measured or n/a were not tested and must not be reported as failures."
    },
    refs
  };
}

/** Compact view of a support case. */
export function projectCase(caseRecord) {
  if (!caseRecord || typeof caseRecord !== "object") return null;
  const ref = `CASE-${caseRecord.id}`;
  return {
    artefact: "support_case",
    evidenceClass: "record",
    ref,
    id: caseRecord.id ?? null,
    title: trim(caseRecord.title, 200),
    status: caseRecord.status ?? null,
    severity: caseRecord.severity ?? null,
    customer: trim(caseRecord.customer, 120),
    createdAt: caseRecord.createdAt ?? null,
    updatedAt: caseRecord.updatedAt ?? null,
    sessionIds: (caseRecord.sessionIds || []).slice(0, 20),
    notes: (caseRecord.notes || []).slice(-6).map(note => ({
      at: note.at ?? null,
      author: trim(note.author, 80),
      body: trim(note.body, 300)
    })),
    timeline: (caseRecord.events || caseRecord.timeline || []).slice(-12).map(event => ({
      at: event.at ?? null,
      type: event.type ?? null,
      evidenceKind: event.evidenceKind ?? null,
      summary: trim(event.summary, 200)
    })),
    refs: [{ ref, kind: "case", view: "cases", label: caseRecord.title || caseRecord.id }]
  };
}

/**
 * Collect every citable id an evidence bundle exposes.
 * The gateway uses this to reject citations the model invented.
 */
export function collectRefs(...projections) {
  const table = new Map();
  for (const projection of projections) {
    for (const entry of projection?.refs || []) {
      if (entry?.ref && !table.has(entry.ref)) table.set(entry.ref, entry);
    }
  }
  return table;
}
