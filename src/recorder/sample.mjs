// Flight Recorder sampling.
//
// One sample is a cheap snapshot of "what does this machine's network look
// like, and can it reach the target right now". It runs every few seconds, so
// the governing constraint is that it must not perturb what it observes.
//
// That constraint is why sampling is split into two tiers:
//
//   FAST   runs every tick. In-process only: os.networkInterfaces(),
//          dns.getServers(), a DNS lookup and one TCP connect per address
//          family. Microseconds of CPU plus one round trip.
//   SLOW   runs every Nth tick. Anything that spawns a process or contacts
//          something external: Windows adapter/route/Wi-Fi state (~1.3 s, two
//          PowerShell spawns), gateway ping, public IP.
//
// Slow-tier values are carried forward between refreshes and always keep their
// own `observedAt` with `carriedForward: true`. A carried value is never
// re-timestamped as if it had just been measured - that would manufacture
// precision the recorder does not have, and the trigger logic would then report
// a route change seconds before it was actually seen.

import { createHash } from "node:crypto";
import dns from "node:dns";
import { networkInterfaces } from "node:os";

import { collectLocalEnvironment, measurePing, measureTcp, parseLiveTarget } from "../live/measure.mjs";
import { getJson } from "../integrations/http.mjs";
import { RESULT } from "../bisect/results.mjs";

export const STATE = Object.freeze({
  HEALTHY: "healthy",
  DEGRADED: "degraded",
  FAILED: "failed",
  UNKNOWN: "unknown"
});

/** Not sampled on this tick. Distinct from "measured and found absent". */
export const NOT_SAMPLED = "not-sampled";

/** Nothing was established either way. Distinct from INAPPLICABLE. */
export const UNKNOWN_STATE = "UNKNOWN";

const DEFAULT_PUBLIC_IP_URL = "https://api.ipify.org?format=json";

/**
 * Cheap local facts, straight from Node. No process spawn, no network.
 * Gives interface identity and configured resolvers on every platform.
 */
export function readCheapLocalState() {
  const interfaces = [];
  for (const [name, entries] of Object.entries(networkInterfaces() || {})) {
    for (const entry of entries || []) {
      if (entry.internal) continue;
      interfaces.push({
        name,
        address: entry.address,
        family: typeof entry.family === "number" ? entry.family : entry.family === "IPv6" ? 6 : 4,
        mac: entry.mac && entry.mac !== "00:00:00:00:00:00" ? entry.mac : null
      });
    }
  }

  let resolvers = [];
  try {
    resolvers = dns.getServers().slice(0, 8);
  } catch {
    resolvers = [];
  }

  return {
    interfaces: interfaces.sort((a, b) => a.name.localeCompare(b.name) || a.family - b.family),
    resolvers,
    hasIpv4Address: interfaces.some(entry => entry.family === 4),
    hasIpv6Address: interfaces.some(entry => entry.family === 6 && !/^fe80:/i.test(entry.address))
  };
}

/** DNS codes that mean "asked successfully, the record does not exist". */
const NO_RECORDS = new Set(["ENOTFOUND", "ENODATA", "NOTFOUND", "NODATA"]);

/**
 * Resolve the target's A and AAAA answers.
 *
 * Uses resolve4/resolve6 rather than lookup(), and the distinction is not
 * cosmetic. lookup() goes through getaddrinfo, which filters answers by what
 * the local stack can actually use: on a machine with no working IPv6 it
 * returns ENOENT for AAAA even when the target publishes AAAA records. Reading
 * that as "the target publishes no IPv6 address" would report a LOCAL
 * capability deficiency as a TARGET property - precisely the confusion the
 * engine's vocabulary exists to prevent.
 *
 * resolve* asks DNS directly, so "what does the target publish" and "can this
 * machine reach it" stay separate questions, answered by DNS and by the TCP
 * attempt respectively.
 *
 * Three outcomes per family, never collapsed:
 *   addresses      the target publishes these
 *   noRecords      the target publishes none (a target property)
 *   error          resolution itself failed (unknown, not an answer)
 */
