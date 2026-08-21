// The public demo diagnostic.
//
// A constrained sibling of src/live/diagnostic.mjs, NOT a copy of it. Every
// measurement primitive is imported from the existing engine; what changes is
// the boundary around it:
//
//   * the target comes from an unauthenticated stranger, so it goes through
//     src/demo/policy.mjs first and connections are pinned to addresses that
//     were validated there;
//   * nothing that reads the host machine runs. No collectLocalEnvironment,
//     no ping, no traceroute, no child process at all. A Vercel Function has
//     no meaningful gateway, no Wi-Fi and no visitor LAN, and inventing those
//     readings is precisely the failure this whole demo exists to avoid;
//   * every stage is time-boxed and the whole run has a budget.
//
// What it CAN do is real and worth showing: DNS with resolver comparison, TCP,
// TLS with certificate facts, HTTP with a guarded redirect chain, a genuine
// second vantage via Globalping, and public routing context. All of it is
// labelled with the vantage that took it.

import { diagnose } from "../engine/diagnose.mjs";
import { buildInternetContext, isPubliclyEnrichable } from "../integrations/index.mjs";
import { measure as globalpingMeasure } from "../integrations/globalping.mjs";
import { skipped } from "../integrations/http.mjs";
import { measureDns, measureHttp, measureTcp, measureTls } from "../live/measure.mjs";
import { vantageFor } from "../runtime/capabilities.mjs";
import { readLimits } from "./limits.mjs";
import { createRedirectGuard, parseDemoTarget, readAllowlist, resolveDemoTarget, withTimeout } from "./policy.mjs";
import { buildHostedMetrics, projectDiagnosisForVantage } from "./vantage.mjs";

/** Per-stage budgets. Deliberately tight: a Function is not a workstation. */
const TIMEOUTS = Object.freeze({
  dns: 4_000,
  tcp: 4_000,
  tls: 5_000,
  http: 6_000,
  globalping: 12_000,
  context: 8_000
});

const MAX_REDIRECTS = 3;

function stage(name, state, extra = {}) {
  return { name, state, ...extra };
}

/**
 * Reachability of the wider Internet from THIS vantage, used by the engine to
 * separate "the target is down" from "this vantage has no connectivity".
 * Two well-known anycast resolvers, TCP only, no ICMP.
 */
async function vantageInternetCheck() {
  const probes = await Promise.all([
    measureTcp("1.1.1.1", 443, 2_500),
    measureTcp("8.8.8.8", 53, 2_500)
  ]);
  return probes.some(probe => probe.ok);
}

/**
 * Run the public demo diagnostic.
 *
 * @param {string} targetInput  caller-supplied hostname or http(s) URL
 * @param {object} [options]
 * @param {number} [options.vantages]  public vantage count, clamped to 1..5
 * @returns {Promise<object>} the demo run record
 */
