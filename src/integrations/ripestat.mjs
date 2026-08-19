// RIPEstat — public routing/registry context for a public IP or prefix.
//
// API: https://stat.ripe.net/docs/data_api  (no authentication required)
//
// Data calls used, and what each contributes:
//   network-info      resolved prefix + origin ASN(s) for an IP
//   as-overview       ASN holder/name and whether it is currently announced
//   rpki-validation   RPKI validity of (origin ASN, prefix)
//   routing-status    RIS peer visibility and first/last seen
//   bgp-updates       announcement/withdrawal activity in a bounded window
//
// This is ROUTING AND OWNERSHIP CONTEXT. It never establishes fault ownership.

import { cacheKey, cached, getJson, numberOrNull, ok, unavailable } from "./http.mjs";

const BASE = "https://stat.ripe.net/data";
const SOURCE = "ripestat";
const TTL_MS = 5 * 60_000;
const ACTIVITY_TTL_MS = 60_000;

function envelope(body) {
  // RIPEstat wraps every data call in {status, data, ...}.
  if (!body || typeof body !== "object") return null;
  if (body.status && body.status !== "ok") return null;
  return body.data && typeof body.data === "object" ? body.data : null;
}

function firstAsn(asns) {
  if (!Array.isArray(asns) || !asns.length) return null;
  const numeric = Number(asns[0]);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

export function parseNetworkInfo(body) {
  const data = envelope(body);
  if (!data) return null;
  const prefix = typeof data.prefix === "string" && data.prefix ? data.prefix : null;
  const originAsn = firstAsn(data.asns);
  if (!prefix && originAsn == null) return null;
  return { prefix, originAsn, additionalAsns: (data.asns || []).slice(1).map(Number).filter(Number.isInteger) };
}

export function parseAsOverview(body) {
  const data = envelope(body);
  if (!data) return null;
  return {
    asn: Number(data.resource) || null,
    holder: typeof data.holder === "string" && data.holder ? data.holder : null,
    announced: typeof data.announced === "boolean" ? data.announced : null,
    registry: data.block?.desc || null
  };
}

export function parseRpkiValidation(body) {
  const data = envelope(body);
  if (!data) return null;
  const status = typeof data.status === "string" ? data.status.toLowerCase() : null;
  if (!status) return null;
  return {
    status,                                   // valid | invalid | unknown | invalid_asn | invalid_length
    validator: data.validator || null,
    roaCount: Array.isArray(data.validating_roas) ? data.validating_roas.length : 0
  };
}

export function parseRoutingStatus(body) {
  const data = envelope(body);
  if (!data) return null;
  const v4 = data.visibility?.v4 || {};
  const v6 = data.visibility?.v6 || {};
  const seeing = Number(v4.ris_peers_seeing ?? 0) + Number(v6.ris_peers_seeing ?? 0);
  const total = Number(v4.total_ris_peers ?? 0) + Number(v6.total_ris_peers ?? 0);
  return {
    risPeersSeeing: seeing,
    risPeersTotal: total,
    visibilityPct: total > 0 ? Number(((seeing / total) * 100).toFixed(1)) : null,
    firstSeen: data.first_seen?.time || null,
    lastSeen: data.last_seen?.time || null
  };
}

export function parseBgpUpdates(body) {
  const data = envelope(body);
  if (!data) return null;
  const updates = Array.isArray(data.updates) ? data.updates : [];
  let announcements = 0;
  let withdrawals = 0;
  for (const update of updates) {
    if (update?.type === "A") announcements += 1;
    else if (update?.type === "W") withdrawals += 1;
  }
  return {
    announcements,
    withdrawals,
    sampled: updates.length,
    // nr_updates is the server-side total for the window; updates[] may be capped.
    totalReported: numberOrNull(data.nr_updates) ?? updates.length,
    windowStart: data.query_starttime || null,
    windowEnd: data.query_endtime || null
  };
}

async function call(path, params, { timeoutMs = 6_000 } = {}) {
  const query = new URLSearchParams({ ...params, sourceapp: "faultline" });
  return getJson(`${BASE}/${path}/data.json?${query}`, { timeoutMs });
}

/**
 * Routing + ownership context for one public IP address.
 * Returns an envelope; never throws.
 */
export async function lookupRouting(ip, { timeoutMs = 6_000 } = {}) {
  return cached(SOURCE, cacheKey("ripestat:routing", ip), TTL_MS, async () => {
    const netInfo = await call("network-info", { resource: ip }, { timeoutMs });
    if (!netInfo.ok) return unavailable(SOURCE, netInfo.error);
    const network = parseNetworkInfo(netInfo.body);
    if (!network) return unavailable(SOURCE, "RIPEstat returned no routing information for this address.");

    // Remaining calls are best-effort enrichment; partial results are fine.
    const [overviewRes, rpkiRes, statusRes] = await Promise.all([
      network.originAsn != null ? call("as-overview", { resource: `AS${network.originAsn}` }, { timeoutMs }) : Promise.resolve({ ok: false }),
      network.originAsn != null && network.prefix
        ? call("rpki-validation", { resource: `AS${network.originAsn}`, prefix: network.prefix }, { timeoutMs })
        : Promise.resolve({ ok: false }),
      network.prefix ? call("routing-status", { resource: network.prefix }, { timeoutMs }) : Promise.resolve({ ok: false })
    ]);

    const overview = overviewRes.ok ? parseAsOverview(overviewRes.body) : null;
    const rpki = rpkiRes.ok ? parseRpkiValidation(rpkiRes.body) : null;
    const status = statusRes.ok ? parseRoutingStatus(statusRes.body) : null;

    return ok(SOURCE, {
      ip,
      prefix: network.prefix,
      originAsn: network.originAsn,
      asnName: overview?.holder || null,
      asnAnnounced: overview?.announced ?? null,
      registry: overview?.registry || null,
      rpkiStatus: rpki?.status || "unknown",
      rpkiValidator: rpki?.validator || null,
      visibility: status
        ? { risPeersSeeing: status.risPeersSeeing, risPeersTotal: status.risPeersTotal, percent: status.visibilityPct }
        : null,
      prefixFirstSeen: status?.firstSeen || null,
      prefixLastSeen: status?.lastSeen || null
    });
  });
}

/**
 * Lightweight ownership lookup for a single traceroute hop.
 *
 * Full lookupRouting() issues four data calls; enriching a whole path with it
 * would generate ~24 requests per diagnostic. This issues one network-info call
 * per hop plus one as-overview per DISTINCT ASN (cached), which collapses to a
 * couple of requests for a typical path where hops share an ASN.
 */
export async function lookupHopOwner(ip, { timeoutMs = 5_000 } = {}) {
  return cached(SOURCE, cacheKey("ripestat:hop", ip), TTL_MS, async () => {
    const netInfo = await call("network-info", { resource: ip }, { timeoutMs });
    if (!netInfo.ok) return unavailable(SOURCE, netInfo.error);
    const network = parseNetworkInfo(netInfo.body);
    if (!network) return unavailable(SOURCE, "No routing information for this hop.");

    let asnName = null;
    if (network.originAsn != null) {
      const overview = await cached(SOURCE, cacheKey("ripestat:asname", network.originAsn), TTL_MS, async () => {
        const response = await call("as-overview", { resource: `AS${network.originAsn}` }, { timeoutMs });
        if (!response.ok) return unavailable(SOURCE, response.error);
        const parsed = parseAsOverview(response.body);
        return parsed ? ok(SOURCE, parsed) : unavailable(SOURCE, "No AS overview.");
      });
      if (overview.status === "ok") asnName = overview.data.holder;
    }
    return ok(SOURCE, { ip, prefix: network.prefix, originAsn: network.originAsn, asnName });
  });
}

/**
 * Bounded BGP activity for the prefix over the last `hours`.
 * Correlation context only — never causation.
 */
export async function lookupRoutingActivity(prefix, { hours = 1, timeoutMs = 8_000, now = Date.now() } = {}) {
  if (!prefix) return unavailable(SOURCE, "No prefix available for routing activity.");
  const endtime = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  const starttime = new Date(now - hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return cached(SOURCE, cacheKey("ripestat:activity", prefix, hours), ACTIVITY_TTL_MS, async () => {
    const response = await call("bgp-updates", { resource: prefix, starttime, endtime }, { timeoutMs });
    if (!response.ok) return unavailable(SOURCE, response.error);
    const parsed = parseBgpUpdates(response.body);
    if (!parsed) return unavailable(SOURCE, "RIPEstat returned no BGP update data.");
    return ok(SOURCE, { prefix, windowHours: hours, ...parsed });
  });
}

export const __testing = { envelope, firstAsn };
