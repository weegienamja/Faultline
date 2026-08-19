import test from "node:test";
import assert from "node:assert/strict";
import {
  parseAsOverview,
  parseBgpUpdates,
  parseNetworkInfo,
  parseRoutingStatus,
  parseRpkiValidation
} from "../src/integrations/ripestat.mjs";
import { parseMeasurement, summariseVantages } from "../src/integrations/globalping.mjs";
import { parseAlerts, parseEntity } from "../src/integrations/ioda.mjs";
import { parseExchanges, parseNetwork } from "../src/integrations/peeringdb.mjs";
import { parseProbes } from "../src/integrations/ripe-atlas.mjs";
import { parseAnnotations } from "../src/integrations/cloudflare-radar.mjs";

// Fixtures below are trimmed copies of REAL responses captured from each
// public API, so the parsers are pinned to the shapes actually returned.

test("RIPEstat network-info maps prefix and origin ASN", () => {
  const parsed = parseNetworkInfo({ status: "ok", data: { asns: ["13335"], prefix: "1.1.1.0/24" } });
  assert.equal(parsed.prefix, "1.1.1.0/24");
  assert.equal(parsed.originAsn, 13335);
});

test("RIPEstat as-overview maps holder and announcement state", () => {
  const parsed = parseAsOverview({
    status: "ok",
    data: { type: "as", resource: "13335", holder: "CLOUDFLARENET - Cloudflare, Inc.", announced: true, block: { desc: "Assigned by ARIN" } }
  });
  assert.equal(parsed.asn, 13335);
  assert.equal(parsed.holder, "CLOUDFLARENET - Cloudflare, Inc.");
  assert.equal(parsed.announced, true);
  assert.equal(parsed.registry, "Assigned by ARIN");
});

test("RIPEstat RPKI validation maps every documented state", () => {
  for (const state of ["valid", "invalid", "unknown", "invalid_asn"]) {
    const parsed = parseRpkiValidation({ status: "ok", data: { status: state, validator: "routinator", validating_roas: [] } });
    assert.equal(parsed.status, state);
  }
  const upper = parseRpkiValidation({ status: "ok", data: { status: "VALID", validating_roas: [{}] } });
  assert.equal(upper.status, "valid", "status must be normalised to lower case");
  assert.equal(upper.roaCount, 1);
});

test("RIPEstat routing-status computes RIS visibility", () => {
  const parsed = parseRoutingStatus({
    status: "ok",
    data: {
      visibility: { v4: { ris_peers_seeing: 322, total_ris_peers: 323 }, v6: { ris_peers_seeing: 0, total_ris_peers: 0 } },
      first_seen: { time: "2001-11-14T00:00:00" },
      last_seen: { time: "2026-08-19T00:00:00" }
    }
  });
  assert.equal(parsed.risPeersSeeing, 322);
  assert.equal(parsed.visibilityPct, 99.7);
});

test("RIPEstat routing-status tolerates zero RIS peers without dividing by zero", () => {
  const parsed = parseRoutingStatus({ status: "ok", data: { visibility: { v4: {}, v6: {} } } });
  assert.equal(parsed.visibilityPct, null);
});

test("RIPEstat bgp-updates separates announcements from withdrawals", () => {
  const parsed = parseBgpUpdates({
    status: "ok",
    data: {
      nr_updates: 5,
      query_starttime: "2026-08-19T00:00:00",
      query_endtime: "2026-08-19T01:00:00",
      updates: [{ type: "A" }, { type: "A" }, { type: "W" }, { type: "A" }, { type: "X" }]
    }
  });
  assert.equal(parsed.announcements, 3);
  assert.equal(parsed.withdrawals, 1);
  assert.equal(parsed.totalReported, 5);
});

test("RIPEstat parsers reject error envelopes and malformed payloads", () => {
  assert.equal(parseNetworkInfo({ status: "error", data: { prefix: "1.1.1.0/24" } }), null);
  assert.equal(parseNetworkInfo(null), null);
  assert.equal(parseNetworkInfo({}), null);
  assert.equal(parseNetworkInfo("not json"), null);
  assert.equal(parseNetworkInfo({ status: "ok", data: {} }), null);
  assert.equal(parseAsOverview({ status: "ok" }), null);
  assert.equal(parseRpkiValidation({ status: "ok", data: {} }), null);
});

test("Globalping measurement maps probe geography and ping statistics", () => {
  const parsed = parseMeasurement({
    id: "abc", type: "ping", status: "finished", target: "example.com", probesCount: 2,
    results: [
      { probe: { continent: "EU", country: "GB", city: "London", asn: 16276, network: "OVH" },
        result: { status: "finished", resolvedAddress: "93.184.215.14", stats: { min: 1.45, max: 1.52, avg: 1.49, total: 3, loss: 0 } } },
      { probe: { continent: "NA", country: "US", city: "Buffalo", asn: 36352, network: "HostPapa" },
        result: { status: "failed", stats: { loss: 100, total: 3 } } }
    ]
  });
  assert.equal(parsed.vantages.length, 2);
  assert.equal(parsed.vantages[0].location, "London, GB");
  assert.equal(parsed.vantages[0].asn, 16276);
  assert.equal(parsed.vantages[0].latencyMs, 1.49);

  const summary = summariseVantages(parsed);
  assert.equal(summary.total, 2);
  assert.equal(summary.reachable, 1);
  assert.equal(summary.unreachable, 1);
});

