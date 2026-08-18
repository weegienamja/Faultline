import { diagnose } from "./diagnose.mjs";

export function mergeProbeEvidence(endpointMetrics, probeRun = null) {
  const merged = { ...endpointMetrics };

  if (!probeRun) {
    delete merged.externalProbeHealthy;
    delete merged.externalProbeLatencyMs;
    return merged;
  }

  merged.externalProbeHealthy = Boolean(probeRun.metrics?.targetReachable);
  const latency = probeRun.metrics?.targetHttpMs ?? probeRun.metrics?.targetTcpMs ?? null;
  merged.externalProbeLatencyMs = latency;
  return merged;
}

export function correlateAgentRun(agentRun) {
  const metrics = mergeProbeEvidence(agentRun.endpointMetrics || agentRun.metrics || {}, agentRun.remoteProbe || null);
  const vantages = {
    endpoint: true,
    remoteProbe: Boolean(agentRun.remoteProbe)
  };

  return {
    ...agentRun,
    source: agentRun.remoteProbe ? "correlated" : "agent",
    metrics,
    vantages,
    diagnosis: diagnose(metrics)
  };
}
