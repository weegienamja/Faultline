// Live diagnostic orchestration.
//
// Evidence classes produced here are kept explicitly separate:
//
//   observed       real measurements taken by this control plane (LOCAL)
//   observed       real measurements taken by public vantages (GLOBALPING)
//   inferred       local topology inferred from observed adapter/neighbour state
//   deterministic  the existing rule engine's fault-domain conclusion
//   external       routing/ownership/outage context from public APIs
//
// Only "observed" measurements are ever fed into diagnose(). Routing, RPKI,
// outage and network-metadata context is deliberately excluded from the
// deterministic input so that a third-party API can never move a fault domain.

import net from "node:net";
import { diagnose } from "../engine/diagnose.mjs";
import { buildTopology } from "../topology/infer.mjs";
import { assertLiteralTargetAllowed, classifyAddress, resolveProbeTarget } from "../security/target.mjs";
import { buildInternetContext, isPubliclyEnrichable } from "../integrations/index.mjs";
import { lookupHopOwner } from "../integrations/ripestat.mjs";
import { measure as globalpingMeasure } from "../integrations/globalping.mjs";
import { skipped } from "../integrations/http.mjs";
import {
  collectLocalEnvironment,
  measureDns,
  measureHttp,
  measurePing,
  measureTcp,
  measureTls,
  measureTraceroute,
  parseLiveTarget,
  NOT_MEASURED,
  UNKNOWN
} from "./measure.mjs";

const MAX_ENRICHED_HOPS = 6;

function stage(name, state, extra = {}) {
  return { name, state, ...extra };
}

/**
 * Enrich public traceroute hops with routing ownership.
 * Private/reserved hops (the user's own LAN) are never sent anywhere.
 */
export async function enrichPathHops(hops = [], { limit = MAX_ENRICHED_HOPS } = {}) {
  const enriched = hops.map(hop => ({
    ...hop,
    scope: hop.ip ? (isPubliclyEnrichable(hop.ip) ? "public" : "private") : "unknown",
    asn: null,
    network: null,
    prefix: null,
    enrichment: hop.ip ? (isPubliclyEnrichable(hop.ip) ? "pending" : "skipped-private") : "no-address"
  }));

  const candidates = enriched.filter(hop => hop.enrichment === "pending").slice(0, limit);
  await Promise.all(candidates.map(async hop => {
    const routing = await lookupHopOwner(hop.ip, { timeoutMs: 5_000 });
    if (routing.status === "ok") {
      hop.asn = routing.data.originAsn;
      hop.network = routing.data.asnName;
      hop.prefix = routing.data.prefix;
      hop.enrichment = "enriched";
    } else {
      hop.enrichment = "unavailable";
    }
  }));
  for (const hop of enriched) {
    if (hop.enrichment === "pending") hop.enrichment = "not-attempted";
  }
  return enriched;
}

/**
 * Map real measurements onto the deterministic engine's documented input
 * contract. Only observed measurements appear here.
 */
export function buildDeterministicMetrics({ dns, gatewayPing, targetPing, tcp, http, tls, local, distributed }) {
  const metrics = {
    gatewayLoss: gatewayPing?.measured ? gatewayPing.lossPct : 0,
    gatewayLatencyMs: gatewayPing?.measured ? (gatewayPing.averageMs ?? 0) : 0,
    dnsResolved: dns?.measured ? dns.state === "resolved" : true,
    dnsLookupMs: dns?.measured ? (dns.system?.a?.elapsedMs ?? null) : null,
    internetReachable: Boolean(local?.internetReachable),
    vpnRequired: false,
    vpnConnected: Boolean(local?.vpn?.active),
    targetReachable: Boolean(tcp?.ok || http?.ok),
    targetTcpMs: tcp?.ok ? tcp.elapsedMs : null,
    targetHttpMs: http?.ok ? http.ttfbMs : null
  };

  // ICMP is frequently filtered on the public Internet. Treat 100% ICMP loss
  // with a working transport as filtering, not as packet loss.
  const icmpFiltered = Boolean(targetPing?.measured && targetPing.lossPct === 100 && metrics.targetReachable);
  metrics.upstreamLoss = targetPing?.measured && !icmpFiltered ? targetPing.lossPct : 0;
  metrics.jitterMs = targetPing?.measured && !icmpFiltered ? (targetPing.jitterMs ?? 0) : 0;
  metrics.icmpLikelyFiltered = icmpFiltered;

  if (dns?.measured && dns.system) {
    metrics.directIpReachable = metrics.targetReachable;
  }

  // A genuine independent measurement from public vantages is exactly the
  // second-vantage input the correlation engine was designed for. Contextual
  // sources (RIPEstat/IODA/PeeringDB/Atlas/Radar) are deliberately NOT here.
  if (distributed?.status === "ok" && distributed.data?.summary?.total > 0) {
    const summary = distributed.data.summary;
    metrics.externalProbeHealthy = summary.reachable > 0;
    metrics.externalProbeLatencyMs = summary.medianLatencyMs;
  }

  if (tls?.ok) metrics.tlsHandshakeMs = tls.elapsedMs;
  return metrics;
}

