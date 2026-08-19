import test from "node:test";
import assert from "node:assert/strict";

import { createSampleBuffer } from "../src/recorder/buffer.mjs";
import { classifySample, pathFingerprint, readCheapLocalState, sampleContract, takeSample, NOT_SAMPLED, STATE } from "../src/recorder/sample.mjs";
import { detectTriggers, diffSamples, opensIncident, primaryTrigger, TRIGGER, WATCHED_FIELDS } from "../src/recorder/triggers.mjs";
import { buildCandidates, buildIncident, resetIncidentCounter, summariseIncident } from "../src/recorder/incident.mjs";
import { projectDeepCapture } from "../src/recorder/deep-capture.mjs";
import { RESULT } from "../src/bisect/results.mjs";

// Buffer, sampling, triggers and incident assembly. Pure logic over injected
// dependencies: no network, no PowerShell, no timers that outlive a test.

// --- fixtures ---------------------------------------------------------------

function sampleAt(at, overrides = {}) {
  const base = {
    seq: 0,
    at,
    tier: "fast",
    local: {
      observedAt: at,
      carriedForward: false,
      supported: true,
      activeInterface: "Ethernet",
      gateway: "192.168.1.1",
      route: { destination: "0.0.0.0/0", nextHop: "192.168.1.1", interfaceAlias: "Ethernet", metric: 25 },
      resolvers: ["10.20.0.53"],
      wifi: { ssid: "office-5g", bssid: "aa:bb:cc:dd:ee:01" },
      vpn: { active: true, adapters: ["Corp VPN"] },
      interfaces: []
    },
    connectivity: {
      ipv4: { state: RESULT.PASS, ms: 31 },
      ipv6: { state: RESULT.PASS, ms: 34 },
      gateway: { state: RESULT.PASS, lossPct: 0, averageMs: 2 },
      targetDns: { state: RESULT.PASS, v4: 1, v6: 1 },
      targetTcp: { state: RESULT.PASS, ms: 31 },
      contract: { contractId: "basic-reachability", state: "PASS", sampledChecks: 2, unsampledChecks: 0 }
    },
    path: { publicIp: { value: "203.0.113.9", observedAt: at }, resolvedAddress: "93.184.216.34", fingerprint: "fp-healthy" },
    state: STATE.HEALTHY,
    reasons: []
  };
  return deepMerge(base, overrides);
}

function deepMerge(base, overrides) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(overrides || {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

const failing = at => sampleAt(at, {
  connectivity: { targetTcp: { state: RESULT.FAIL, error: "ETIMEDOUT", ms: undefined } },
  path: { fingerprint: "fp-failing" },
  state: STATE.FAILED,
  reasons: ["target TCP unreachable"]
});

// --- buffer -----------------------------------------------------------------

test("the buffer drops samples outside the retention window", () => {
  let clock = 100_000;
  const buffer = createSampleBuffer({ windowMs: 10_000, now: () => clock });
  for (let i = 0; i < 5; i += 1) buffer.push({ at: new Date(clock + i * 3_000).toISOString() });
  clock += 12_000;
  buffer.push({ at: new Date(clock).toISOString() });
  assert.ok(buffer.size() < 6, "expired samples should be evicted");
  assert.ok(Date.parse(buffer.coverage().from) >= clock - 10_000);
});

test("the buffer enforces a hard sample cap regardless of window", () => {
  const buffer = createSampleBuffer({ windowMs: 60 * 60_000, maxSamples: 10, now: () => Date.now() });
  for (let i = 0; i < 50; i += 1) buffer.push({ at: new Date().toISOString() });
  assert.equal(buffer.size(), 10);
});

// The fixture timestamps are fixed, so these buffers must be given a clock
// anchored to them. Using the wall clock would make the tests pass only within
// one window of the fixture time and fail forever after.
const FIXTURE_NOW = () => Date.parse("2026-08-19T20:46:20.000Z");

test("freeze returns copies that later eviction cannot mutate", () => {
  const buffer = createSampleBuffer({ windowMs: 60_000, now: FIXTURE_NOW });
  buffer.push(sampleAt("2026-08-19T20:45:51.000Z"));
  const frozen = buffer.freeze();
  buffer.clear();
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].local.activeInterface, "Ethernet");

  frozen[0].local.activeInterface = "mutated";
  assert.notEqual(buffer.latest()?.local?.activeInterface, "mutated");
});

