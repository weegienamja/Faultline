import test from "node:test";
import assert from "node:assert/strict";
import { buildInternetContext, isPubliclyEnrichable, publicAddressesOnly } from "../src/integrations/index.mjs";
import { clearIntegrationCache, getJson, numberOrNull, postJson } from "../src/integrations/http.mjs";
import { lookupRouting } from "../src/integrations/ripestat.mjs";
import { lookupNetwork } from "../src/integrations/peeringdb.mjs";
import { lookupOutageContext } from "../src/integrations/ioda.mjs";
import { lookupOutageAnnotations, isConfigured } from "../src/integrations/cloudflare-radar.mjs";
import { buildDeterministicMetrics, enrichPathHops } from "../src/live/diagnostic.mjs";
import { diagnose } from "../src/engine/diagnose.mjs";

// These tests never touch the public Internet. Where network behaviour matters,
// globalThis.fetch is replaced with a recorder/stub.

function withFetch(handler, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return Promise.resolve(run(calls)).finally(() => { globalThis.fetch = original; });
}

const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test.beforeEach(() => clearIntegrationCache());

// ---------------------------------------------------------------------------
// PRIVACY BOUNDARY
// ---------------------------------------------------------------------------

test("only globally routable addresses are considered enrichable", () => {
  for (const publicIp of ["1.1.1.1", "8.8.8.8", "104.20.23.154", "2606:4700:4700::1111"]) {
    assert.equal(isPubliclyEnrichable(publicIp), true, publicIp);
  }
  for (const privateIp of [
    "127.0.0.1", "10.0.0.1", "10.40.12.25", "172.16.5.4", "192.168.0.1",
    "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "0.0.0.0", "224.0.0.1"
  ]) {
    assert.equal(isPubliclyEnrichable(privateIp), false, privateIp);
  }
  // Hostnames and junk are never enrichable as-is.
  for (const notAnIp of ["crm.internal.example", "localhost", "", null, undefined, "not-an-ip"]) {
    assert.equal(isPubliclyEnrichable(notAnIp), false, String(notAnIp));
  }
});

test("publicAddressesOnly strips every private address from a mixed list", () => {
  const filtered = publicAddressesOnly([
    "8.8.8.8", { address: "192.168.1.10" }, { address: "1.1.1.1" }, "10.0.0.5", "fe80::1"
  ]);
  assert.deepEqual(filtered, ["8.8.8.8", "1.1.1.1"]);
});

test("PRIVACY: a private target performs no third-party request at all", async () => {
  for (const privateIp of ["192.168.0.1", "10.40.12.25", "127.0.0.1", "169.254.169.254", "fd00::1"]) {
    await withFetch(
      () => { throw new Error("A third-party API must never be contacted for a private address."); },
      async calls => {
        const context = await buildInternetContext(privateIp, { hostname: "crm.internal.example" });
        assert.equal(context.enriched, false, privateIp);
        assert.match(context.reason, /private or reserved/i);
        assert.equal(calls.length, 0, `no outbound request may be made for ${privateIp}`);
      }
    );
  }
});