export async function runDemoDiagnostic(targetInput, options = {}) {
  const startedAt = new Date().toISOString();
  const allowlist = options.allowlist || readAllowlist();
  const vantage = options.vantage || vantageFor();

  // 1. Static policy. Throws before anything reaches the network.
  const target = parseDemoTarget(targetInput, { allowlist });

  const run = async () => {
    const notes = [];

    // 2. DNS, including the resolver-agreement comparison. This is a real
    //    measurement of resolver behaviour from this vantage and is the same
    //    code path the local product uses.
    const dns = await withTimeout(measureDns(target.host, { timeoutMs: TIMEOUTS.dns }), TIMEOUTS.dns + 2_000, "DNS measurement timed out.")
      .catch(error => ({
        measured: false,
        state: "not-measured",
        reason: error?.message || "DNS measurement failed.",
        systemResolvers: [],
        system: null,
        comparisons: [],
        agreement: null
      }));

    // 3. Resolve and validate EVERY address, then pin to one. Because later
    //    stages connect to this address rather than re-resolving the name, a
    //    DNS answer that changes afterwards cannot move the connection.
    const addresses = await resolveDemoTarget(target.host, { timeoutMs: TIMEOUTS.dns });
    const resolved = addresses[0];

    // 4. Connection stages, in the order a browser would take them.
    const tcp = await measureTcp(resolved.address, target.port, TIMEOUTS.tcp);
    const tls = target.scheme === "https"
      ? await measureTls(resolved.address, target.port, target.host, TIMEOUTS.tls)
      : null;
    const http = await measureHttp(target.url, resolved.address, resolved.family, {
      timeoutMs: TIMEOUTS.http,
      maxRedirects: MAX_REDIRECTS,
      // Every redirect destination is re-checked against the allowlist AND
      // re-resolved and re-validated. A redirect is a target chosen by someone
      // else, so it gets no more trust than the original.
      resolveHop: createRedirectGuard({ allowlist, timeoutMs: TIMEOUTS.dns })
    });
    if (http?.error === "redirect-target-blocked") {
      notes.push("A redirect pointed somewhere the public demo policy does not allow, so the chain was not followed.");
    }

    const internetReachable = await vantageInternetCheck();

    // 5. A genuine independent vantage. Globalping measures from public probes
    //    that are not this Function, which is the second viewpoint the
    //    correlation engine needs to separate path from service.
    let distributed = skipped("globalping", "Distributed measurement was not requested.");
    if (options.distributed !== false && isPubliclyEnrichable(resolved.address)) {
      distributed = await withTimeout(
        globalpingMeasure(target.host, {
          type: "ping",
          limit: Math.min(Math.max(1, Number(options.vantages) || 3), 5),
          measurementOptions: { packets: 3 }
        }),
        TIMEOUTS.globalping,
        "Public vantage measurement timed out."
      ).catch(error => skipped("globalping", error?.message || "Public vantage measurement was unavailable."));
    }

    // 6. Deterministic diagnosis. Authoritative, and fed only measurements.
    const metrics = buildHostedMetrics({ dns, tcp, tls, http, distributed, internetReachable });
    const diagnosis = diagnose(metrics);
    const vantageScope = projectDiagnosisForVantage(diagnosis, vantage);

    // 7. Public Internet context. Never an input to the diagnosis.
    let internetContext = null;
    if (options.enrich !== false) {
      internetContext = await withTimeout(
        buildInternetContext(resolved.address, { hostname: target.host, countryCode: null }),
        TIMEOUTS.context,
        "Public Internet context timed out."
      ).catch(() => null);
    }

    return {
      schema: "faultline.public-demo-diagnostic",
      schemaVersion: 1,
      id: `DEMO-${Date.now().toString(36).toUpperCase()}`,
      source: "live",
      evidenceClass: "observed",
      startedAt,
      completedAt: new Date().toISOString(),

      // Unmissable, and the first thing the interface reads. Anything measured
      // here was measured by the hosted deployment, never by the visitor.
      vantage,

      target: {
        input: target.input,
        host: target.host,
        port: target.port,
        scheme: target.scheme,
        url: target.url,
        resolvedAddress: resolved.address,
        resolvedFamily: resolved.family,
        resolvedAddresses: addresses.map(entry => ({ address: entry.address, family: entry.family }))
      },

      // OBSERVED - real measurements taken by the hosted vantage.
      observed: {
        dns,
        tcp,
        tls,
        http,
        internetReachable,
        stages: [
          stage("DNS", dns.measured ? (dns.state === "resolved" ? "pass" : "fail") : "not-measured", {
            ms: dns.measured ? dns.system?.a?.elapsedMs ?? null : null,
            detail: dns.measured
              ? (dns.state === "resolved"
                  ? `${dns.system.a.addresses.length} A record(s), ${dns.system.aaaa.addresses.length} AAAA record(s)`
                  : dns.system?.a?.error || "resolution failed")
              : dns.reason
          }),
          stage("TCP", tcp.ok ? "pass" : "fail", {
            ms: tcp.elapsedMs,
            detail: tcp.ok ? `port ${target.port} accepted from the hosted vantage` : tcp.error
          }),
          stage("TLS", tls ? (tls.ok ? "pass" : "fail") : "n/a", {
            ms: tls?.elapsedMs ?? null,
            detail: tls ? (tls.ok ? `${tls.protocol} · ${tls.cipher}` : tls.error) : "target is not HTTPS"
          }),
          // PASS here means the HTTP exchange COMPLETED, which is the question
          // a connectivity tool is asking: a 403 from a bot filter proves the
          // path works and is not a network fault. But green next to a 4xx
          // reads as "Faultline thinks a 403 is healthy", so a non-success
          // status says what the PASS does and does not cover.
          stage("HTTP", http ? (http.ok ? "pass" : "fail") : "not-measured", {
            ms: http?.ttfbMs ?? null,
            detail: http
              ? (http.ok
                  ? `HTTP ${http.status}${http.redirects.length ? ` after ${http.redirects.length} redirect(s)` : ""}${
                      http.status >= 400 ? " · answered, not a success status" : ""
                    }`
                  : http.error)
              : "no HTTP URL for this target"
          })
        ]
      },

      // DETERMINISTIC - the engine's conclusion, unedited, plus the honest
      // statement of which of its checks this vantage could actually make.
      deterministic: { metrics, diagnosis, vantageScope },

      // OBSERVED (remote) - independent public vantages.
      distributed: {
        status: distributed.status,
        error: distributed.error || null,
        reason: distributed.reason || null,
        cached: Boolean(distributed.cached),
        data: distributed.status === "ok" ? distributed.data : null
      },

      // EXTERNAL - context, never diagnostic proof.
      internetContext,

      // What this run deliberately did NOT do, so nobody has to infer it.
      notMeasured: {
        reason: "These require a Faultline Agent running on the endpoint being investigated.",
        items: [
          "Wi-Fi SSID, BSSID and signal",
          "Default gateway reachability and latency",
          "Routing table and default-route changes",
          "VPN adapter and tunnel state",
          "Neighbour / ARP table",
          "ICMP ping and traceroute from the endpoint",
          "Flight Recorder capture on the endpoint"
        ]
      },

      policy: {
        allowlisted: true,
        allowedPorts: [80, 443],
        maxRedirects: MAX_REDIRECTS,
        note: "The public demo resolves the hostname and validates every returned address before connecting, follows a bounded redirect chain with the same checks at each hop, and never executes a local command."
      },

      notes
    };
  };

  // A whole-run budget on top of the per-stage ones, so a pathological target
  // cannot hold a Function open until the platform kills it.
  return withTimeout(run(), options.budgetMs || readLimits().requestBudgetMs, "The demo diagnostic exceeded its time budget.");
}
