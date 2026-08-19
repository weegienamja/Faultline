// PeeringDB — public network metadata for an ASN.
//
// API: https://www.peeringdb.com/apidocs/  (read access requires no auth)
//
// Endpoints used:
//   /api/net?asn=<asn>        network record (name, type, scope, policy, counts)
//   /api/netixlan?asn=<asn>   Internet-exchange presence records
//
// IMPORTANT LABELLING: this is NETWORK METADATA, describing what a network
// publishes about itself. It is NOT observed path evidence. Faultline must not
// imply a diagnostic packet traversed any listed exchange or facility.

import { cacheKey, cached, getJson, numberOrNull, ok, skipped, unavailable } from "./http.mjs";

const BASE = "https://www.peeringdb.com/api";
const SOURCE = "peeringdb";
const TTL_MS = 60 * 60_000; // metadata changes slowly

function text(value) {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

export function parseNetwork(body) {
  if (!body || typeof body !== "object") return null;
  const record = Array.isArray(body.data) ? body.data[0] : null;
  if (!record) return null;
  return {
    name: text(record.name),
    asn: numberOrNull(record.asn),
    website: text(record.website),
    networkType: text(record.info_type),
    trafficProfile: text(record.info_traffic),
    scope: text(record.info_scope),
    trafficRatio: text(record.info_ratio),
    peeringPolicy: text(record.policy_general),
    irrAsSet: text(record.irr_as_set),
    exchangeCount: numberOrNull(record.ix_count),
    facilityCount: numberOrNull(record.fac_count)
  };
}

export function parseExchanges(body, limit = 6) {
  if (!body || typeof body !== "object") return [];
  const records = Array.isArray(body.data) ? body.data : [];
  return records
    .filter(record => record && record.operational !== false)
    .slice(0, limit)
    .map(record => ({
      name: text(record.name),
      speedMbps: numberOrNull(record.speed)
    }))
    .filter(entry => entry.name);
}

/**
 * Public metadata that the ASN's operator publishes about itself.
 * Returns an envelope; never throws.
 */
export async function lookupNetwork(asn, { timeoutMs = 6_000, includeExchanges = true } = {}) {
  if (asn == null) return skipped(SOURCE, "No public ASN available for network metadata.");
  return cached(SOURCE, cacheKey("peeringdb", asn, includeExchanges), TTL_MS, async () => {
    const netResponse = await getJson(`${BASE}/net?asn=${encodeURIComponent(asn)}`, { timeoutMs });
    if (!netResponse.ok) return unavailable(SOURCE, netResponse.error);
    const network = parseNetwork(netResponse.body);
    if (!network) return unavailable(SOURCE, `PeeringDB has no published record for AS${asn}.`);

    let exchanges = [];
    if (includeExchanges) {
      const ixResponse = await getJson(`${BASE}/netixlan?asn=${encodeURIComponent(asn)}&limit=8`, { timeoutMs });
      if (ixResponse.ok) exchanges = parseExchanges(ixResponse.body);
    }

    return ok(SOURCE, {
      ...network,
      exchanges,
      // Explicit guard rail carried through to the UI.
      evidenceClass: "network-metadata",
      note: "Self-published network metadata. Not evidence that traffic traversed these exchanges or facilities."
    });
  });
}