test("freezeBefore captures only the pre-trigger window", () => {
  const buffer = createSampleBuffer({ windowMs: 600_000, now: FIXTURE_NOW });
  buffer.push(sampleAt("2026-08-19T20:45:51.000Z"));
  buffer.push(sampleAt("2026-08-19T20:46:06.000Z"));
  buffer.push(failing("2026-08-19T20:46:18.000Z"));
  const before = buffer.freezeBefore("2026-08-19T20:46:18.000Z");
  assert.equal(before.length, 2);
  assert.ok(before.every(entry => entry.state === STATE.HEALTHY));
});

// --- sampling ---------------------------------------------------------------

test("cheap local state needs no process spawn", () => {
  const local = readCheapLocalState();
  assert.ok(Array.isArray(local.interfaces));
  assert.ok(Array.isArray(local.resolvers));
  assert.equal(typeof local.hasIpv4Address, "boolean");
});

test("the path fingerprint changes only when identity fields change", () => {
  const base = { activeInterface: "Ethernet", gateway: "192.168.1.1", route: null, resolvers: ["10.0.0.1"], publicIp: "203.0.113.9", resolvedAddress: "93.184.216.34" };
  assert.equal(pathFingerprint(base), pathFingerprint({ ...base }));
  assert.notEqual(pathFingerprint(base), pathFingerprint({ ...base, gateway: "192.168.1.254" }));
  // Resolver order is not a change.
  assert.equal(pathFingerprint({ ...base, resolvers: ["10.0.0.1"] }), pathFingerprint({ ...base, resolvers: ["10.0.0.1"] }));
});

const baseDeps = {
  cheapLocal: () => ({ interfaces: [], resolvers: ["10.0.0.1"], hasIpv4Address: true, hasIpv6Address: false }),
  localEnvironment: async () => { throw new Error("must not be called on a fast tick"); }
};

test("a target that publishes no AAAA is INAPPLICABLE for IPv6, never FAIL", async () => {
  const { sample } = await takeSample({
    target: { host: "v4only.example", port: 443, input: "v4only.example" },
    deps: {
      ...baseDeps,
      // DNS answered: there is no AAAA record. That is a target property.
      resolve: async () => ({ v4: ["93.184.216.34"], v6: [], v4NoRecords: false, v6NoRecords: true, v4Error: null, v6Error: null }),
      tcp: async () => ({ ok: true, elapsedMs: 30 })
    }
  });
  assert.equal(sample.connectivity.ipv6.state, RESULT.INAPPLICABLE);
  assert.match(sample.connectivity.ipv6.reason, /publishes no address/);
  assert.equal(sample.connectivity.ipv4.state, RESULT.PASS);
  assert.equal(sample.state, STATE.HEALTHY);
});

test("a target that publishes AAAA this machine cannot reach is FAIL, not INAPPLICABLE", async () => {
  // The distinction that matters: reporting this as INAPPLICABLE would present
  // a local IPv6 capability deficiency as a property of the target.
  const { sample } = await takeSample({
    target: { host: "dualstack.example", port: 443, input: "dualstack.example" },
    deps: {
      ...baseDeps,
      resolve: async () => ({
        v4: ["93.184.216.34"],
        v6: ["2606:4700:10::ac42:93f3"],
        v4NoRecords: false, v6NoRecords: false, v4Error: null, v6Error: null
      }),
      tcp: async address => (address.includes(":")
        ? { ok: false, elapsedMs: 2_500, error: "ENETUNREACH" }
        : { ok: true, elapsedMs: 30 })
    }
  });
  assert.equal(sample.connectivity.ipv6.state, RESULT.FAIL);
  assert.equal(sample.connectivity.ipv6.error, "ENETUNREACH");
  assert.equal(sample.connectivity.ipv4.state, RESULT.PASS);
  // Either family connecting means the target is reachable.
  assert.equal(sample.connectivity.targetTcp.state, RESULT.PASS);
});

