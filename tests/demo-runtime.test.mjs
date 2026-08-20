// Runtime capability model + abuse controls.
//
// The capability model is the single source of truth for what a deployment can
// observe. Its most important property is negative: on a hosted runtime it must
// report that it CANNOT see the endpoint, because every honest label in the
// interface is derived from that.

import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME, capabilities, detectRuntime, hostedVantage, isHosted, isPublicDemo, vantageFor } from "../src/runtime/capabilities.mjs";
import { DEMO_LIMITS, RateLimitError, clientKey, createDemoLimiter } from "../src/demo/limits.mjs";
import { ENDPOINT_SCOPED_FINDINGS, buildHostedMetrics, projectDiagnosisForVantage } from "../src/demo/vantage.mjs";
import { diagnose } from "../src/engine/diagnose.mjs";

const HOSTED = { FAULTLINE_RUNTIME: "hosted" };
const VERCEL = { VERCEL: "1", VERCEL_REGION: "lhr1" };
const LOCAL = {};

test("runtime detection: an explicit setting wins, then the platform", () => {
  assert.equal(detectRuntime(LOCAL), RUNTIME.LOCAL);
  assert.equal(detectRuntime(VERCEL), RUNTIME.HOSTED);
  assert.equal(detectRuntime(HOSTED), RUNTIME.HOSTED);
  // An operator can force local even on a platform, for a local reproduction.
  assert.equal(detectRuntime({ ...VERCEL, FAULTLINE_RUNTIME: "local" }), RUNTIME.LOCAL);
  assert.equal(isHosted(VERCEL), true);
  assert.equal(isHosted(LOCAL), false);
});

test("public demo follows the runtime unless explicitly set", () => {
  assert.equal(isPublicDemo(LOCAL), false);
  assert.equal(isPublicDemo(VERCEL), true);
  assert.equal(isPublicDemo({ FAULTLINE_PUBLIC_DEMO: "true" }), true);
  assert.equal(isPublicDemo({ ...VERCEL, FAULTLINE_PUBLIC_DEMO: "false" }), false);
  assert.equal(isPublicDemo({ FAULTLINE_PUBLIC_DEMO: "1" }), true);
  assert.equal(isPublicDemo({ FAULTLINE_PUBLIC_DEMO: "0" }), false);
});

test("a hosted vantage is never labelled LOCAL", () => {
  const vercel = hostedVantage(VERCEL);
  assert.equal(vercel.label, "VERCEL VANTAGE");
  assert.equal(vercel.region, "lhr1");

  // Hosted somewhere that is not Vercel must not claim Vercel.
  const other = hostedVantage({});
  assert.equal(other.label, "HOSTED VANTAGE");

  for (const vantage of [vercel, other]) {
    assert.doesNotMatch(vantage.label, /local/i);
    assert.doesNotMatch(vantage.longLabel, /local/i);
    assert.doesNotMatch(vantage.description, /this machine/i);
    assert.match(vantage.description, /not from your device/i);
  }

  assert.equal(vantageFor(LOCAL).label, "LOCAL");
  assert.equal(vantageFor(VERCEL).label, "VERCEL VANTAGE");
});

test("hosted capabilities deny every endpoint-local claim", () => {
  const hosted = capabilities(VERCEL);
  assert.equal(hosted.runtime, "hosted");
  assert.equal(hosted.publicDemo, true);
  assert.equal(hosted.endpointLocal, false);
  assert.equal(hosted.localEnvironment, false);
  assert.equal(hosted.windowsEndpointAgent, false);
  assert.equal(hosted.icmpAndTraceroute, false);
  assert.equal(hosted.endpointFlightRecorder, false);
  assert.equal(hosted.durablePersistence, false);
  assert.equal(hosted.analyst.available, false);
  assert.match(hosted.analyst.note, /local Faultline Agent/i);
  assert.ok(hosted.endpointOnly.length >= 6);

  // And still says the admin surfaces are protected.
  assert.equal(hosted.adminApiProtected, true);
});

test("local capabilities keep the full product", () => {
  const local = capabilities(LOCAL);
  assert.equal(local.runtime, "local");
  assert.equal(local.endpointLocal, true);
  assert.equal(local.durablePersistence, true);
  assert.equal(local.analyst.available, true);
  assert.deepEqual(local.endpointOnly, []);
});

test("the capability document carries no credential material", () => {
  const serialised = JSON.stringify(capabilities({ ...VERCEL, FAULTLINE_ADMIN_TOKEN: "fl_admin_super_secret_value" }));
  assert.doesNotMatch(serialised, /fl_admin/);
  assert.doesNotMatch(serialised, /super_secret_value/);
  assert.doesNotMatch(serialised, /token/i);
});

// ---------------------------------------------------------------------------
// Vantage scoping of a deterministic diagnosis
// ---------------------------------------------------------------------------

