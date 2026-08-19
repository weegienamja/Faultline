// RIPE Atlas — public measurement-network context.
//
// API: https://atlas.ripe.net/docs/apis/rest-api-manual/
// Read access to public probe metadata requires no authentication.
//
// Faultline uses RIPE Atlas DIFFERENTLY from Globalping. Globalping performs a
// live measurement against the user's target. RIPE Atlas here answers a
// different question: "what independent measurement infrastructure exists in or
// near the target network / affected region?"
//
// Faultline never claims RIPE Atlas has measured the user's arbitrary target,
// and never creates credit-consuming measurements. Creating measurements needs
// an API key and Atlas credits; that is deliberately out of scope.

import { cacheKey, cached, getJson, numberOrNull, ok, skipped, unavailable } from "./http.mjs";

const BASE = "https://atlas.ripe.net/api/v2";
const SOURCE = "ripe-atlas";
const TTL_MS = 30 * 60_000;

const STATUS_CONNECTED = 1;

export function parseProbes(body, limit = 5) {
  if (!body || typeof body !== "object") return null;
  const results = Array.isArray(body.results) ? body.results : null;
  if (!results) return null;
  const probes = results.slice(0, limit).map(probe => {
    const coordinates = probe?.geometry?.coordinates;
    return {
      id: numberOrNull(probe.id),
      asn: numberOrNull(probe.asn_v4) ?? numberOrNull(probe.asn_v6),
      countryCode: probe.country_code || null,
      prefix: probe.prefix_v4 || probe.prefix_v6 || null,
      isPublic: probe.is_public !== false,
      longitude: Array.isArray(coordinates) ? coordinates[0] ?? null : null,
      latitude: Array.isArray(coordinates) ? coordinates[1] ?? null : null
    };
  });
  return { total: numberOrNull(body.count) ?? probes.length, probes };
}

async function query(params, timeoutMs) {
  const search = new URLSearchParams({ status: String(STATUS_CONNECTED), ...params });
  return getJson(`${BASE}/probes/?${search}`, { timeoutMs });
}

/**
 * Connected public probes inside the target's origin ASN, plus (optionally)
 * probes in a country of interest. Pure context, not measurement evidence.
 */
export async function lookupProbeContext({ asn = null, countryCode = null, limit = 5, timeoutMs = 7_000 } = {}) {
  if (asn == null && !countryCode) return skipped(SOURCE, "No public ASN or country available for Atlas context.");

  return cached(SOURCE, cacheKey("atlas", asn ?? "-", countryCode ?? "-", limit), TTL_MS, async () => {
    const requests = [];
    if (asn != null) requests.push(query({ asn_v4: String(asn), page_size: String(limit) }, timeoutMs).then(r => ["targetAsn", r]));
    if (countryCode) requests.push(query({ country_code: countryCode, page_size: String(limit) }, timeoutMs).then(r => ["country", r]));
    const settled = await Promise.all(requests);

    const scopes = {};
    let anyOk = false;
    for (const [scope, response] of settled) {
      if (!response.ok) { scopes[scope] = { available: false, error: response.error }; continue; }
      const parsed = parseProbes(response.body, limit);
      if (!parsed) { scopes[scope] = { available: false, error: "Unrecognised RIPE Atlas payload." }; continue; }
      anyOk = true;
      scopes[scope] = { available: true, ...parsed };
    }
    if (!anyOk) return unavailable(SOURCE, Object.values(scopes)[0]?.error || "RIPE Atlas did not return usable data.");

    return ok(SOURCE, {
      asn,
      countryCode,
      scopes,
      evidenceClass: "measurement-network-context",
      note: "Connected public Atlas probes near this network. Faultline has not run an Atlas measurement against this target."
    });
  });
}
