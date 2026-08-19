import test from "node:test";
import assert from "node:assert/strict";

import { createRecorder, RECORDER_STATE } from "../src/recorder/recorder.mjs";
import { TRIGGER } from "../src/recorder/triggers.mjs";
import { STATE } from "../src/recorder/sample.mjs";
import { RESULT } from "../src/bisect/results.mjs";

// The engine: scheduling, freezing, incident lifecycle and bounds.
//
// Time and sampling are both injected, so these tests run in milliseconds and
// are fully deterministic. Nothing here touches a network or a real timer.

/** A controllable clock plus a setTimeout that only fires when advanced. */
function fakeClock(start = Date.parse("2026-08-19T20:45:00.000Z")) {
  let current = start;
  let nextId = 1;
  const pending = new Map();

  return {
    now: () => current,
    api: {
      setTimeout(fn, ms) {
        const id = nextId++;
        pending.set(id, { fn, due: current + ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      }
    },
    /** Fire every timer due within `ms`, in order, awaiting each callback. */
    async advance(ms) {
      const target = current + ms;
      while (true) {
        // Flush first: a tick is async, so the timer it schedules in its
        // `finally` only exists once its promise chain has settled. Checking
        // `pending` before that would see an empty queue and stop immediately.
        await new Promise(resolve => setImmediate(resolve));
        const due = [...pending.entries()].filter(([, entry]) => entry.due <= target).sort((a, b) => a[1].due - b[1].due);
        if (!due.length) break;
        const [id, entry] = due[0];
        pending.delete(id);
        current = entry.due;
        await entry.fn();
      }
      current = target;
    },
    set(at) { current = at; }
  };
}

/**
 * A scripted sampler. `states` is consumed one entry per tick; each entry is
 * either "healthy", "failed", or an object of overrides.
 */
function scriptedSampler(states, clock, { onSample = null } = {}) {
  let index = 0;
  return async ({ seq, slow }) => {
    const entry = states[Math.min(index, states.length - 1)];
    index += 1;
    const spec = typeof entry === "string" ? { kind: entry } : entry;
    const at = new Date(clock.now()).toISOString();
    const reachable = spec.kind !== "failed";

    const sample = {
      seq,
      at,
      tier: slow ? "full" : "fast",
      local: {
        observedAt: at,
        carriedForward: false,
        supported: true,
        activeInterface: spec.iface ?? "Ethernet",
        gateway: "192.168.1.1",
        route: { destination: "0.0.0.0/0", nextHop: spec.nextHop ?? "192.168.1.1", interfaceAlias: spec.iface ?? "Ethernet", metric: 25 },
        resolvers: spec.resolvers ?? ["10.20.0.53"],
        wifi: null,
        vpn: { active: false, adapters: [] },
        interfaces: []
      },
      connectivity: {
        ipv4: { state: reachable ? RESULT.PASS : RESULT.FAIL, ms: 30 },
        ipv6: { state: spec.ipv6 ?? (reachable ? RESULT.PASS : RESULT.FAIL) },
        gateway: { state: RESULT.PASS, lossPct: 0, averageMs: 2 },
        targetDns: { state: RESULT.PASS, v4: 1, v6: 1 },
        targetTcp: reachable ? { state: RESULT.PASS, ms: 30 } : { state: RESULT.FAIL, error: "ETIMEDOUT" },
        contract: null
      },
      path: {
        publicIp: null,
        resolvedAddress: "93.184.216.34",
        fingerprint: `fp-${spec.iface ?? "Ethernet"}-${spec.nextHop ?? "192.168.1.1"}-${(spec.resolvers ?? ["10.20.0.53"]).join(",")}`
      },
      state: reachable ? STATE.HEALTHY : STATE.FAILED,
      reasons: reachable ? [] : ["target TCP unreachable"]
    };

    onSample?.(sample);
    return { sample, carried: null };
  };
}

const target = { host: "api.example.com", port: 443, input: "api.example.com" };

function build(states, options = {}) {
  const clock = fakeClock();
  const events = [];
  const recorder = createRecorder({
    target,
    intervalMs: 3_000,
    windowMs: 60_000,
    afterWindowMs: 12_000,
    cooldownMs: 30_000,
    sampler: scriptedSampler(states, clock),
    now: clock.now,
    clock: clock.api,
    onEvent: event => events.push(event),
    ...options
  });
  return { recorder, clock, events };
}

// --- lifecycle --------------------------------------------------------------

test("the recorder samples on a fixed cadence and retains a window", async () => {
  const { recorder, clock } = build(["healthy"]);
  recorder.start();
  await clock.advance(15_000);

  const status = recorder.status();
  assert.equal(status.state, RECORDER_STATE.RECORDING);
  assert.ok(status.coverage.samples >= 4, `expected several samples, got ${status.coverage.samples}`);
  assert.match(status.retention, /In-memory only/);
  recorder.stop();
});

test("stopping halts sampling", async () => {
  const { recorder, clock } = build(["healthy"]);
  recorder.start();
  await clock.advance(9_000);
  const taken = recorder.status().coverage.samples;

  recorder.stop();
  await clock.advance(30_000);
  assert.equal(recorder.status().coverage.samples, taken, "no samples should be taken after stop");
  assert.equal(recorder.state, RECORDER_STATE.STOPPED);
});

test("a failed sample is a gap, not the end of recording", async () => {
  const clock = fakeClock();
  let calls = 0;
  const recorder = createRecorder({
    target,
    intervalMs: 3_000,
    sampler: async () => {
      calls += 1;
      if (calls === 2) throw new Error("adapter read failed");
      const at = new Date(clock.now()).toISOString();
      return {
        sample: {
          seq: calls, at, local: { activeInterface: "Ethernet", resolvers: [] },
          connectivity: { targetTcp: { state: RESULT.PASS, ms: 10 }, ipv4: {}, ipv6: {}, gateway: { state: "not-sampled" }, targetDns: {}, contract: null },
          path: { fingerprint: "fp" }, state: STATE.HEALTHY, reasons: []
        },
        carried: null
      };
    },
    now: clock.now,
    clock: clock.api
  });

  recorder.start();
  await clock.advance(15_000);
  assert.ok(calls > 3, "sampling should continue after a failure");
  assert.equal(recorder.state, RECORDER_STATE.RECORDING);
  recorder.stop();
});

// --- incident lifecycle -----------------------------------------------------

test("a reachability transition opens an incident with a frozen BEFORE window", async () => {
  const { recorder, clock, events } = build(["healthy", "healthy", "healthy", "failed", "failed"]);
  recorder.start();
  await clock.advance(15_000);

  const opened = events.find(event => event.type === "incident-open");
  assert.ok(opened, "an incident should open");
  assert.equal(opened.trigger.type, TRIGGER.TARGET_REACHABILITY);

  const active = recorder.status().activeIncident;
  assert.ok(active, "the incident should still be collecting");
  recorder.stop();

  const incident = recorder.latestIncident();
  assert.ok(incident.windows.before.samples.length >= 2, "healthy samples must be frozen into BEFORE");
  assert.ok(incident.windows.before.samples.every(sample => sample.state === STATE.HEALTHY));
  assert.ok(incident.windows.during.samples.length >= 1);
});

test("sampling continues while an incident is open", async () => {
  const { recorder, clock } = build(["healthy", "healthy", "failed", "failed", "failed", "failed"]);
  recorder.start();
  await clock.advance(9_000);
  const atTrigger = recorder.status().coverage.samples;

  await clock.advance(9_000);
  assert.ok(recorder.status().coverage.samples > atTrigger, "the recorder must keep sampling during an incident");
  recorder.stop();
});

test("the BEFORE window survives ring eviction during a long incident", async () => {
  // A window shorter than the incident: without freezing, the healthy samples
  // would be evicted before the incident closed.
  const { recorder, clock } = build(
    ["healthy", "healthy", "failed", "failed", "failed", "failed", "failed", "failed"],
    { windowMs: 9_000, afterWindowMs: 15_000 }
  );
  recorder.start();
  await clock.advance(24_000);
  recorder.stop();

  const incident = recorder.latestIncident();
  assert.ok(incident.windows.before.samples.length > 0, "frozen BEFORE samples must not be lost to eviction");
  assert.ok(incident.observedChange.comparable, "a healthy comparison basis should still exist");
});

test("recovery moves samples into AFTER and closes the incident", async () => {
  const { recorder, clock, events } = build(
    ["healthy", "healthy", "failed", "failed", "healthy", "healthy", "healthy", "healthy", "healthy"],
    { afterWindowMs: 6_000 }
  );
  recorder.start();
  await clock.advance(30_000);

  assert.ok(events.some(event => event.type === "incident-recovered"));
  const closed = events.find(event => event.type === "incident-closed");
  assert.ok(closed, "the incident should close after recovery");
  assert.equal(closed.reason, "recovered");

  const incident = recorder.getIncident(closed.id);
  assert.ok(incident.windows.after.samples.length > 0);
  assert.ok(incident.observedChange.recovery, "recovery should be recorded");
  recorder.stop();
});

test("an incident that never recovers still closes when the window elapses", async () => {
  const { recorder, clock, events } = build(
    ["healthy", "healthy", "failed"],
    { afterWindowMs: 9_000 }
  );
  recorder.start();
  await clock.advance(45_000);

  const closed = events.find(event => event.type === "incident-closed");
  assert.ok(closed, "an unrecovered incident must not stay open forever");
  assert.equal(closed.reason, "after_window_elapsed");
  recorder.stop();
});

test("a flapping target produces one incident, not one per tick", async () => {
  const { recorder, clock, events } = build(
    ["healthy", "failed", "healthy", "failed", "healthy", "failed", "healthy", "failed"],
    { afterWindowMs: 3_000, cooldownMs: 60_000 }
  );
  recorder.start();
  await clock.advance(45_000);
  recorder.stop();

  const opened = events.filter(event => event.type === "incident-open");
  assert.equal(opened.length, 1, `cooldown should suppress repeats, got ${opened.length}`);
  assert.ok(events.some(event => event.type === "trigger-suppressed"));
});

test("retained incidents are bounded", async () => {
  const { recorder, clock } = build(
    ["healthy", "failed", "healthy", "failed", "healthy", "failed", "healthy", "failed", "healthy", "failed"],
    { afterWindowMs: 3_000, cooldownMs: 0, maxIncidents: 2 }
  );
  recorder.start();
  await clock.advance(90_000);
  recorder.stop();
  assert.ok(recorder.listIncidents().length <= 2);
});

test("a network-state change alone does not open an incident by default", async () => {
  const { recorder, clock, events } = build([
    "healthy",
    "healthy",
    { kind: "healthy", iface: "Corp VPN", nextHop: "10.8.0.1" },
    { kind: "healthy", iface: "Corp VPN", nextHop: "10.8.0.1" }
  ]);
  recorder.start();
  await clock.advance(15_000);

  assert.ok(events.some(event => event.type === "trigger" && event.trigger.type === TRIGGER.NETWORK_STATE_CHANGE));
  assert.equal(events.some(event => event.type === "incident-open"), false, "a marker is not a fault");
  recorder.stop();
});

test("a network-state change can open an incident when explicitly enabled", async () => {
  const { recorder, clock, events } = build([
    "healthy",
    "healthy",
    { kind: "healthy", iface: "Corp VPN", nextHop: "10.8.0.1" }
  ], { captureOnStateChange: true });
  recorder.start();
  await clock.advance(12_000);
  assert.ok(events.some(event => event.type === "incident-open"));
  recorder.stop();
});

// --- manual capture ---------------------------------------------------------

test("mark opens an incident on the next sample and bypasses cooldown", async () => {
  const { recorder, clock, events } = build(["healthy"], { cooldownMs: 10 * 60_000 });
  recorder.start();
  await clock.advance(6_000);

  recorder.mark("user reported slowness");
  await clock.advance(6_000);

  const opened = events.find(event => event.type === "incident-open");
  assert.ok(opened, "a manual mark should open an incident even while healthy");
  assert.equal(opened.trigger.type, TRIGGER.MANUAL);
  assert.equal(opened.trigger.detail, "user reported slowness");
  recorder.stop();
});

test("mark is refused when the recorder is not running", () => {
  const { recorder } = build(["healthy"]);
  assert.throws(() => recorder.mark(), /not running/);
});

// --- deep capture -----------------------------------------------------------

test("the deep capture runs concurrently and never blocks sampling", async () => {
  let released = null;
  const gate = new Promise(resolve => { released = resolve; });
  const { recorder, clock } = build(["healthy", "healthy", "failed", "failed", "failed", "failed"], {
    deepCapture: async () => {
      await gate;
      return { stages: [{ name: "TCP", state: "fail" }] };
    }
  });

  recorder.start();
  await clock.advance(18_000);

  // The capture is still blocked, yet sampling has continued throughout.
  assert.ok(recorder.status().coverage.samples >= 5, "sampling must not wait for the deep capture");

  released({});
  await new Promise(resolve => setImmediate(resolve));
  recorder.stop();
});

test("a failing deep capture degrades the incident rather than the recorder", async () => {
  const { recorder, clock, events } = build(["healthy", "healthy", "failed", "failed"], {
    afterWindowMs: 6_000,
    deepCapture: async () => { throw new Error("traceroute binary missing"); }
  });

  recorder.start();
  await clock.advance(30_000);
  recorder.stop();

  assert.ok(events.some(event => event.type === "deep-capture-failed"));
  const incident = recorder.latestIncident();
  assert.equal(incident.deepCapture.available, false);
  // The internal error must not surface as the product message.
  assert.ok(!JSON.stringify(incident.deepCapture).includes("traceroute binary missing"));
  assert.equal(recorder.state, RECORDER_STATE.STOPPED);
});

// --- handoff ----------------------------------------------------------------

test("an incident with an interface change offers a testable Bisect axis", async () => {
  const { recorder, clock } = build([
    "healthy",
    "healthy",
    { kind: "failed", iface: "Corp VPN", nextHop: "10.8.0.1" },
    { kind: "failed", iface: "Corp VPN", nextHop: "10.8.0.1" }
  ], { afterWindowMs: 6_000 });

  recorder.start();
  await clock.advance(30_000);
  recorder.stop();

  const incident = recorder.latestIncident();
  const candidates = incident.candidateDiscriminators;
  assert.equal(candidates.available, true);
  assert.ok(candidates.bisectAxes.includes("source-interface"));
  assert.ok(candidates.testable.some(entry => entry.healthyValue === "Ethernet" && entry.failingValue === "Corp VPN"));
  assert.match(candidates.note, /not causes/);
});

test("an incident still open at stop is preserved, not discarded", async () => {
  const { recorder, clock } = build(["healthy", "healthy", "failed", "failed"], { afterWindowMs: 10 * 60_000 });
  recorder.start();
  await clock.advance(15_000);
  assert.ok(recorder.status().activeIncident, "the incident should still be open");

  recorder.stop();
  const incident = recorder.latestIncident();
  assert.ok(incident, "stopping must preserve the open incident");
  assert.equal(incident.closeReason, "recorder_stopped");
});
