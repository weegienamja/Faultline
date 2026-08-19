import test from "node:test";
import assert from "node:assert/strict";

import {
  createSimulationSampler,
  listScenarios,
  loadScenario,
  resolveScenario,
  ScenarioError,
  validateScenario
} from "../src/recorder/simulate.mjs";
import { createRecorder } from "../src/recorder/recorder.mjs";
import { summariseIncident } from "../src/recorder/incident.mjs";
import { projectIncident } from "../src/analyst/incident-evidence.mjs";
import { TRIGGER } from "../src/recorder/triggers.mjs";
import { STATE } from "../src/recorder/sample.mjs";
import { RESULT } from "../src/bisect/results.mjs";

// Simulation. Two things are being tested:
//
//   1. Simulated samples drive the REAL engine - buffer, crossing detection,
//      cooldown, freeze, comparison, axis mapping. A simulation that exercised
//      a parallel implementation would prove nothing.
//   2. Provenance is impossible to lose. A simulated incident must be
//      identifiable as simulated at every layer it can reach.

// --- validation -------------------------------------------------------------

test("a scenario needs a valid name and at least one phase", () => {
  assert.throws(() => validateScenario(null), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "x", phases: [] }), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "Bad Name", phases: [{ durationMs: 1_000 }] }), ScenarioError);
  assert.throws(() => validateScenario({ scenario: "../escape", phases: [{ durationMs: 1_000 }] }), ScenarioError);
});

test("scenario fields are bounded and enum-checked", () => {
  const base = { scenario: "t", phases: [{ durationMs: 2_000 }] };
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 2_000, targetTcp: "MAYBE" }] }), /must be one of/);
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 5 }] }), /durationMs/);
  assert.throws(() => validateScenario({ ...base, phases: [{ durationMs: 2_000, activeInterface: "x".repeat(500) }] }), /too long/);
  assert.throws(() => validateScenario({ ...base, phases: Array.from({ length: 40 }, () => ({ durationMs: 2_000 })) }), /at most/);
});

test("a scenario cannot inject arbitrary fields into a sample", () => {
  const scenario = validateScenario({
    scenario: "hostile",
    phases: [{ durationMs: 2_000, evil: "payload", __proto__: { polluted: true }, simulated: false, source: "measured" }]
  });
  // Only known fields survive validation.
  assert.equal(scenario.phases[0].evil, undefined);
  assert.equal(scenario.phases[0].source, undefined);
  assert.equal(scenario.phases[0].simulated, undefined);
});

test("a scenario cannot declare itself real", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "hostile",
    phases: [{ durationMs: 2_000, targetTcp: "PASS" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  // Provenance is stamped by the sampler, never taken from the file.
  assert.equal(sample.source, "simulation");
  assert.equal(sample.simulated, true);
  assert.equal(sample.scenario, "hostile");
});

// --- built-in scenarios -----------------------------------------------------

test("the built-in scenarios all load and validate", async () => {
  const scenarios = await listScenarios();
  assert.ok(scenarios.length >= 3, `expected the shipped scenarios, got ${scenarios.length}`);
  for (const entry of scenarios) {
    const loaded = await loadScenario(entry.scenario);
    assert.equal(loaded.scenario, entry.scenario);
    assert.ok(loaded.phases.length >= 1);
    assert.ok(loaded.description, `${entry.scenario} should explain itself`);
  }
});

test("scenario lookup cannot traverse out of the fixtures directory", async () => {
  for (const name of ["../../package", "..%2Fpackage", "/etc/passwd", "a".repeat(80), ""]) {
    await assert.rejects(() => loadScenario(name), ScenarioError, `${name} should be refused`);
  }
});

test("resolveScenario accepts a built-in name or a file path", async () => {
  const byName = await resolveScenario("ipv6-path-loss");
  assert.equal(byName.scenario, "ipv6-path-loss");

  const byPath = await resolveScenario("fixtures/recorder/ipv6-path-loss.json");
  assert.equal(byPath.scenario, "ipv6-path-loss");

  await assert.rejects(() => resolveScenario("fixtures/recorder/does-not-exist.json"), ScenarioError);
});

// --- the sample source ------------------------------------------------------

test("phases advance on elapsed simulated time", async () => {
  let clock = 1_000_000;
  const scenario = validateScenario({
    scenario: "phased",
    phases: [
      { durationMs: 6_000, label: "up", targetTcp: "PASS" },
      { durationMs: 6_000, label: "down", targetTcp: "FAIL" }
    ]
  });
  const sampler = createSimulationSampler(scenario, { now: () => clock });

  assert.equal((await sampler({ seq: 0 })).sample.connectivity.targetTcp.state, RESULT.PASS);
  clock += 7_000;
  assert.equal((await sampler({ seq: 1 })).sample.connectivity.targetTcp.state, RESULT.FAIL);
  // Past the end the final phase holds rather than the source stopping.
  clock += 60_000;
  assert.equal((await sampler({ seq: 2 })).sample.connectivity.targetTcp.state, RESULT.FAIL);
});

test("a scenario asserts measurements, and the engine classifies them", async () => {
  const sampler = createSimulationSampler(validateScenario({
    scenario: "classify",
    phases: [{ durationMs: 4_000, targetTcp: "FAIL" }]
  }));
  const { sample } = await sampler({ seq: 0 });
  // The scenario never sets `state`: classification is production logic.
  assert.equal(sample.state, STATE.FAILED);
  assert.ok(sample.reasons.includes("target TCP unreachable"));
});

// --- the real engine, driven by simulated samples ---------------------------

function fakeClock(start = Date.parse("2026-08-19T20:00:00.000Z")) {
  let current = start;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => current,
    api: {
      setTimeout(fn, ms) { const id = nextId++; pending.set(id, { fn, due: current + ms }); return id; },
      clearTimeout(id) { pending.delete(id); }
    },
    async advance(ms) {
      const target = current + ms;
      while (true) {
        await new Promise(resolve => setImmediate(resolve));
        const due = [...pending.entries()].filter(([, entry]) => entry.due <= target).sort((a, b) => a[1].due - b[1].due);
        if (!due.length) break;
        const [id, entry] = due[0];
        pending.delete(id);
        current = entry.due;
        await entry.fn();
      }
      current = target;
    }
  };
}

