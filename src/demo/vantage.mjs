// Vantage scoping for a deterministic diagnosis.
//
// The rule engine in src/engine/diagnose.mjs is written for an ENDPOINT: it
// reasons about a default gateway, ICMP loss on the endpoint path and jitter,
// and where it has no input it falls back to a healthy default. That is correct
// on a laptop and dangerous on a hosted deployment, because "Gateway packet
// loss - PASS - the local path to the default gateway is stable" would be a
// statement about a visitor's home network that nobody measured.
//
// So the engine output is never edited. It is PARTITIONED:
//
//   inScope       findings whose inputs this vantage genuinely measured
//   notObservable findings whose inputs it did not, restated as not-measured
//
// Nothing is invented and nothing is deleted; the interface simply refuses to
// present an unmeasured default as evidence. The fault domain, confidence and
// summary remain exactly what the deterministic engine decided.

/**
 * Findings the hosted vantage cannot produce, because their inputs come from
 * the endpoint's own adapters, routing table and ICMP stack.
 *
 * Keyed by the engine's finding label, which is a stable part of its output
 * contract - `diagnose()` builds every finding through one `finding()` helper
 * with a fixed label string.
 */
export const ENDPOINT_SCOPED_FINDINGS = Object.freeze({
  "Gateway packet loss": "The visitor's default gateway is on their LAN. A hosted vantage has no path to it.",
  "Gateway latency": "The visitor's default gateway is on their LAN. A hosted vantage has no path to it.",
  "Upstream packet loss": "ICMP loss along the endpoint's own path. The hosted runtime does not execute ping.",
  Jitter: "Latency variation along the endpoint's own path. The hosted runtime does not execute ping.",
  "VPN session": "VPN tunnel state is a property of the endpoint, not of the hosted runtime.",
  "VPN route": "The routing table is a property of the endpoint, not of the hosted runtime."
});

/**
 * Phrases the engine writes for an endpoint reader, and the vantage-correct
 * replacement. Applied ONLY to in-scope findings, whose measurement really was
 * taken by this vantage - so this renames the observer, never the observation.
 */
const REPHRASE = [
  [/\bfrom this endpoint\b/gi, "from this vantage"],
  [/\bthis endpoint cannot\b/gi, "this vantage cannot"],
  [/\bThe endpoint cannot\b/g, "This vantage cannot"],
  [/\bthe endpoint path\b/gi, "the measured path"],
  [/\bthe affected endpoint\b/gi, "the measured target"],
  [/\bendpoint-specific\b/gi, "vantage-specific"]
];

function rephrase(text, vantageLabel) {
  let value = String(text ?? "");
  for (const [pattern, replacement] of REPHRASE) value = value.replace(pattern, replacement);
  return value.replace(/\bthis vantage\b/g, vantageLabel);
}

/**
 * Partition a deterministic diagnosis for the vantage that produced it.
 *
 * @param {object} diagnosis  unmodified output of diagnose()
 * @param {object} vantage    from src/runtime/capabilities.mjs
 * @returns {{inScope: object[], notObservable: object[], vantage: object, note: string}}
 */
export function projectDiagnosisForVantage(diagnosis, vantage) {
  const label = vantage?.longLabel || vantage?.label || "this vantage";
  const findings = Array.isArray(diagnosis?.evidence) ? diagnosis.evidence : [];

  const inScope = [];
  const notObservable = [];

  for (const item of findings) {
    const reason = ENDPOINT_SCOPED_FINDINGS[item.label];
    if (reason) {
      notObservable.push({
        label: item.label,
        status: "not-measured",
        detail: reason,
        value: null,
        requires: "Faultline Agent on the endpoint"
      });
      continue;
    }
    inScope.push({ ...item, detail: rephrase(item.detail, label) });
  }

  return {
    vantage,
    inScope,
    notObservable,
    note: notObservable.length
      ? `${notObservable.length} deterministic check(s) depend on endpoint evidence that ${label} cannot collect. They are listed as not measured rather than shown as passing.`
      : "Every deterministic check in this diagnosis was measured from this vantage."
  };
}

/**
 * Metrics for the deterministic engine, built ONLY from hosted-observable
 * measurements.
 *
 * Deliberately omitted: gatewayLoss, gatewayLatencyMs, upstreamLoss, jitterMs,
 * vpnRequired, vpnConnected, expectedRoutePresent. The engine defaults them to
 * a healthy value; `projectDiagnosisForVantage` then removes the findings those
 * defaults produce, so no unmeasured default is ever shown as evidence.
 */
export function buildHostedMetrics({ dns, tcp, tls, http, distributed, internetReachable }) {
  const metrics = {
    dnsResolved: dns?.measured ? dns.state === "resolved" : true,
    dnsLookupMs: dns?.measured ? (dns.system?.a?.elapsedMs ?? null) : null,
    internetReachable: Boolean(internetReachable),
    targetReachable: Boolean(tcp?.ok || http?.ok),
    targetTcpMs: tcp?.ok ? tcp.elapsedMs : null,
    targetHttpMs: http?.ok ? http.ttfbMs : null
  };

  if (tls?.ok) metrics.tlsHandshakeMs = tls.elapsedMs;

  // Globalping is a genuine second vantage, which is exactly the input the
  // correlation half of the engine was designed for. Contextual sources
  // (RIPEstat, IODA, PeeringDB) are never fed in: routing metadata must not be
  // able to move a fault domain.
  if (distributed?.status === "ok" && distributed.data?.summary?.total > 0) {
    const summary = distributed.data.summary;
    metrics.externalProbeHealthy = summary.reachable > 0;
    metrics.externalProbeLatencyMs = summary.medianLatencyMs;
  }

  return metrics;
}
