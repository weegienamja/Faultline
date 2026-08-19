// IODA — Internet Outage Detection and Analysis (Georgia Tech).
//
// API: https://api.ioda.inetintel.cc.gatech.edu/v2  (no authentication required)
//
// Endpoints used:
//   /entities/query?entityType=asn&entityCode=<asn>   entity lookup
//   /outages/alerts?from=<unix>&until=<unix>&...      recent anomaly alerts
//
// IODA alert levels observed from the live API: "normal", "warning", "critical".
// Faultline reports only non-normal levels as POTENTIALLY RELEVANT EXTERNAL
// SIGNAL. It is never fed into the deterministic diagnosis engine and never
// presented as proof that an ASN or country event caused the user's fault.

import { cacheKey, cached, getJson, numberOrNull, ok, skipped, unavailable } from "./http.mjs";

const BASE = "https://api.ioda.inetintel.cc.gatech.edu/v2";
const SOURCE = "ioda";
const TTL_MS = 5 * 60_000;

export function parseAlerts(body) {
  if (!body || typeof body !== "object") return null;
  if (body.error) return null;
  const data = Array.isArray(body.data) ? body.data : null;
  if (!data) return null;

  const alerts = data
    .filter(item => item && typeof item === "object")
    .map(item => ({
      datasource: item.datasource || null,
      level: typeof item.level === "string" ? item.level.toLowerCase() : "unknown",
      condition: item.condition || null,
      value: numberOrNull(item.value),
      historyValue: numberOrNull(item.historyValue),
      at: numberOrNull(item.time) !== null ? new Date(numberOrNull(item.time) * 1000).toISOString() : null,
      entityType: item.entity?.type || null,
      entityCode: item.entity?.code || null,
      entityName: item.entity?.name || null
    }));

  const anomalies = alerts.filter(alert => alert.level && alert.level !== "normal");
  return {
    total: alerts.length,
    anomalies,
    anomalyCount: anomalies.length,
    // Highest severity present, for UI emphasis only.
    highestLevel: anomalies.some(a => a.level === "critical") ? "critical"
      : anomalies.some(a => a.level === "warning") ? "warning"
        : "none"
  };
}

export function parseEntity(body) {
  if (!body || typeof body !== "object" || body.error) return null;
  const entry = Array.isArray(body.data) ? body.data[0] : null;
  if (!entry) return null;
  return {
    code: entry.code || null,
    name: entry.name || null,
    type: entry.type || null,
    org: entry.attrs?.org || null,
    ipCount: numberOrNull(entry.attrs?.ip_count)
  };
}

async function alerts({ entityType, entityCode, fromSeconds, untilSeconds, timeoutMs }) {
  const query = new URLSearchParams({
    from: String(fromSeconds),
    until: String(untilSeconds),
    entityType,
    entityCode
  });
  return getJson(`${BASE}/outages/alerts?${query}`, { timeoutMs });
}

/**
 * Recent outage/anomaly context for the target's origin ASN, and optionally the
 * country the affected endpoint sits in.
 */
export async function lookupOutageContext({ asn = null, countryCode = null, hours = 24, timeoutMs = 8_000, now = Date.now() } = {}) {
  if (asn == null && !countryCode) return skipped(SOURCE, "No public ASN or country available for outage context.");
  const untilSeconds = Math.floor(now / 1000);
  const fromSeconds = untilSeconds - Math.round(hours * 3_600);

  return cached(SOURCE, cacheKey("ioda", asn ?? "-", countryCode ?? "-", hours), TTL_MS, async () => {
    const requests = [];
    if (asn != null) requests.push(alerts({ entityType: "asn", entityCode: String(asn), fromSeconds, untilSeconds, timeoutMs }).then(r => ["asn", r]));
    if (countryCode) requests.push(alerts({ entityType: "country", entityCode: countryCode, fromSeconds, untilSeconds, timeoutMs }).then(r => ["country", r]));
    const settled = await Promise.all(requests);

    const scopes = {};
    let anyOk = false;
    for (const [scope, response] of settled) {
      if (!response.ok) { scopes[scope] = { available: false, error: response.error }; continue; }
      const parsed = parseAlerts(response.body);
      if (!parsed) { scopes[scope] = { available: false, error: "Unrecognised IODA payload." }; continue; }
      anyOk = true;
      scopes[scope] = { available: true, ...parsed };
    }
    if (!anyOk) return unavailable(SOURCE, Object.values(scopes)[0]?.error || "IODA did not return usable data.");

    const anomalyCount = Object.values(scopes).reduce((sum, s) => sum + (s.anomalyCount || 0), 0);
    return ok(SOURCE, {
      windowHours: hours,
      asn,
      countryCode,
      scopes,
      anomalyCount,
      // Deliberately worded as a signal, never as a cause.
      summary: anomalyCount === 0
        ? "No IODA outage anomaly detected for this network in the observed window."
        : `${anomalyCount} potentially relevant external signal${anomalyCount === 1 ? "" : "s"} reported by IODA in the observed window.`
    });
  });
}

/** Entity metadata for an ASN (name/org/ip count). */
export async function lookupAsnEntity(asn, { timeoutMs = 6_000 } = {}) {
  if (asn == null) return skipped(SOURCE, "No ASN available.");
  return cached(SOURCE, cacheKey("ioda:entity", asn), TTL_MS, async () => {
    const query = new URLSearchParams({ entityType: "asn", entityCode: String(asn) });
    const response = await getJson(`${BASE}/entities/query?${query}`, { timeoutMs });
    if (!response.ok) return unavailable(SOURCE, response.error);
    const parsed = parseEntity(response.body);
    if (!parsed) return unavailable(SOURCE, "IODA returned no entity for this ASN.");
    return ok(SOURCE, parsed);
  });
}