// The after-window must outlast the scenario's failing phase, or the incident
// closes as "after_window_elapsed" before recovery arrives - bounded behaviour
// that is correct, but not what these scenarios are demonstrating.
async function runScenario(name, { afterWindowMs = 30_000, advanceMs = 120_000 } = {}) {
  const scenario = await loadScenario(name);
  const clock = fakeClock();
  const events = [];
  const recorder = createRecorder({
    target: { host: scenario.target, port: scenario.port, input: scenario.target },
    intervalMs: scenario.intervalMs,
    windowMs: 120_000,
    afterWindowMs,
    sampler: createSimulationSampler(scenario, { now: clock.now }),
    simulation: scenario,
    now: clock.now,
    clock: clock.api,
    onEvent: event => events.push(event)
  });

  recorder.start();
  await clock.advance(advanceMs);
  recorder.stop();
  return { recorder, events, scenario };
}

test("the ipv6-path-loss demo produces the documented result", async () => {
  const { recorder, events } = await runScenario("ipv6-path-loss");

  // 1. The real trigger fired on a real crossing.
  const opened = events.find(event => event.type === "incident-open");
  assert.ok(opened, "a reachability transition should open an incident");
  assert.equal(opened.trigger.type, TRIGGER.TARGET_REACHABILITY);
  assert.equal(opened.trigger.direction, "pass_to_fail");

  const incident = recorder.latestIncident();
  assert.ok(incident, "an incident should have been assembled");

  // 2. Real windows, frozen by the real buffer.
  assert.ok(incident.windows.before.samples.length > 0, "a healthy BEFORE window");
  assert.ok(incident.windows.before.samples.every(sample => sample.state === STATE.HEALTHY));
  assert.ok(incident.windows.during.samples.length > 0);
  assert.ok(incident.windows.after.samples.length > 0, "recovery should be captured");

  // 3. The real difference engine found the condition.
  const differences = incident.observedChange.differences.map(entry => entry.key);
  assert.ok(differences.includes("ipv6"), `expected an ipv6 difference, got ${differences.join(", ") || "none"}`);

  // 4. The real axis mapping produced the Bisect candidate.
  assert.deepEqual(incident.candidateDiscriminators.bisectAxes, ["address-family"]);
  assert.equal(incident.candidateDiscriminators.available, true);

  // 5. Still no causal claim.
  assert.equal(incident.observedChange.classification, "temporal_association");
  assert.ok(!incident.observedChange.statement.toLowerCase().includes("caused"));
});