test("endpoint-scoped findings are reported as not measured, never as passing", () => {
  // A hosted run supplies none of the gateway/ICMP inputs, so the engine
  // defaults them to healthy and emits PASS findings about a gateway nobody
  // measured. Those must not reach a visitor as evidence.
  const metrics = buildHostedMetrics({
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 8 } } },
    tcp: { ok: true, elapsedMs: 20 },
    tls: { ok: true, elapsedMs: 40 },
    http: { ok: true, ttfbMs: 70 },
    distributed: { status: "ok", data: { summary: { total: 3, reachable: 3, medianLatencyMs: 9 } } },
    internetReachable: true
  });

  // The hosted metric set never invents an endpoint reading.
  for (const key of ["gatewayLoss", "gatewayLatencyMs", "upstreamLoss", "jitterMs", "vpnRequired", "vpnConnected"]) {
    assert.equal(key in metrics, false, `${key} must not be supplied by a hosted run`);
  }

  const diagnosis = diagnose(metrics);
  const projection = projectDiagnosisForVantage(diagnosis, hostedVantage(VERCEL));

  const notObservable = projection.notObservable.map(entry => entry.label);
  for (const label of Object.keys(ENDPOINT_SCOPED_FINDINGS)) {
    if (diagnosis.evidence.some(entry => entry.label === label)) {
      assert.ok(notObservable.includes(label), `${label} must be reported as not measured`);
    }
  }
  for (const entry of projection.notObservable) {
    assert.equal(entry.status, "not-measured");
    assert.equal(entry.requires, "Faultline Agent on the endpoint");
  }

  // Nothing endpoint-scoped survives into the evidence a visitor reads.
  for (const entry of projection.inScope) {
    assert.ok(!(entry.label in ENDPOINT_SCOPED_FINDINGS), `${entry.label} is endpoint-scoped and must not be in scope`);
  }

  // The engine's own conclusion is untouched.
  assert.equal(projection.vantage.label, "VERCEL VANTAGE");
  assert.ok(diagnosis.faultDomain);
});

test("in-scope findings are re-attributed to the vantage that took them", () => {
  const diagnosis = diagnose(buildHostedMetrics({
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 5 } } },
    tcp: { ok: true, elapsedMs: 10 },
    tls: null,
    http: { ok: true, ttfbMs: 30 },
    distributed: { status: "skipped" },
    internetReachable: true
  }));
  const projection = projectDiagnosisForVantage(diagnosis, hostedVantage(VERCEL));

  for (const entry of projection.inScope) {
    assert.doesNotMatch(entry.detail || "", /from this endpoint/i);
    assert.doesNotMatch(entry.detail || "", /this machine/i);
  }
  const targetFinding = projection.inScope.find(entry => entry.label === "Target service");
  assert.ok(targetFinding);
  assert.match(targetFinding.detail, /hosted Vercel vantage/i);
});

test("Globalping is the only external source allowed into the engine input", () => {
  const metrics = buildHostedMetrics({
    dns: { measured: true, state: "resolved", system: { a: { elapsedMs: 5 } } },
    tcp: { ok: true, elapsedMs: 10 },
    tls: null,
    http: { ok: true, ttfbMs: 30 },
    distributed: { status: "ok", data: { summary: { total: 3, reachable: 2, medianLatencyMs: 40 } } },
    internetReachable: true
  });
  assert.equal(metrics.externalProbeHealthy, true);
  assert.equal(metrics.externalProbeLatencyMs, 40);
  // Routing / RPKI / outage context must never appear as an engine input.
  const keys = Object.keys(metrics).join(" ");
  assert.doesNotMatch(keys, /rpki|prefix|asn|outage|radar|peering/i);
});

// ---------------------------------------------------------------------------
// Abuse controls
// ---------------------------------------------------------------------------

test("the client key uses the rightmost forwarded hop, not the spoofable left", () => {
  assert.equal(clientKey({ headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" } }), "203.0.113.9");
  assert.equal(clientKey({ headers: { "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" } }), "203.0.113.7");
  assert.equal(clientKey({ headers: {}, socket: { remoteAddress: "198.51.100.2" } }), "198.51.100.2");
  assert.equal(clientKey({ headers: {} }), "unknown");
});

test("per-client, per-instance and concurrency limits all hold", () => {
  let now = 1_000_000;
  const limiter = createDemoLimiter({
    limits: { ...DEMO_LIMITS, perClientPerMinute: 2, perInstancePerMinute: 4, maxConcurrent: 2 },
    now: () => now
  });

  const a1 = limiter.acquire("a"); a1();
  const a2 = limiter.acquire("a"); a2();
  assert.throws(() => limiter.acquire("a"), RateLimitError, "third request from one client is refused");

  // A client that is already locked out must not have spent instance budget on
  // its refused attempts, so two other clients still get their turn.
  const b1 = limiter.acquire("b"); b1();
  const c1 = limiter.acquire("c"); c1();
  assert.throws(() => limiter.acquire("d"), RateLimitError, "instance budget is refused independently");

  // The window rolls.
  now += 61_000;
  const later = limiter.acquire("a");
  later();
});

test("concurrency is released even when a run fails", () => {
  const limiter = createDemoLimiter({ limits: { ...DEMO_LIMITS, maxConcurrent: 1 } });
  const release = limiter.acquire("x");
  assert.throws(() => limiter.acquire("y"), RateLimitError);
  release();
  // Double release must not lend a phantom slot.
  release();
  const again = limiter.acquire("y");
  assert.equal(limiter.snapshot().inFlight, 1);
  again();
  assert.equal(limiter.snapshot().inFlight, 0);
});

test("the limiter describes its scope honestly", () => {
  const description = createDemoLimiter().describe();
  assert.equal(description.durable, false);
  assert.equal(description.scope, "instance");
  assert.match(description.note, /per hosted Function instance/i);
  assert.match(description.note, /best-effort/i);
});
