// Cloudflare Radar — OPTIONAL routing/outage context.
//
// API: https://developers.cloudflare.com/radar/  (requires an API token)
//
// Cloudflare Radar is the only source in this directory that needs a credential,
// so it is disabled unless FAULTLINE_CLOUDFLARE_RADAR_TOKEN is set. When it is
// absent, Faultline reports "Not configured" and everything else still works.
// The token is read from the environment and never persisted or logged.

import { cacheKey, cached, getJson, notConfigured, ok, skipped, unavailable } from "./http.mjs";

const BASE = "https://api.cloudflare.com/client/v4/radar";
const SOURCE = "cloudflare-radar";
const TTL_MS = 10 * 60_000;

export function isConfigured(env = process.env) {
  return Boolean(env.FAULTLINE_CLOUDFLARE_RADAR_TOKEN);
}

export function parseAnnotations(body) {
  if (!body || typeof body !== "object") return null;
  if (body.success === false) return null;
  const annotations = body.result?.annotations;
  if (!Array.isArray(annotations)) return null;
  return annotations.slice(0, 5).map(entry => ({
    type: entry.eventType || entry.type || null,
    scope: entry.scope || null,
    locations: Array.isArray(entry.locations) ? entry.locations.map(l => l?.code || l).filter(Boolean) : [],
    asns: Array.isArray(entry.asns) ? entry.asns.map(a => Number(a?.asn ?? a)).filter(Number.isFinite) : [],
    startedAt: entry.startDate || null,
    endedAt: entry.endDate || null,
    description: entry.description || null
  }));
}

/**
 * Recent Internet-outage annotations. Returns a "not-configured" envelope when
 * no token is present — this is a normal state, not an error.
 */
export async function lookupOutageAnnotations({ asn = null, countryCode = null, timeoutMs = 7_000, env = process.env } = {}) {
  if (!isConfigured(env)) {
    return notConfigured(SOURCE, "Set FAULTLINE_CLOUDFLARE_RADAR_TOKEN to enable Cloudflare Radar context.");
  }
  if (asn == null && !countryCode) return skipped(SOURCE, "No public ASN or country available.");

  return cached(SOURCE, cacheKey("radar", asn ?? "-", countryCode ?? "-"), TTL_MS, async () => {
    const params = new URLSearchParams({ limit: "5", dateRange: "1d" });
    if (asn != null) params.set("asn", String(asn));
    if (countryCode) params.set("location", countryCode);
    const response = await getJson(`${BASE}/annotations/outages?${params}`, {
      timeoutMs,
      headers: { authorization: `Bearer ${env.FAULTLINE_CLOUDFLARE_RADAR_TOKEN}` }
    });
    if (!response.ok) return unavailable(SOURCE, response.error);
    const annotations = parseAnnotations(response.body);
    if (!annotations) return unavailable(SOURCE, "Cloudflare Radar returned an unrecognised payload.");
    return ok(SOURCE, { asn, countryCode, annotations, count: annotations.length });
  });
}