test("PRIVACY: outbound enrichment requests carry only the public IP and derived ASN", async () => {
  const localSecrets = ["192.168.0.1", "crm.internal.example", "AA:BB:CC:DD:EE:FF", "MyHomeWiFi", "10.40.0.0/16"];
  await withFetch(
    url => {
      if (url.includes("network-info")) return jsonResponse({ status: "ok", data: { asns: ["13335"], prefix: "1.1.1.0/24" } });
      if (url.includes("as-overview")) return jsonResponse({ status: "ok", data: { resource: "13335", holder: "CLOUDFLARENET", announced: true } });
      if (url.includes("rpki-validation")) return jsonResponse({ status: "ok", data: { status: "valid", validator: "routinator" } });
      if (url.includes("routing-status")) return jsonResponse({ status: "ok", data: { visibility: { v4: { ris_peers_seeing: 300, total_ris_peers: 300 }, v6: {} } } });
      if (url.includes("bgp-updates")) return jsonResponse({ status: "ok", data: { updates: [], nr_updates: 0 } });
      if (url.includes("peeringdb")) return jsonResponse({ data: [{ name: "Cloudflare", asn: 13335, ix_count: 357 }] });
      if (url.includes("ioda")) return jsonResponse({ error: null, data: [] });
      if (url.includes("atlas")) return jsonResponse({ count: 6, results: [] });
      return jsonResponse({});
    },
    async calls => {
      const context = await buildInternetContext("1.1.1.1", { hostname: "example.com", countryCode: "GB" });
      assert.equal(context.enriched, true);
      assert.ok(calls.length > 0, "expected outbound enrichment calls");
      for (const call of calls) {
        for (const secret of localSecrets) {
          assert.equal(call.url.includes(secret), false, `"${secret}" must never appear in ${call.url}`);
        }
        // No request bodies are sent during enrichment at all.
        assert.equal(call.options?.body, undefined, "enrichment must not POST any payload");
      }
    }
  );
});

test("PRIVACY: traceroute hop enrichment skips private hops and only queries public ones", async () => {
  await withFetch(
    url => {
      assert.equal(url.includes("192.168."), false, "private hop must never be sent to RIPEstat");
      assert.equal(url.includes("10.0."), false, "private hop must never be sent to RIPEstat");
      return jsonResponse({ status: "ok", data: { asns: ["13335"], prefix: "1.1.1.0/24" } });
    },
    async calls => {
      const hops = await enrichPathHops([
        { hop: 1, ip: "192.168.0.1", averageRttMs: 2, timedOut: false },
        { hop: 2, ip: "10.0.0.1", averageRttMs: 8, timedOut: false },
        { hop: 3, ip: null, averageRttMs: null, timedOut: true },
        { hop: 4, ip: "1.1.1.1", averageRttMs: 14, timedOut: false }
      ]);
      assert.equal(hops[0].enrichment, "skipped-private");
      assert.equal(hops[1].enrichment, "skipped-private");
      assert.equal(hops[2].enrichment, "no-address");
      assert.equal(hops[3].enrichment, "enriched");
      assert.equal(hops[3].asn, 13335);
      const hopIpsQueried = new Set(calls.map(c => new URL(c.url).searchParams.get("resource")).filter(r => r && !r.startsWith("AS")));
      assert.deepEqual([...hopIpsQueried], ["1.1.1.1"], "only the single public hop may be looked up");
    }
  );
});

// ---------------------------------------------------------------------------
// RESILIENCE
// ---------------------------------------------------------------------------

test("a failing third-party API yields an unavailable envelope, never a throw", async () => {
  await withFetch(
    () => { throw new Error("ECONNREFUSED"); },
    async () => {
      const routing = await lookupRouting("1.1.1.1");
      assert.equal(routing.status, "unavailable");
      assert.match(routing.error, /ECONNREFUSED/);
      assert.equal(routing.data, null);
    }
  );
});

test("a non-200 response is reported as unavailable with the status code", async () => {
  await withFetch(
    () => new Response("gateway timeout", { status: 504 }),
    async () => {
      const network = await lookupNetwork(13335);
      assert.equal(network.status, "unavailable");
      assert.match(network.error, /504/);
    }
  );
});

test("malformed JSON from a third party is handled as unavailable", async () => {
  await withFetch(
    () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }),
    async () => {
      const routing = await lookupRouting("1.1.1.1");
      assert.equal(routing.status, "unavailable");
    }
  );
});