export async function resolveTargetAddresses(host, { timeoutMs = 2_000, resolver = dns.promises } = {}) {
  const query = async method => {
    try {
      return { addresses: await withTimeout(resolver[method](host), timeoutMs) };
    } catch (error) {
      const code = error?.code || error?.message || "resolution failed";
      return NO_RECORDS.has(code) ? { addresses: [], noRecords: true } : { addresses: [], error: code };
    }
  };

  const [v4, v6] = await Promise.all([query("resolve4"), query("resolve6")]);

  // resolve* bypasses the hosts file, so a name defined there would look
  // unresolvable. Fall back to the system resolver only when DNS said the name
  // does not exist at all.
  if (v4.noRecords && v6.noRecords && typeof resolver.lookup === "function") {
    try {
      const answers = await withTimeout(resolver.lookup(host, { all: true }), timeoutMs);
      const v4Fallback = answers.filter(entry => entry.family === 4).map(entry => entry.address);
      const v6Fallback = answers.filter(entry => entry.family === 6).map(entry => entry.address);
      if (v4Fallback.length || v6Fallback.length) {
        return {
          v4: v4Fallback,
          v6: v6Fallback,
          v4Error: null,
          v6Error: null,
          v4NoRecords: v4Fallback.length === 0,
          v6NoRecords: v6Fallback.length === 0,
          source: "system"
        };
      }
    } catch {
      // The name genuinely does not resolve; fall through to the DNS answer.
    }
  }

  return {
    v4: v4.addresses,
    v6: v6.addresses,
    v4Error: v4.error ?? null,
    v6Error: v6.error ?? null,
    v4NoRecords: Boolean(v4.noRecords),
    v6NoRecords: Boolean(v6.noRecords),
    source: "dns"
  };
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs).unref?.())
  ]);
}

/**
 * Evaluate only the checks a lightweight sample can afford.
 *
 * A failing required check fails the contract outright, so a FAIL here is
 * conclusive. A PASS is not: TLS and HTTP checks were never run. That
 * asymmetry is reported rather than smoothed into a plain "passing".
 */
export async function sampleContract(contract, target, { timeoutMs = 2_500, tcp = measureTcp, addresses = null } = {}) {
  if (!contract) return null;

  const cheap = (contract.checks || []).filter(check => check.type === "dns" || check.type === "tcp");
  const heavy = (contract.checks || []).filter(check => check.type !== "dns" && check.type !== "tcp");
  const results = [];

  for (const check of cheap) {
    if (check.type === "dns") {
      const resolved = addresses || await resolveTargetAddresses(check.host === "$target.host" ? target.host : check.host, { timeoutMs });
      const ok = resolved.v4.length > 0 || resolved.v6.length > 0;
      results.push({ id: check.id, type: "dns", required: check.required !== false, ok });
      continue;
    }
    const address = (addresses?.v4?.[0]) || (addresses?.v6?.[0]) || null;
    if (!address) {
      results.push({ id: check.id, type: "tcp", required: check.required !== false, ok: false, reason: "no resolved address" });
      continue;
    }
    const port = check.port === "$target.port" ? target.port : Number(check.port) || target.port;
    const outcome = await tcp(address, port, timeoutMs);
    results.push({ id: check.id, type: "tcp", required: check.required !== false, ok: outcome.ok === true, ms: outcome.elapsedMs ?? null });
  }

  const failedRequired = results.filter(entry => entry.required && !entry.ok);
  const state = failedRequired.length ? "FAIL" : heavy.length ? "PARTIAL" : "PASS";

  return {
    contractId: contract.id,
    version: contract.version ?? null,
    state,
    sampledChecks: results.length,
    unsampledChecks: heavy.length,
    failedRequired: failedRequired.map(entry => entry.id),
    note: state === "PARTIAL"
      ? `Cheap checks passing. ${heavy.length} check(s) (${heavy.map(c => c.type).join(", ")}) are not evaluated in a lightweight sample.`
      : null
  };
}

/**
 * Identity of the path this machine is currently using.
 *
 * A single hash over the fields that define "which way traffic leaves and where
 * it lands", so a change is one comparison rather than a field-by-field diff on
 * every tick. The diff still happens - but only once a trigger has fired.
 */