test("a resolution failure is UNKNOWN, not INAPPLICABLE and not FAIL", async () => {
  const { sample } = await takeSample({
    target: { host: "unreachable-dns.example", port: 443, input: "unreachable-dns.example" },
    deps: {
      ...baseDeps,
      // The resolver itself failed: nothing was established either way.
      resolve: async () => ({ v4: [], v6: [], v4NoRecords: false, v6NoRecords: false, v4Error: "ESERVFAIL", v6Error: "ESERVFAIL" }),
      tcp: async () => { throw new Error("must not connect without an address"); }
    }
  });
  assert.equal(sample.connectivity.ipv4.state, "UNKNOWN");
  assert.equal(sample.connectivity.ipv6.state, "UNKNOWN");
  assert.equal(sample.connectivity.targetDns.state, "UNKNOWN");
  assert.match(sample.connectivity.ipv4.reason, /resolution failed/);
});

test("resolveTargetAddresses asks DNS directly rather than through the local stack", async () => {
  // A stub standing in for a machine with no IPv6: lookup() would hide the
  // AAAA records that resolve6() returns.
  const resolver = {
    resolve4: async () => ["93.184.216.34"],
    resolve6: async () => ["2606:4700:10::ac42:93f3"],
    lookup: async () => { throw Object.assign(new Error("no IPv6"), { code: "ENOENT" }); }
  };
  const { resolveTargetAddresses } = await import("../src/recorder/sample.mjs");
  const resolved = await resolveTargetAddresses("example.com", { resolver });
  assert.deepEqual(resolved.v6, ["2606:4700:10::ac42:93f3"]);
  assert.equal(resolved.v6NoRecords, false);
  assert.equal(resolved.source, "dns");
});

test("a hosts-file name still resolves through the system fallback", async () => {
  const resolver = {
    resolve4: async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); },
    resolve6: async () => { throw Object.assign(new Error("nope"), { code: "ENOTFOUND" }); },
    lookup: async () => [{ address: "10.1.2.3", family: 4 }]
  };
  const { resolveTargetAddresses } = await import("../src/recorder/sample.mjs");
  const resolved = await resolveTargetAddresses("internal-box", { resolver });
  assert.deepEqual(resolved.v4, ["10.1.2.3"]);
  assert.equal(resolved.source, "system");
});

test("a fast tick does not run the expensive local collector", async () => {
  let spawned = 0;
  await takeSample({
    target: { host: "example.com", port: 443, input: "example.com" },
    slow: false,
    deps: {
      cheapLocal: () => ({ interfaces: [], resolvers: [], hasIpv4Address: true, hasIpv6Address: true }),
      resolve: async () => ({ v4: ["1.2.3.4"], v6: [], v4Error: null, v6Error: null }),
      tcp: async () => ({ ok: true, elapsedMs: 10 }),
      localEnvironment: async () => { spawned += 1; return {}; },
      ping: async () => { spawned += 1; return { measured: true, state: "responded", lossPct: 0, averageMs: 1 }; }
    }
  });
  assert.equal(spawned, 0, "the slow tier must not run on a fast tick");
});

test("a carried-forward slow value keeps its original timestamp", async () => {
  const target = { host: "example.com", port: 443, input: "example.com" };
  const deps = {
    cheapLocal: () => ({ interfaces: [], resolvers: [], hasIpv4Address: true, hasIpv6Address: false }),
    resolve: async () => ({ v4: ["1.2.3.4"], v6: [], v4Error: null, v6Error: null }),
    tcp: async () => ({ ok: true, elapsedMs: 10 }),
    localEnvironment: async () => ({ supported: true, gateway: "192.168.1.1", interfaceAlias: "Ethernet", routes: [], wifi: null, vpn: { active: false, adapters: [] } }),
    ping: async () => ({ measured: true, state: "responded", lossPct: 0, averageMs: 1, jitterMs: 0 })
  };

  let clock = Date.parse("2026-08-19T20:00:00.000Z");
  const slow = await takeSample({ target, slow: true, deps, now: () => new Date(clock) });
  assert.equal(slow.sample.local.observedAt, "2026-08-19T20:00:00.000Z");
  assert.equal(slow.sample.local.carriedForward, false);

  clock += 3_000;
  const fast = await takeSample({ target, slow: false, carried: slow.carried, deps, now: () => new Date(clock) });
  assert.equal(fast.sample.at, "2026-08-19T20:00:03.000Z");
  // The value is reused but never re-dated.
  assert.equal(fast.sample.local.observedAt, "2026-08-19T20:00:00.000Z");
  assert.equal(fast.sample.local.carriedForward, true);
});