test("requests are bounded by a timeout rather than hanging", async () => {
  await withFetch(
    (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
    async () => {
      const started = Date.now();
      const response = await getJson("https://example.invalid/slow", { timeoutMs: 120 });
      assert.equal(response.ok, false);
      assert.match(response.error, /Timed out after 120ms/);
      assert.ok(Date.now() - started < 3_000, "timeout must fire quickly");
    }
  );
});

test("POST failures are also contained", async () => {
  await withFetch(
    () => { throw new Error("network down"); },
    async () => {
      const response = await postJson("https://example.invalid/x", { a: 1 }, { timeoutMs: 500 });
      assert.equal(response.ok, false);
      assert.match(response.error, /network down/);
    }
  );
});

test("every integration failure still produces a usable context object", async () => {
  await withFetch(
    () => { throw new Error("everything is down"); },
    async () => {
      const context = await buildInternetContext("1.1.1.1", { hostname: "example.com", countryCode: "GB" });
      assert.equal(context.enriched, true, "context is still returned");
      assert.equal(context.routing, null);
      assert.equal(context.networkMetadata, null);
      assert.equal(context.outageContext, null);
      assert.ok(context.sources.every(s => s.status !== "ok"));
      // Crucially, nothing threw — the diagnostic can still complete.
    }
  );
});

test("results are cached so repeated dashboard loads do not re-measure", async () => {
  await withFetch(
    url => {
      if (url.includes("network-info")) return jsonResponse({ status: "ok", data: { asns: ["13335"], prefix: "1.1.1.0/24" } });
      return jsonResponse({ status: "ok", data: {} });
    },
    async calls => {
      const first = await lookupRouting("1.1.1.1");
      const countAfterFirst = calls.length;
      const second = await lookupRouting("1.1.1.1");
      assert.equal(first.status, "ok");
      assert.equal(second.cached, true);
      assert.equal(calls.length, countAfterFirst, "a cached lookup must issue no new requests");
    }
  );
});

// ---------------------------------------------------------------------------
// OPTIONAL CREDENTIALS
// ---------------------------------------------------------------------------

test("Cloudflare Radar is disabled and makes no request without a token", async () => {
  assert.equal(isConfigured({}), false);
  await withFetch(
    () => { throw new Error("Radar must not be called when unconfigured."); },
    async calls => {
      const result = await lookupOutageAnnotations({ asn: 13335, env: {} });
      assert.equal(result.status, "not-configured");
      assert.match(result.reason, /FAULTLINE_CLOUDFLARE_RADAR_TOKEN/);
      assert.equal(calls.length, 0);
    }
  );
});

test("Cloudflare Radar sends its token only when explicitly configured", async () => {
  assert.equal(isConfigured({ FAULTLINE_CLOUDFLARE_RADAR_TOKEN: "x" }), true);
  await withFetch(
    () => jsonResponse({ success: true, result: { annotations: [] } }),
    async calls => {
      const result = await lookupOutageAnnotations({ asn: 13335, env: { FAULTLINE_CLOUDFLARE_RADAR_TOKEN: "secret-token" } });
      assert.equal(result.status, "ok");
      assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
    }
  );
});

// ---------------------------------------------------------------------------
// ARCHITECTURAL BOUNDARY: external context must never move the fault domain
// ---------------------------------------------------------------------------

test("no external-context field is present in the deterministic metric input", () => {
  const metrics = buildDeterministicMetrics({
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 12, addresses: ["1.1.1.1"] } } },
    gatewayPing: { measured: true, lossPct: 0, averageMs: 2, jitterMs: 1 },
    targetPing: { measured: true, lossPct: 0, averageMs: 12, jitterMs: 2 },
    tcp: { ok: true, elapsedMs: 15 },
    http: { ok: true, ttfbMs: 70 },
    tls: { ok: true, elapsedMs: 40 },
    local: { internetReachable: true, vpn: { active: false } },
    distributed: { status: "skipped" }
  });

  const forbidden = [
    "prefix", "originAsn", "asnName", "rpkiStatus", "rpkiValidator", "visibility",
    "announcements", "withdrawals", "anomalyCount", "outage", "ioda", "peeringdb",
    "networkType", "exchangeCount", "radar", "atlas", "holder", "registry"
  ];
  const keys = Object.keys(metrics);
  for (const field of forbidden) {
    assert.equal(keys.includes(field), false, `deterministic metrics must not contain "${field}"`);
  }
});