/**
 * Run a complete live diagnostic against a real target.
 *
 * @param {object} options
 * @param {string} options.target           hostname, IP or http(s) URL
 * @param {number} [options.port]
 * @param {"public"|"private"} [options.scope]
 * @param {boolean} [options.distributed]   request public vantage measurements
 * @param {boolean} [options.enrich]        request public Internet context
 */
export async function runLiveDiagnostic(options = {}) {
  const startedAt = new Date().toISOString();
  const scope = options.scope === "private" ? "private" : "public";
  const target = parseLiveTarget(options.target, options.port);

  // Reuse the existing public-target safety boundary unchanged.
  assertLiteralTargetAllowed(target.input, target.port, scope);

  const notes = [];
  const local = await collectLocalEnvironment();

  // --- DNS -----------------------------------------------------------------
  const dns = await measureDns(target.host);

  // Resolve to a concrete address and re-validate it for this scope. This is
  // the same guard the remote probe uses, so DNS rebinding cannot smuggle a
  // private address into a public-scope diagnostic.
  let resolved = null;
  let resolveError = null;
  try {
    const addresses = await resolveProbeTarget(target.host, scope);
    resolved = addresses[0] || null;
  } catch (error) {
    resolveError = error.message;
  }

  // --- Connection stages ---------------------------------------------------
  let tcp = null;
  let tls = null;
  let http = null;
  if (resolved) {
    tcp = await measureTcp(resolved.address, target.port);
    if (target.scheme === "https") {
      tls = await measureTls(resolved.address, target.port, target.host);
    }
    if (target.url) {
      http = await measureHttp(target.url, resolved.address, resolved.family, {
        // Every redirect hop is re-resolved and re-validated for this scope.
        resolveHop: async hostname => {
          try {
            const hopAddresses = await resolveProbeTarget(hostname, scope);
            return hopAddresses[0] || null;
          } catch { return null; }
        }
      });
    }
  }

  // --- ICMP, path and gateway ---------------------------------------------
  const gateway = local.gateway || null;
  const [gatewayPing, targetPing, traceroute, internetCheck] = await Promise.all([
    gateway ? measurePing(gateway, 4) : Promise.resolve({ measured: false, state: NOT_MEASURED, reason: "No default gateway was observed.", lossPct: 0, averageMs: null, jitterMs: null, replies: 0 }),
    resolved ? measurePing(resolved.address, 5) : Promise.resolve({ measured: false, state: NOT_MEASURED, reason: "Target did not resolve to a usable address.", lossPct: 0, averageMs: null, jitterMs: null, replies: 0 }),
    options.traceroute === false || !resolved
      ? Promise.resolve({ measured: false, state: NOT_MEASURED, reason: "Traceroute was not requested.", hops: [] })
      : measureTraceroute(resolved.address),
    Promise.all([measureTcp("1.1.1.1", 443, 2_500), measureTcp("8.8.8.8", 53, 2_500)])
  ]);
  const internetReachable = internetCheck.some(probe => probe.ok);

  // --- Public distributed measurement (genuine second vantage) -------------
  let distributed = skipped("globalping", "Distributed measurement was not requested.");
  const publicTarget = resolved && isPubliclyEnrichable(resolved.address);
  if (options.distributed !== false && publicTarget) {
    distributed = await globalpingMeasure(target.host, {
      type: "ping",
      limit: Math.min(Math.max(1, Number(options.vantages) || 3), 5),
      measurementOptions: { packets: 3 }
    });
  } else if (options.distributed !== false && !publicTarget) {
    distributed = skipped("globalping", "Target is not a public address, so no public vantage measurement was requested.");
    notes.push("Public vantage measurement skipped: target is not publicly routable.");
  }

  // --- Deterministic diagnosis (authoritative) -----------------------------
  const metrics = buildDeterministicMetrics({
    dns, gatewayPing, targetPing, tcp, http, tls,
    local: { ...local, internetReachable },
    distributed
  });
  const diagnosis = diagnose(metrics);

  // --- Inferred local topology --------------------------------------------
  const topology = local.supported && local.gateway
    ? buildTopology({
        endpoint: {
          hostname: local.host,
          ip: local.ipv4?.address || null,
          mac: local.adapter?.macAddress || null,
          connection: local.wifi?.connected ? `Wi-Fi · ${local.interfaceAlias || "adapter"}` : (local.interfaceAlias || "Endpoint")
        },
        gateway: { ip: local.gateway },
        wifi: local.wifi?.connected ? { ssid: local.wifi.ssid, bssid: local.wifi.bssid, signalPct: local.wifi.signalPct } : {},
        neighbours: local.neighbours
      })
    : null;

  // --- External context (never feeds diagnosis) ----------------------------
  let internetContext = null;
  if (options.enrich !== false && resolved) {
    internetContext = await buildInternetContext(resolved.address, {
      hostname: target.isLiteralIp ? null : target.host,
      countryCode: options.countryCode || null
    });
  }

  const path = traceroute.measured ? await enrichPathHops(traceroute.hops) : [];

  return {
    id: `LIVE-${Date.now().toString(36).toUpperCase()}`,
    source: "live",
    startedAt,
    completedAt: new Date().toISOString(),
    scope,
    target: {
      input: target.input,
      host: target.host,
      port: target.port,
      url: target.url,
      scheme: target.scheme,
      resolvedAddress: resolved?.address || null,
      resolvedFamily: resolved?.family || null,
      resolveError,
      addressScope: resolved ? (isPubliclyEnrichable(resolved.address) ? "public" : "private") : UNKNOWN
    },

    // OBSERVED — real measurements from this machine
    observed: {
      local: {
        host: local.host,
        platform: local.platform,
        supported: local.supported,
        state: local.state,
        reason: local.reason,
        adapter: local.adapter,
        ipv4: local.ipv4,
        ipv6: local.ipv6,
        gateway: local.gateway,
        interfaceAlias: local.interfaceAlias,
        wifi: local.wifi,
        vpn: local.vpn,
        resolvers: local.resolvers,
        routeCount: local.routes.length,
        neighbourCount: local.neighbours.length,
        internetReachable
      },
      dns,
      stages: [
        stage("DNS", dns.measured ? (dns.state === "resolved" ? "pass" : "fail") : "not-measured", {
          ms: dns.measured ? dns.system?.a?.elapsedMs ?? null : null,
          detail: dns.measured ? (dns.state === "resolved" ? `${dns.system.a.addresses.length} A record(s)` : dns.system?.a?.error || "resolution failed") : dns.reason
        }),
        stage("TCP", tcp ? (tcp.ok ? "pass" : "fail") : "not-measured", {
          ms: tcp?.elapsedMs ?? null,
          detail: tcp ? (tcp.ok ? `port ${target.port} accepted` : tcp.error) : (resolveError || "no resolved address")
        }),
        stage("TLS", tls ? (tls.ok ? "pass" : "fail") : (target.scheme === "https" ? "not-measured" : "n/a"), {
          ms: tls?.elapsedMs ?? null,
          detail: tls ? (tls.ok ? `${tls.protocol} · ${tls.cipher}` : tls.error) : (target.scheme === "https" ? "not measured" : "target is not HTTPS")
        }),
        stage("HTTP", http ? (http.ok ? "pass" : "fail") : "not-measured", {
          ms: http?.ttfbMs ?? null,
          detail: http ? (http.ok ? `HTTP ${http.status}${http.redirects.length ? ` after ${http.redirects.length} redirect(s)` : ""}` : http.error) : "no HTTP URL for this target"
        })
      ],
      tcp,
      tls,
      http,
      gatewayPing,
      targetPing,
      traceroute: { measured: traceroute.measured, state: traceroute.state, reason: traceroute.reason, hopCount: path.length },
      path
    },

    // INFERRED — derived from observed local state
    inferred: { topology },

    // DETERMINISTIC — authoritative fault-domain conclusion
    deterministic: { metrics, diagnosis },

    // OBSERVED (remote) — genuine independent vantage measurements
    distributed: {
      status: distributed.status,
      error: distributed.error || null,
      reason: distributed.reason || null,
      cached: Boolean(distributed.cached),
      data: distributed.status === "ok" ? distributed.data : null
    },

    // EXTERNAL — public Internet context, never diagnostic proof
    internetContext,
    notes
  };
}