test("Globalping parser survives missing result/probe fields", () => {
  const parsed = parseMeasurement({ id: "x", results: [{}, { probe: {}, result: {} }] });
  assert.equal(parsed.vantages.length, 2);
  assert.equal(parsed.vantages[0].latencyMs, null);
  assert.equal(parsed.vantages[0].location, "unknown");
  assert.equal(parseMeasurement(null), null);
});

test("IODA alerts separate anomalies from normal readings", () => {
  const parsed = parseAlerts({
    error: null,
    data: [
      { datasource: "bgp", level: "normal", value: 51, time: 1787023500, entity: { type: "asn", code: "13335", name: "AS13335" } },
      { datasource: "merit-nt", level: "critical", condition: "< 0.25", value: 16, time: 1787023560, entity: { type: "region", code: "4424", name: "Iowa" } },
      { datasource: "ping-slash24", level: "warning", value: 8, time: 1787023600, entity: { type: "asn", code: "999", name: "AS999" } }
    ]
  });
  assert.equal(parsed.total, 3);
  assert.equal(parsed.anomalyCount, 2, "normal readings must not be reported as anomalies");
  assert.equal(parsed.highestLevel, "critical");
  assert.equal(parsed.anomalies[0].at, new Date(1787023560 * 1000).toISOString());
});

test("IODA reports a clean network as zero anomalies, not as an error", () => {
  const parsed = parseAlerts({ error: null, data: [] });
  assert.equal(parsed.anomalyCount, 0);
  assert.equal(parsed.highestLevel, "none");
});

test("IODA parsers reject error envelopes", () => {
  assert.equal(parseAlerts({ error: "'from' timestamp must be set", data: null }), null);
  assert.equal(parseAlerts({ data: "nope" }), null);
  assert.equal(parseEntity({ error: "boom" }), null);
  const entity = parseEntity({ data: [{ code: "13335", name: "AS13335 (CLOUDFLARENET)", type: "asn", attrs: { org: "Cloudflare, Inc.", ip_count: "1337600" } }] });
  assert.equal(entity.org, "Cloudflare, Inc.");
  assert.equal(entity.ipCount, 1337600);
});

test("PeeringDB network metadata maps published fields only", () => {
  const parsed = parseNetwork({
    data: [{ id: 4224, name: "Cloudflare", asn: 13335, website: "https://www.cloudflare.com", info_type: "Content", info_traffic: "", info_scope: "Global", policy_general: "Open", ix_count: 357, fac_count: 223 }]
  });
  assert.equal(parsed.name, "Cloudflare");
  assert.equal(parsed.networkType, "Content");
  assert.equal(parsed.trafficProfile, null, "empty strings must become null, not empty output");
  assert.equal(parsed.exchangeCount, 357);
  assert.equal(parseNetwork({ data: [] }), null);
  assert.equal(parseNetwork(null), null);
});

test("PeeringDB exchange list drops non-operational entries", () => {
  const exchanges = parseExchanges({
    data: [
      { name: "LINX LON1: Main", speed: 300000, operational: true },
      { name: "Dead IX", speed: 1000, operational: false },
      { name: "DE-CIX Frankfurt", speed: 600000, operational: true }
    ]
  });
  assert.deepEqual(exchanges.map(e => e.name), ["LINX LON1: Main", "DE-CIX Frankfurt"]);
});

test("RIPE Atlas probe parsing maps ASN, country and coordinates", () => {
  const parsed = parseProbes({
    count: 648,
    results: [
      { id: 55, asn_v4: 20712, country_code: "GB", is_public: true, prefix_v4: "1.2.3.0/24", geometry: { coordinates: [1.1095, 51.3695] } },
      { id: 91, asn_v4: null, asn_v6: 13037, country_code: "GB", geometry: null }
    ]
  });
  assert.equal(parsed.total, 648);
  assert.equal(parsed.probes[0].asn, 20712);
  assert.equal(parsed.probes[0].latitude, 51.3695);
  assert.equal(parsed.probes[1].asn, 13037, "falls back to asn_v6");
  assert.equal(parsed.probes[1].latitude, null);
  assert.equal(parseProbes({}), null);
});

test("Cloudflare Radar annotations parse only on success envelopes", () => {
  assert.equal(parseAnnotations({ success: false, result: {} }), null);
  assert.equal(parseAnnotations({ success: true, result: {} }), null);
  const parsed = parseAnnotations({
    success: true,
    result: { annotations: [{ eventType: "OUTAGE", scope: "national", locations: [{ code: "GB" }], asns: [{ asn: 13335 }], startDate: "2026-08-19T00:00:00Z", description: "example" }] }
  });
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].locations, ["GB"]);
  assert.deepEqual(parsed[0].asns, [13335]);
});