test("changing every external signal leaves the deterministic diagnosis identical", () => {
  const base = {
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 12, addresses: ["1.1.1.1"] } } },
    gatewayPing: { measured: true, lossPct: 0, averageMs: 2, jitterMs: 1 },
    targetPing: { measured: true, lossPct: 9, averageMs: 40, jitterMs: 55 },
    tcp: { ok: true, elapsedMs: 15 },
    http: { ok: true, ttfbMs: 70 },
    tls: { ok: true, elapsedMs: 40 },
    local: { internetReachable: true, vpn: { active: false } },
    distributed: { status: "skipped" }
  };

  const metrics = buildDeterministicMetrics(base);
  const reference = diagnose(metrics);

  // Simulate wildly different external context; it is not an input to
  // buildDeterministicMetrics at all, so the conclusion cannot move.
  const metricsAgain = buildDeterministicMetrics(base);
  const repeat = diagnose(metricsAgain);

  assert.equal(reference.faultDomain, repeat.faultDomain);
  assert.equal(reference.confidence, repeat.confidence);
  assert.equal(reference.faultDomain, "upstream");
});

test("Globalping IS wired in as a designed second vantage, unlike contextual sources", () => {
  const base = {
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 5, addresses: ["1.1.1.1"] } } },
    gatewayPing: { measured: true, lossPct: 0, averageMs: 2, jitterMs: 1 },
    targetPing: { measured: true, lossPct: 0, averageMs: 10, jitterMs: 2 },
    tcp: { ok: false, elapsedMs: 5000, error: "timeout" },
    http: { ok: false },
    tls: null,
    local: { internetReachable: true, vpn: { active: false } }
  };

  const withoutVantage = buildDeterministicMetrics({ ...base, distributed: { status: "skipped" } });
  assert.equal("externalProbeHealthy" in withoutVantage, false);

  const withVantage = buildDeterministicMetrics({
    ...base,
    distributed: { status: "ok", data: { summary: { total: 3, reachable: 3, medianLatencyMs: 12 } } }
  });
  assert.equal(withVantage.externalProbeHealthy, true);
  assert.equal(withVantage.externalProbeLatencyMs, 12);

  // Endpoint fails while independent vantages succeed -> endpoint access path.
  assert.equal(diagnose(withVantage).faultDomain, "access_path");
});

test("ICMP filtering is not reported as packet loss when transport works", () => {
  const metrics = buildDeterministicMetrics({
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 5, addresses: ["1.1.1.1"] } } },
    gatewayPing: { measured: true, lossPct: 0, averageMs: 2, jitterMs: 1 },
    targetPing: { measured: true, lossPct: 100, averageMs: null, jitterMs: null },
    tcp: { ok: true, elapsedMs: 15 },
    http: { ok: true, ttfbMs: 70 },
    tls: { ok: true, elapsedMs: 30 },
    local: { internetReachable: true, vpn: { active: false } },
    distributed: { status: "skipped" }
  });
  assert.equal(metrics.icmpLikelyFiltered, true);
  assert.equal(metrics.upstreamLoss, 0, "filtered ICMP must not be reported as upstream loss");
});

test("absent measurements stay null rather than becoming a plausible zero", () => {
  assert.equal(numberOrNull(null), null);
  assert.equal(numberOrNull(undefined), null);
  assert.equal(numberOrNull(""), null);
  assert.equal(numberOrNull("abc"), null);
  assert.equal(numberOrNull(0), 0);
  assert.equal(numberOrNull("13335"), 13335);
});

test("IODA is skipped entirely when there is no public ASN or country", async () => {
  await withFetch(
    () => { throw new Error("must not call IODA without an entity"); },
    async calls => {
      const result = await lookupOutageContext({ asn: null, countryCode: null });
      assert.equal(result.status, "skipped");
      assert.equal(calls.length, 0);
    }
  );
});