test("a lightweight contract sample reports a pass as partial, a fail as conclusive", async () => {
  const contract = {
    id: "secure-web",
    checks: [
      { id: "dns", type: "dns", required: true, host: "$target.host" },
      { id: "tcp", type: "tcp", required: true, host: "$target.host", port: "$target.port" },
      { id: "tls", type: "tls", required: true },
      { id: "http", type: "http", required: true }
    ]
  };
  const target = { host: "example.com", port: 443 };

  const passing = await sampleContract(contract, target, {
    tcp: async () => ({ ok: true, elapsedMs: 12 }),
    addresses: { v4: ["1.2.3.4"], v6: [] }
  });
  // Cheap checks passed but TLS/HTTP were never run: not a clean pass.
  assert.equal(passing.state, "PARTIAL");
  assert.equal(passing.unsampledChecks, 2);
  assert.match(passing.note, /not evaluated in a lightweight sample/);

  const failed = await sampleContract(contract, target, {
    tcp: async () => ({ ok: false, elapsedMs: 2_500, error: "ETIMEDOUT" }),
    addresses: { v4: ["1.2.3.4"], v6: [] }
  });
  // A failing required check fails the contract regardless of what was skipped.
  assert.equal(failed.state, "FAIL");
  assert.deepEqual(failed.failedRequired, ["tcp"]);
});

test("classification is deterministic and names its reasons", () => {
  assert.equal(classifySample(sampleAt("2026-08-19T20:00:00.000Z")).state, STATE.HEALTHY);

  const down = classifySample(failing("2026-08-19T20:00:00.000Z"));
  assert.equal(down.state, STATE.FAILED);
  assert.ok(down.reasons.includes("target TCP unreachable"));

  const lossy = classifySample(sampleAt("2026-08-19T20:00:00.000Z", {
    connectivity: { gateway: { state: RESULT.PASS, lossPct: 12, averageMs: 5 } }
  }));
  assert.equal(lossy.state, STATE.DEGRADED);
  assert.match(lossy.reasons[0], /gateway loss/);
});

test("an unsampled gateway does not count as degradation", () => {
  const result = classifySample(sampleAt("2026-08-19T20:00:00.000Z", {
    connectivity: { gateway: { state: NOT_SAMPLED } }
  }));
  assert.equal(result.state, STATE.HEALTHY);
  assert.deepEqual(result.reasons, []);
});

// --- triggers ---------------------------------------------------------------

test("a PASS to FAIL reachability transition fires the primary trigger", () => {
  const fired = detectTriggers(sampleAt("2026-08-19T20:46:06.000Z"), failing("2026-08-19T20:46:18.000Z"));
  const reachability = fired.find(entry => entry.type === TRIGGER.TARGET_REACHABILITY);
  assert.ok(reachability);
  assert.equal(reachability.direction, "pass_to_fail");
  assert.equal(primaryTrigger(fired).type, TRIGGER.TARGET_REACHABILITY);
});

test("recovery is recorded but does not open an incident", () => {
  const fired = detectTriggers(failing("2026-08-19T20:46:18.000Z"), sampleAt("2026-08-19T20:46:46.000Z"));
  const recovery = fired.find(entry => entry.type === TRIGGER.TARGET_REACHABILITY);
  assert.equal(recovery.direction, "fail_to_pass");
  assert.equal(recovery.recovery, true);
  assert.equal(primaryTrigger(fired), null);
  assert.equal(opensIncident(recovery), false);
});

test("a contract failure fires only on the transition into FAIL", () => {
  const healthy = sampleAt("2026-08-19T20:00:00.000Z");
  const broken = sampleAt("2026-08-19T20:00:03.000Z", {
    connectivity: { contract: { contractId: "secure-web", state: "FAIL", failedRequired: ["tcp"] } }
  });
  assert.ok(detectTriggers(healthy, broken).some(entry => entry.type === TRIGGER.CONTRACT_FAILURE));
  // Still failing is not a new event.
  assert.equal(detectTriggers(broken, broken).some(entry => entry.type === TRIGGER.CONTRACT_FAILURE), false);
});

test("gateway degradation fires on threshold crossing, not on every lossy sample", () => {
  const clean = sampleAt("2026-08-19T20:00:00.000Z");
  const lossy = sampleAt("2026-08-19T20:00:03.000Z", { connectivity: { gateway: { state: RESULT.PASS, lossPct: 20, averageMs: 3 } } });
  assert.ok(detectTriggers(clean, lossy).some(entry => entry.type === TRIGGER.GATEWAY_DEGRADATION));
  assert.equal(detectTriggers(lossy, lossy).some(entry => entry.type === TRIGGER.GATEWAY_DEGRADATION), false);
});

