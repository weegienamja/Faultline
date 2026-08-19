// Deep capture.
//
// The one heavyweight operation the recorder performs, and only when a trigger
// has already fired. It answers the question a lightweight sample cannot:
// "the connection failed - at which stage, and does anyone else see it?"
//
// It is a thin adapter over the existing live diagnostic rather than a second
// measurement stack. Faultline already knows how to measure DNS/TCP/TLS/HTTP,
// walk the path and ask independent vantage points; duplicating that here would
// create two implementations that could disagree about the same network.
//
// The projection keeps only what belongs in an incident record. A full live
// diagnostic carries external routing intelligence and a complete path table,
// which would dwarf the sample windows it sits between.

import { runLiveDiagnostic } from "../live/diagnostic.mjs";

/**
 * Build the capture function handed to the recorder.
 *
 * Injectable so tests never make a real measurement, and so a deployment can
 * disable the deep capture entirely without disabling recording.
 */
export function createDeepCapture({ run = runLiveDiagnostic, scope = "public", traceroute = true, distributed = true } = {}) {
  return async function deepCapture({ target }) {
    const startedAt = new Date().toISOString();
    const result = await run({
      target: target.input || target.host,
      port: target.port,
      scope,
      traceroute,
      // An independent vantage is what distinguishes "the target is down" from
      // "this endpoint cannot reach it", which is the question an incident
      // usually turns on.
      distributed,
      enrich: false
    });

    return { startedAt, completedAt: new Date().toISOString(), ...projectDeepCapture(result) };
  };
}

/** Compact projection of a live diagnostic for embedding in an incident. */
export function projectDeepCapture(result) {
  if (!result || typeof result !== "object") {
    return { available: false, reason: "The diagnostic returned no result." };
  }

  const stages = (result.observed?.stages || []).map(stage => ({
    name: stage.name,
    state: stage.state,
    ms: stage.ms ?? null,
    detail: typeof stage.detail === "string" ? stage.detail.slice(0, 200) : null
  }));

  // Whether THIS endpoint reached the target, so the two-vantage comparison
  // below states what actually happened rather than assuming a local failure.
  const localStage = stages.find(stage => stage.name === "TCP");
  const localReached = localStage ? localStage.state === "pass" : null;

  const distributed = result.distributed;
  const external = distributed?.status === "ok" && distributed.data?.summary
    ? {
        state: distributed.data.summary.reachable > 0 ? "reachable" : "unreachable",
        reachable: distributed.data.summary.reachable,
        total: distributed.data.summary.total,
        medianLatencyMs: distributed.data.summary.medianLatencyMs ?? null,
        localReached,
        // The single most useful line in an incident: it separates a local
        // problem from a target-wide one without any inference. All four
        // combinations are stated explicitly, because asserting the endpoint
        // failed when it did not would be a plain falsehood on the record.
        meaning: describeTwoVantage(distributed.data.summary.reachable > 0, localReached)
      }
    : { state: "not-measured", localReached, reason: distributed?.reason || distributed?.error || "No independent vantage was available." };

  return {
    runId: result.id ?? null,
    stages,
    // Copied verbatim: the deterministic engine owns this conclusion.
    deterministic: result.deterministic?.diagnosis
      ? {
          faultDomain: result.deterministic.diagnosis.faultDomain,
          faultDomainLabel: result.deterministic.diagnosis.faultDomainLabel,
          confidence: result.deterministic.diagnosis.confidence,
          summary: result.deterministic.diagnosis.summary
        }
      : null,
    external,
    path: (result.observed?.path || []).slice(0, 12).map(hop => ({
      hop: hop.hop ?? null,
      address: hop.address ?? null,
      rttMs: hop.rttMs ?? null
    })),
    resolvedAddress: result.target?.resolvedAddress ?? null,
    note: "Measured once, immediately after the trigger. Stages marked not-measured were not reached."
  };
}

/** The two-vantage comparison, stated for whichever combination occurred. */
function describeTwoVantage(externalReached, localReached) {
  if (localReached === null) {
    return externalReached
      ? "Independent vantage points reached the target."
      : "Independent vantage points did not reach the target.";
  }
  if (externalReached && localReached === false) {
    return "Independent vantage points reached the target while this endpoint did not.";
  }
  if (externalReached && localReached === true) {
    return "Both this endpoint and independent vantage points reached the target at capture time.";
  }
  if (!externalReached && localReached === true) {
    return "This endpoint reached the target while independent vantage points did not.";
  }
  return "Neither this endpoint nor independent vantage points reached the target.";
}