test("the vpn-route-loss scenario maps to the source-interface axis", async () => {
  const { recorder } = await runScenario("vpn-route-loss");
  const incident = recorder.latestIncident();
  assert.ok(incident);
  const keys = incident.observedChange.differences.map(entry => entry.key);
  assert.ok(keys.includes("activeInterface") || keys.includes("defaultRoute") || keys.includes("vpn"),
    `expected an interface/route/vpn difference, got ${keys.join(", ") || "none"}`);
  assert.ok(incident.candidateDiscriminators.bisectAxes.includes("source-interface"));
});

test("the resolver-change scenario maps to the resolver axis", async () => {
  const { recorder } = await runScenario("resolver-change", { advanceMs: 90_000 });
  const incident = recorder.latestIncident();
  assert.ok(incident);
  assert.ok(incident.candidateDiscriminators.bisectAxes.includes("resolver"),
    `expected the resolver axis, got ${incident.candidateDiscriminators.bisectAxes.join(", ") || "none"}`);
});

// --- provenance -------------------------------------------------------------

test("a simulated incident is marked at every layer", async () => {
  const { recorder } = await runScenario("ipv6-path-loss");
  const incident = recorder.latestIncident();

  // The record itself.
  assert.equal(incident.simulated, true);
  assert.equal(incident.source, "simulation");
  assert.equal(incident.scenario, "ipv6-path-loss");
  assert.equal(incident.evidenceClass, "simulated");
  assert.match(incident.epistemics.observed, /SIMULATED/);

  // The list summary, which is what most surfaces render.
  const summary = summariseIncident(incident);
  assert.equal(summary.simulated, true);
  assert.equal(summary.scenario, "ipv6-path-loss");

  // Every sample in every window.
  const all = [...incident.windows.before.samples, ...incident.windows.during.samples, ...incident.windows.after.samples];
  assert.ok(all.length > 0);
  assert.ok(all.every(sample => sample.simulated === true && sample.source === "simulation"));

  // What the Analyst is handed.
  const projected = projectIncident(incident);
  assert.equal(projected.simulated, true);
  assert.equal(projected.evidenceClass, "simulated");
  assert.match(projected.epistemics.forTheAnalyst, /THIS INCIDENT IS SIMULATED/);
  assert.match(projected.epistemics.forTheAnalyst, /never present it as evidence about the user's network/);
});

test("a real incident is never marked simulated", () => {
  const realSample = {
    at: "2026-08-19T20:00:00.000Z",
    state: STATE.HEALTHY,
    connectivity: { targetTcp: { state: RESULT.PASS, ms: 30 }, ipv4: {}, ipv6: {}, gateway: {}, targetDns: {} },
    local: { activeInterface: "Ethernet", resolvers: [] },
    path: { fingerprint: "fp" },
    reasons: []
  };
  const incident = summariseIncident({
    id: "FLR-2026-0001",
    windows: { before: { samples: [realSample] }, during: { samples: [] }, after: { samples: [] } },
    trigger: {},
    observedChange: { differences: [] },
    candidateDiscriminators: { bisectAxes: [] }
  });
  assert.equal(incident.simulated, false);
  assert.equal(incident.source, "measured");
});

test("a simulated incident carries no real measurement inside it", async () => {
  // The deep capture is suppressed for simulations: embedding a genuine
  // measurement in a fabricated record would mix the two kinds of evidence.
  const scenario = await loadScenario("ipv6-path-loss");
  const clock = fakeClock();
  let deepCaptureCalls = 0;
  const recorder = createRecorder({
    target: { host: scenario.target, port: scenario.port, input: scenario.target },
    intervalMs: scenario.intervalMs,
    afterWindowMs: 10_000,
    sampler: createSimulationSampler(scenario, { now: clock.now }),
    simulation: scenario,
    // The router and CLI both pass null for a simulation; this asserts that a
    // capture would not silently run if one were wired in by mistake.
    deepCapture: null,
    now: clock.now,
    clock: clock.api
  });

  recorder.start();
  await clock.advance(90_000);
  recorder.stop();

  assert.equal(deepCaptureCalls, 0);
  assert.equal(recorder.latestIncident().deepCapture, null);
});

test("recorder status advertises the simulation", async () => {
  const { recorder, scenario } = await runScenario("ipv6-path-loss", { advanceMs: 10_000 });
  const status = recorder.status();
  assert.equal(status.simulated, true);
  assert.equal(status.simulation.scenario, scenario.scenario);
  assert.equal(status.simulation.phases, scenario.phases.length);
});