test("a network-state change is reported as an observation, not a fault", () => {
  const before = sampleAt("2026-08-19T20:00:00.000Z");
  const after = sampleAt("2026-08-19T20:00:03.000Z", {
    local: { route: { destination: "0.0.0.0/0", nextHop: "10.8.0.1", interfaceAlias: "Corp VPN", metric: 5 } },
    path: { fingerprint: "fp-changed" }
  });
  const fired = detectTriggers(before, after);
  const change = fired.find(entry => entry.type === TRIGGER.NETWORK_STATE_CHANGE);
  assert.ok(change);
  assert.match(change.note, /observation, not a fault/);
  // By default a marker alone does not justify a deep capture.
  assert.equal(opensIncident(change), false);
  assert.equal(opensIncident(change, { captureOnStateChange: true }), true);
});

test("reachability outranks a coincident state change", () => {
  const before = sampleAt("2026-08-19T20:46:06.000Z");
  const after = failing("2026-08-19T20:46:18.000Z", {});
  after.local.route = { destination: "0.0.0.0/0", nextHop: "10.8.0.1", interfaceAlias: "Corp VPN", metric: 5 };
  const fired = detectTriggers(before, after);
  assert.ok(fired.length >= 2, "both reachability and state change should fire");
  assert.equal(primaryTrigger(fired).type, TRIGGER.TARGET_REACHABILITY);
});

test("an unknown or carried-forward field is never reported as a change", () => {
  const before = sampleAt("2026-08-19T20:00:00.000Z");
  const after = sampleAt("2026-08-19T20:00:03.000Z", { local: { activeInterface: null, wifi: { ssid: null, bssid: null } } });
  const { changes } = diffSamples(before, after);
  assert.equal(changes.some(change => change.key === "activeInterface"), false);
  assert.equal(changes.some(change => change.key === "wifiBssid"), false);
});

test("a CDN rotating within a known address pool is not a change", () => {
  // example.com behind a CDN returns a different subset each lookup. Reporting
  // that as "the target moved" would fire a network-state change every tick.
  const before = sampleAt("2026-08-19T20:00:00.000Z", {
    path: { resolvedAddress: "93.184.216.34", resolvedAddresses: ["93.184.216.34", "93.184.216.35"] }
  });
  const after = sampleAt("2026-08-19T20:00:03.000Z", {
    path: { resolvedAddress: "93.184.216.35", resolvedAddresses: ["93.184.216.35", "93.184.216.36"] }
  });
  const { changes } = diffSamples(before, after);
  assert.equal(changes.some(change => change.key === "resolvedAddress"), false);
});

test("a target repointed to a disjoint address set is a change", () => {
  const before = sampleAt("2026-08-19T20:00:00.000Z", {
    path: { resolvedAddress: "93.184.216.34", resolvedAddresses: ["93.184.216.34"] }
  });
  const after = sampleAt("2026-08-19T20:00:03.000Z", {
    path: { resolvedAddress: "198.51.100.7", resolvedAddresses: ["198.51.100.7"] }
  });
  const { changes } = diffSamples(before, after);
  const change = changes.find(entry => entry.key === "resolvedAddress");
  assert.ok(change, "a genuine repoint should be reported");
  assert.equal(change.bisectAxis, "address");
});

test("the path fingerprint describes egress, not destination", () => {
  // Two samples differing only in resolved address must share a fingerprint.
  const base = { activeInterface: "Ethernet", gateway: "192.168.1.1", route: null, resolvers: ["10.0.0.1"], publicIp: "203.0.113.9" };
  assert.equal(pathFingerprint(base), pathFingerprint({ ...base }));
  assert.notEqual(pathFingerprint(base), pathFingerprint({ ...base, activeInterface: "Corp VPN" }));
});

