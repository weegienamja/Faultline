// Globalping — real distributed measurements from public vantage points.
//
// API: https://globalping.io/docs/api.globalping.io  (no authentication required;
// unauthenticated clients are rate limited per source IP)
//
// POST /v1/measurements  -> { id, probesCount }
// GET  /v1/measurements/:id -> { status, results: [{ probe, result }] }
//
// Faultline requests a small number of geographically spread vantages so the
// dashboard can compare the affected endpoint against independent observers.
// Results are cached briefly so refreshing the dashboard does not re-measure.

import { cacheKey, cached, getJson, numberOrNull, ok, postJson, skipped, unavailable } from "./http.mjs";

const BASE = "https://api.globalping.io/v1";
const SOURCE = "globalping";
const TTL_MS = 3 * 60_000;

// Deliberately small and geographically useful. Keeping this low avoids
// generating unnecessary measurement traffic on a shared free service.
export const DEFAULT_LOCATIONS = [
  { country: "GB" },
  { country: "NL" },
  { country: "US" }
];

export const MAX_PROBES = 5;

export function parseMeasurement(body) {
  if (!body || typeof body !== "object") return null;
  const results = Array.isArray(body.results) ? body.results : [];
  const vantages = results.map(entry => {
    const probe = entry?.probe || {};
    const result = entry?.result || {};
    const stats = result.stats || {};
    const timings = result.timings || {};
    return {
      location: [probe.city, probe.country].filter(Boolean).join(", ") || probe.country || "unknown",
      continent: probe.continent || null,
      country: probe.country || null,
      city: probe.city || null,
      asn: Number.isInteger(probe.asn) ? probe.asn : null,
      network: probe.network || null,
      status: result.status || "unknown",
      resolvedAddress: result.resolvedAddress || null,
      // ping
      latencyMs: numberOrNull(stats.avg),
      minMs: numberOrNull(stats.min),
      maxMs: numberOrNull(stats.max),
      lossPct: numberOrNull(stats.loss),
      packetsSent: numberOrNull(stats.total),
      // http
      httpStatus: numberOrNull(result.statusCode),
      ttfbMs: numberOrNull(timings.firstByte),
      totalMs: numberOrNull(timings.total)
    };
  });

  return {
    id: body.id || null,
    type: body.type || null,
    target: body.target || null,
    state: body.status || "unknown",
    probesCount: Number(body.probesCount) || vantages.length,
    vantages
  };
}

export function summariseVantages(measurement) {
  const vantages = measurement?.vantages || [];
  const reachable = vantages.filter(v => v.status === "finished" && (v.lossPct === null || v.lossPct < 100));
  const latencies = reachable.map(v => v.latencyMs).filter(Number.isFinite);
  return {
    total: vantages.length,
    reachable: reachable.length,
    unreachable: vantages.length - reachable.length,
    medianLatencyMs: latencies.length
      ? Number([...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)].toFixed(1))
      : null
  };
}

async function poll(id, { timeoutMs, pollMs = 900, now = () => Date.now() }) {
  const deadline = now() + timeoutMs;
  let last = null;
  while (now() < deadline) {
    const response = await getJson(`${BASE}/measurements/${encodeURIComponent(id)}`, { timeoutMs: 5_000 });
    if (!response.ok) return { ok: false, error: response.error };
    last = response.body;
    if (last?.status && last.status !== "in-progress") return { ok: true, body: last };
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  // Return whatever partial state we have rather than nothing.
  return last ? { ok: true, body: last, partial: true } : { ok: false, error: "Globalping measurement did not complete in time." };
}

/**
 * Run one measurement against a PUBLIC target from a few public vantages.
 * `target` must already have passed Faultline's public-address validation.
 */
export async function measure(target, {
  type = "ping",
  locations = DEFAULT_LOCATIONS,
  limit = 3,
  timeoutMs = 20_000,
  measurementOptions = undefined
} = {}) {
  if (!target) return skipped(SOURCE, "No public target available for distributed measurement.");
  const probeLimit = Math.min(Math.max(1, Number(limit) || 1), MAX_PROBES);

  return cached(SOURCE, cacheKey("globalping", type, target, probeLimit), TTL_MS, async () => {
    const payload = {
      type,
      target,
      limit: probeLimit,
      locations,
      ...(measurementOptions ? { measurementOptions } : {})
    };
    const created = await postJson(`${BASE}/measurements`, payload, { timeoutMs: 8_000 });
    if (!created.ok || !created.body?.id) {
      return unavailable(SOURCE, created.error || "Globalping did not accept the measurement request.");
    }

    const finished = await poll(created.body.id, { timeoutMs });
    if (!finished.ok) return unavailable(SOURCE, finished.error);

    const parsed = parseMeasurement(finished.body);
    if (!parsed) return unavailable(SOURCE, "Globalping returned an unrecognised measurement payload.");
    return ok(SOURCE, { ...parsed, summary: summariseVantages(parsed), partial: Boolean(finished.partial) });
  });
}

export const __testing = { poll };