export function pathFingerprint({ activeInterface, gateway, route, resolvers, publicIp }) {
  const material = JSON.stringify([
    activeInterface ?? null,
    gateway ?? null,
    route ? `${route.destination}|${route.nextHop}|${route.interfaceAlias}|${route.metric}` : null,
    [...(resolvers || [])].sort(),
    publicIp ?? null
  ]);
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

/** Classify one sample. Deterministic thresholds, no scoring or probability. */
export function classifySample(sample, { gatewayLossPct = 5, gatewayLatencyMs = 40 } = {}) {
  const reasons = [];
  const connectivity = sample.connectivity || {};

  const reachable = connectivity.targetTcp?.state;
  if (reachable === RESULT.FAIL) reasons.push("target TCP unreachable");

  const gateway = connectivity.gateway;
  if (gateway && gateway.state !== NOT_SAMPLED) {
    if (Number(gateway.lossPct) >= gatewayLossPct) reasons.push(`gateway loss ${gateway.lossPct}%`);
    if (Number(gateway.averageMs) >= gatewayLatencyMs) reasons.push(`gateway latency ${gateway.averageMs} ms`);
  }

  if (connectivity.contract?.state === "FAIL") reasons.push(`contract ${connectivity.contract.contractId} failing`);
  if (connectivity.targetDns?.state === RESULT.FAIL) reasons.push("target DNS not resolving");

  let state = STATE.HEALTHY;
  if (reachable === RESULT.FAIL || connectivity.contract?.state === "FAIL") state = STATE.FAILED;
  else if (reasons.length) state = STATE.DEGRADED;
  else if (reachable !== RESULT.PASS) state = STATE.UNKNOWN;

  return { state, reasons };
}

/**
 * Take one sample.
 *
 * `slow` decides whether the expensive tier refreshes on this tick. `carried`
 * is the previous slow-tier result, reused when it does not.
 */
export async function takeSample({
  target,
  seq = 0,
  slow = false,
  carried = null,
  contract = null,
  publicIpUrl = null,
  now = () => new Date(),
  deps = {}
} = {}) {
  const {
    localEnvironment = collectLocalEnvironment,
    ping = measurePing,
    tcp = measureTcp,
    resolve = resolveTargetAddresses,
    cheapLocal = readCheapLocalState,
    fetchJson = getJson
  } = deps;

  const at = now().toISOString();
  const cheap = cheapLocal();

  // --- slow tier -----------------------------------------------------------
  let slowState = carried?.slow ?? null;
  let slowObservedAt = carried?.slowObservedAt ?? null;
  let gateway = carried?.gateway ?? { state: NOT_SAMPLED };
  let publicIp = carried?.publicIp ?? null;

  if (slow) {
    try {
      slowState = await localEnvironment();
      slowObservedAt = at;
    } catch {
      // A failed environment read must not lose the previous known-good value;
      // it is simply not refreshed this tick.
    }

    if (slowState?.gateway) {
      try {
        const result = await ping(slowState.gateway, 2);
        gateway = result.measured
          ? { state: result.state === "responded" ? RESULT.PASS : RESULT.FAIL, lossPct: result.lossPct, averageMs: result.averageMs, jitterMs: result.jitterMs }
          : { state: NOT_SAMPLED, reason: result.reason };
      } catch {
        gateway = { state: NOT_SAMPLED, reason: "gateway probe failed" };
      }
    }

    if (publicIpUrl) {
      // The only outbound contact the recorder makes beyond the target itself,
      // and it is off unless explicitly enabled.
      const response = await fetchJson(publicIpUrl, { timeoutMs: 3_000 }).catch(() => null);
      const value = response?.ok ? response.data?.ip ?? null : null;
      if (value) publicIp = { value: String(value).slice(0, 45), observedAt: at };
    }
  }

  const carriedForward = !slow && Boolean(slowObservedAt);

  // --- fast tier -----------------------------------------------------------
  const addresses = await resolve(target.host, { timeoutMs: 2_000 });
  const dnsState = addresses.v4.length || addresses.v6.length
    ? RESULT.PASS
    // Both families answered "no such record" is a real resolution failure for
    // a name that is supposed to exist; a resolver error is not an answer.
    : addresses.v4Error || addresses.v6Error ? UNKNOWN_STATE : RESULT.FAIL;

  /**
   * INAPPLICABLE is reserved for the case DNS actually answered: the target
   * publishes no address of this family. A resolution failure is UNKNOWN, not
   * INAPPLICABLE, because nothing was established either way.
   */
  const probeFamily = async (list, { noRecords, error }) => {
    if (!list.length) {
      if (noRecords) return { state: RESULT.INAPPLICABLE, reason: "the target publishes no address of this family" };
      return { state: UNKNOWN_STATE, reason: error ? `resolution failed (${error})` : "no address resolved" };
    }
    const outcome = await tcp(list[0], target.port, 2_500);
    return outcome.ok
      ? { state: RESULT.PASS, ms: Math.round(outcome.elapsedMs), address: list[0] }
      : { state: RESULT.FAIL, error: outcome.error, address: list[0] };
  };

  const [ipv4, ipv6] = await Promise.all([
    probeFamily(addresses.v4, { noRecords: addresses.v4NoRecords, error: addresses.v4Error }),
    probeFamily(addresses.v6, { noRecords: addresses.v6NoRecords, error: addresses.v6Error })
  ]);

  // The headline reachability figure: did either family connect.
  const targetTcp = ipv4.state === RESULT.PASS || ipv6.state === RESULT.PASS
    ? { state: RESULT.PASS, ms: ipv4.state === RESULT.PASS ? ipv4.ms : ipv6.ms }
    : ipv4.state === RESULT.FAIL || ipv6.state === RESULT.FAIL
      ? { state: RESULT.FAIL, error: ipv4.error || ipv6.error || null }
      : { state: RESULT.INAPPLICABLE, reason: "the target publishes no address" };

  const contractState = await sampleContract(contract, target, { tcp, addresses });

  const activeInterface = slowState?.interfaceAlias ?? null;
  const route = firstDefaultRoute(slowState);
  const resolvedAddress = addresses.v4[0] || addresses.v6[0] || null;

  const sample = {
    seq,
    at,
    tier: slow ? "full" : "fast",
    local: {
      observedAt: slowObservedAt,
      carriedForward,
      supported: slowState?.supported ?? null,
      activeInterface,
      gateway: slowState?.gateway ?? null,
      route,
      resolvers: cheap.resolvers,
      wifi: slowState?.wifi?.connected
        ? { ssid: slowState.wifi.ssid ?? null, bssid: slowState.wifi.bssid ?? null }
        : slowState?.wifi
          ? { ssid: null, bssid: null }
          : null,
      vpn: slowState?.vpn ? { active: Boolean(slowState.vpn.active), adapters: (slowState.vpn.adapters || []).map(a => a.name) } : null,
      interfaces: cheap.interfaces
    },
    connectivity: {
      ipv4,
      ipv6,
      gateway,
      targetDns: { state: dnsState, v4: addresses.v4.length, v6: addresses.v6.length, error: addresses.v4Error },
      targetTcp,
      contract: contractState
    },
    path: {
      publicIp: publicIp ? { ...publicIp, carriedForward: carriedForward || publicIp.observedAt !== at } : null,
      resolvedAddress,
      // The full answer set, so a CDN rotating between known addresses can be
      // told apart from the target being repointed somewhere new.
      resolvedAddresses: [...addresses.v4, ...addresses.v6].sort(),
      // Identity of how traffic leaves this machine. Deliberately excludes the
      // resolved address: round-robin DNS would otherwise fire a network-state
      // change on almost every tick.
      fingerprint: pathFingerprint({
        activeInterface,
        gateway: slowState?.gateway ?? null,
        route,
        resolvers: cheap.resolvers,
        publicIp: publicIp?.value ?? null
      })
    }
  };

  const classified = classifySample(sample);
  sample.state = classified.state;
  sample.reasons = classified.reasons;

  return {
    sample,
    // Handed back to the next tick so the slow tier can be carried forward.
    carried: { slow: slowState, slowObservedAt, gateway, publicIp }
  };
}

function firstDefaultRoute(slowState) {
  const routes = slowState?.routes || [];
  const chosen = routes.find(route => route.destination === "0.0.0.0/0") || null;
  return chosen
    ? { destination: chosen.destination, nextHop: chosen.nextHop, interfaceAlias: chosen.interfaceAlias, metric: chosen.metric ?? null }
    : null;
}

export { DEFAULT_PUBLIC_IP_URL, parseLiveTarget };