test("every watched field declares whether Bisect can test it", () => {
  for (const field of WATCHED_FIELDS) {
    assert.ok(field.label, `${field.key} needs a label`);
    assert.ok(Object.hasOwn(field, "bisectAxis"), `${field.key} must state its axis or null`);
  }
  const axes = new Set(WATCHED_FIELDS.map(field => field.bisectAxis).filter(Boolean));
  // Only axes the engine actually implements.
  for (const axis of axes) {
    assert.ok(["source-interface", "resolver", "address", "address-family"].includes(axis), `unknown axis ${axis}`);
  }
});

// --- incident assembly ------------------------------------------------------

test("an incident states the observed difference without claiming cause", () => {
  resetIncidentCounter();
  const before = [sampleAt("2026-08-19T20:45:51.000Z"), sampleAt("2026-08-19T20:46:06.000Z")];
  const during = [failing("2026-08-19T20:46:18.000Z")];
  during[0].local.route = { destination: "0.0.0.0/0", nextHop: "10.8.0.1", interfaceAlias: "Corp VPN", metric: 5 };
  const after = [sampleAt("2026-08-19T20:46:46.000Z")];

  const incident = buildIncident({
    id: "FLR-2026-0007",
    target: { host: "api.example.com", port: 443, input: "api.example.com" },
    trigger: { type: TRIGGER.TARGET_REACHABILITY, at: "2026-08-19T20:46:18.000Z", summary: "Target TCP reachability changed PASS → FAIL" },
    before, during, after
  });

  assert.equal(incident.observedChange.comparable, true);
  assert.equal(incident.observedChange.classification, "temporal_association");
  assert.ok(incident.observedChange.differences.some(change => change.key === "defaultRoute"));

  const statement = incident.observedChange.statement.toLowerCase();
  assert.match(statement, /differs by/);
  // The words that would turn observation into a determination.
  for (const forbidden of ["caused", "because of", "due to", "responsible for"]) {
    assert.ok(!statement.includes(forbidden), `statement must not claim causation: found "${forbidden}"`);
  }
  assert.match(incident.observedChange.note, /not proof/);
  assert.match(incident.epistemics.limit, /not causation/);
});

test("an incident with no retained healthy sample says so rather than guessing", () => {
  const incident = buildIncident({
    id: "FLR-2026-0001",
    target: { host: "example.com", port: 443 },
    trigger: { type: TRIGGER.TARGET_REACHABILITY, at: "2026-08-19T20:46:18.000Z" },
    before: [],
    during: [failing("2026-08-19T20:46:18.000Z")]
  });
  assert.equal(incident.observedChange.comparable, false);
  assert.equal(incident.observedChange.classification, "insufficient_evidence");
  assert.match(incident.observedChange.reason, /No healthy sample/);
  assert.deepEqual(incident.candidateDiscriminators.testable, []);
});

test("candidate discriminators map only to axes Bisect implements", () => {
  const observedChange = {
    comparable: true,
    differences: [
      { key: "activeInterface", label: "Active interface", from: "Ethernet", to: "Corp VPN", bisectAxis: "source-interface" },
      { key: "ipv6", label: "IPv6 capability to target", from: "PASS", to: "FAIL", bisectAxis: "address-family" },
      { key: "publicIp", label: "Public IP", from: "203.0.113.9", to: "198.51.100.4", bisectAxis: null }
    ]
  };
  const candidates = buildCandidates(observedChange);

  assert.deepEqual(candidates.bisectAxes.sort(), ["address-family", "source-interface"]);
  assert.equal(candidates.testable.length, 2);
  // Untestable observations are surfaced, not silently dropped.
  assert.equal(candidates.untestable.length, 1);
  assert.equal(candidates.untestable[0].condition, "Public IP");
  assert.match(candidates.note, /not causes/);
});

test("recovery is recorded in the observed change when it happens", () => {
  const incident = buildIncident({
    id: "FLR-2026-0002",
    target: { host: "example.com", port: 443 },
    trigger: { type: TRIGGER.TARGET_REACHABILITY, at: "2026-08-19T20:46:18.000Z" },
    before: [sampleAt("2026-08-19T20:46:06.000Z")],
    during: [failing("2026-08-19T20:46:18.000Z")],
    after: [sampleAt("2026-08-19T20:46:46.000Z")]
  });
  assert.ok(incident.observedChange.recovery);
  assert.match(incident.observedChange.statement, /reachable again/);
  assert.equal(summariseIncident(incident).recovered, true);
});

test("a manual capture on a healthy network does not invent a failure", () => {
  // The wording trap: a manual mark while everything works must not produce a
  // record that says the target failed and later recovered.
  const incident = buildIncident({
    id: "FLR-2026-0004",
    target: { host: "example.com", port: 443 },
    trigger: { type: TRIGGER.MANUAL, at: "2026-08-19T20:00:03.000Z", summary: "Manual capture requested" },
    before: [sampleAt("2026-08-19T20:00:00.000Z")],
    during: [sampleAt("2026-08-19T20:00:03.000Z")],
    after: [sampleAt("2026-08-19T20:00:06.000Z")]
  });

  const change = incident.observedChange;
  assert.equal(change.hadFailure, false);
  assert.equal(change.recovery, null, "nothing recovered because nothing failed");
  const statement = change.statement.toLowerCase();
  assert.ok(!statement.includes("failing sample"), "must not call a healthy sample a failing one");
  assert.ok(!statement.includes("became unreachable"));
  assert.ok(!statement.includes("reachable again"));
  assert.match(change.statement, /still reachable/);
  // The qualification must not reference a failure that did not occur.
  assert.match(change.note, /Nothing failed during this capture/);
});

test("the two-vantage comparison states what actually happened locally", () => {
  const stages = local => ({ observed: { stages: [{ name: "TCP", state: local, ms: 12, detail: "" }] } });

  const bothOk = projectDeepCapture({ ...stages("pass"), distributed: { status: "ok", data: { summary: { reachable: 3, total: 3 } } } });
  assert.equal(bothOk.external.localReached, true);
  assert.match(bothOk.external.meaning, /Both this endpoint and independent vantage points reached/);

  const localFailed = projectDeepCapture({ ...stages("fail"), distributed: { status: "ok", data: { summary: { reachable: 3, total: 3 } } } });
  assert.match(localFailed.external.meaning, /while this endpoint did not/);

  const targetDown = projectDeepCapture({ ...stages("fail"), distributed: { status: "ok", data: { summary: { reachable: 0, total: 3 } } } });
  assert.match(targetDown.external.meaning, /Neither this endpoint nor independent vantage points/);

  const localOnly = projectDeepCapture({ ...stages("pass"), distributed: { status: "ok", data: { summary: { reachable: 0, total: 3 } } } });
  assert.match(localOnly.external.meaning, /This endpoint reached the target while independent vantage points did not/);
});

test("a deep capture that failed does not break the incident", () => {
  const incident = buildIncident({
    id: "FLR-2026-0003",
    target: { host: "example.com", port: 443 },
    trigger: { type: TRIGGER.MANUAL, at: "2026-08-19T20:46:18.000Z" },
    before: [sampleAt("2026-08-19T20:46:06.000Z")],
    during: [failing("2026-08-19T20:46:18.000Z")],
    deepCapture: { available: false, reason: "The deeper diagnostic could not be completed during this incident." }
  });
  assert.equal(incident.deepCapture.available, false);
  assert.equal(incident.trigger.manual, true);
  assert.ok(incident.observedChange.comparable);
});

// --- deep capture projection ------------------------------------------------

test("the deep capture projection separates the deterministic verdict from context", () => {
  const projected = projectDeepCapture({
    id: "LIVE-1",
    observed: {
      stages: [
        { name: "DNS", state: "pass", ms: 12, detail: "1 A record" },
        { name: "TCP", state: "fail", ms: null, detail: "timed out" },
        { name: "TLS", state: "not-measured", detail: "not reached" }
      ],
      path: [{ hop: 1, address: "192.168.1.1", rttMs: 2 }]
    },
    deterministic: { diagnosis: { faultDomain: "access_path", faultDomainLabel: "Endpoint access path", confidence: 74, summary: "…" } },
    distributed: { status: "ok", data: { summary: { reachable: 3, total: 3, medianLatencyMs: 20 } } }
  });

  assert.equal(projected.deterministic.faultDomain, "access_path");
  assert.equal(projected.external.state, "reachable");
  assert.match(projected.external.meaning, /Independent vantage points reached the target/);
  // A stage that was never reached stays that way.
  assert.equal(projected.stages.find(stage => stage.name === "TLS").state, "not-measured");
});

test("a deep capture without an independent vantage says not-measured", () => {
  const projected = projectDeepCapture({ observed: { stages: [] }, distributed: { status: "unavailable", reason: "no vantage" } });
  assert.equal(projected.external.state, "not-measured");
});
